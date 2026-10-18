use crate::request::Request;
use crate::{RunOutcome, SetupFailure};

#[cfg(not(windows))]
pub fn run(_request: Request) -> Result<RunOutcome, SetupFailure> {
    Err(SetupFailure::new(
        "setup",
        "Windows Runner Sandbox helper can only confine processes on Windows",
    ))
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::acl::AclRestorer;
    use std::ffi::c_void;
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::ptr::{null, null_mut};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, ERROR_ALREADY_EXISTS, HANDLE,
        HANDLE_FLAGS, HANDLE_FLAG_INHERIT, HLOCAL, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::Security::Authorization::ConvertStringSidToSidW;
    use windows::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
        DeriveAppContainerSidFromAppContainerName,
    };
    use windows::Win32::Security::{
        CreateRestrictedToken, DuplicateTokenEx, FreeSid, GetLengthSid, SecurityImpersonation,
        SetTokenInformation, TokenIntegrityLevel, TokenPrimary, DISABLE_MAX_PRIVILEGE, PSID,
        SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
        WRITE_RESTRICTED,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess, GetExitCodeProcess,
        InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread, TerminateProcess,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
        LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    const STILL_ACTIVE: u32 = 259;
    /// SE_GROUP_INTEGRITY: marks the SID in a TOKEN_MANDATORY_LABEL as the integrity label.
    const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;

    struct Handle(HANDLE);

    impl Handle {
        fn new(handle: HANDLE) -> Result<Self, SetupFailure> {
            if handle.is_invalid() {
                Err(SetupFailure::new(
                    "setup",
                    format!("Win32 returned an invalid handle: {:?}", unsafe {
                        GetLastError()
                    }),
                ))
            } else {
                Ok(Self(handle))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0
        }

        fn into_raw(mut self) -> HANDLE {
            let handle = self.0;
            self.0 = HANDLE(null_mut());
            handle
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            // is_invalid() covers both NULL and INVALID_HANDLE_VALUE.
            if !self.0.is_invalid() {
                unsafe {
                    let _ = CloseHandle(self.0);
                }
            }
        }
    }

    struct AppContainerProfile {
        name: String,
        sid: PSID,
        should_delete: bool,
    }

    impl AppContainerProfile {
        fn create(prefix: &str) -> Result<Self, SetupFailure> {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| SetupFailure::new("setup", format!("clock error: {error}")))?
                .as_nanos();
            let name = format!("{prefix}.{suffix}.{}", std::process::id());
            let name_w = to_wide(&name);
            let display_w = to_wide("Bridle Script Runner");
            let description_w = to_wide("Bridle Runner Sandbox alpha profile");

            // Empty capability list: no internetClient etc., so no network.
            let created = unsafe {
                CreateAppContainerProfile(
                    PCWSTR(name_w.as_ptr()),
                    PCWSTR(display_w.as_ptr()),
                    PCWSTR(description_w.as_ptr()),
                    None,
                )
            };

            match created {
                Ok(sid) => Ok(Self {
                    name,
                    sid,
                    should_delete: true,
                }),
                // Only an existing profile of the same name falls back to deriving
                // its SID; any other creation failure fails closed.
                Err(error)
                    if windows::core::Error::code(&error) == ERROR_ALREADY_EXISTS.to_hresult() =>
                {
                    let sid = unsafe {
                        DeriveAppContainerSidFromAppContainerName(PCWSTR(name_w.as_ptr()))
                    }
                    .map_err(|error| {
                        SetupFailure::new(
                            "setup",
                            format!("could not derive AppContainer SID for {name}: {error}"),
                        )
                    })?;
                    Ok(Self {
                        name,
                        sid,
                        should_delete: false,
                    })
                }
                Err(error) => Err(SetupFailure::new(
                    "setup",
                    format!("could not create AppContainer profile {name}: {error}"),
                )),
            }
        }
    }

    impl Drop for AppContainerProfile {
        fn drop(&mut self) {
            unsafe {
                if self.should_delete {
                    let name_w = to_wide(&self.name);
                    let _ = DeleteAppContainerProfile(PCWSTR(name_w.as_ptr()));
                }
                // Both CreateAppContainerProfile and
                // DeriveAppContainerSidFromAppContainerName document FreeSid.
                if !self.sid.0.is_null() {
                    let _ = FreeSid(self.sid);
                }
            }
        }
    }

    /// STARTUPINFOEX attribute list. Owns every buffer an attribute points at,
    /// because UpdateProcThreadAttribute stores pointers, not copies.
    struct AttributeList {
        // usize elements keep the opaque list pointer-aligned.
        _buffer: Vec<usize>,
        _security: Box<SECURITY_CAPABILITIES>,
        _inherit: Box<[HANDLE]>,
        ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
    }

    impl AttributeList {
        fn new(security: SECURITY_CAPABILITIES, inherit: &[HANDLE]) -> Result<Self, SetupFailure> {
            const ATTRIBUTE_COUNT: u32 = 2;
            let mut size = 0usize;
            unsafe {
                let _ = InitializeProcThreadAttributeList(
                    LPPROC_THREAD_ATTRIBUTE_LIST(null_mut()),
                    ATTRIBUTE_COUNT,
                    0,
                    &mut size,
                );
            }
            if size == 0 {
                return Err(SetupFailure::new(
                    "setup",
                    "could not size STARTUPINFOEX attribute list",
                ));
            }
            let words = size.div_ceil(size_of::<usize>());
            let mut buffer = vec![0usize; words];
            let ptr = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr() as *mut c_void);
            unsafe {
                InitializeProcThreadAttributeList(ptr, ATTRIBUTE_COUNT, 0, &mut size).map_err(
                    |error| {
                        SetupFailure::new(
                            "setup",
                            format!("could not initialise STARTUPINFOEX attribute list: {error}"),
                        )
                    },
                )?;
            }
            // From here Drop calls DeleteProcThreadAttributeList.
            let list = Self {
                _buffer: buffer,
                _security: Box::new(security),
                _inherit: inherit.to_vec().into_boxed_slice(),
                ptr,
            };
            unsafe {
                UpdateProcThreadAttribute(
                    list.ptr,
                    0,
                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                    Some(&*list._security as *const SECURITY_CAPABILITIES as *const c_void),
                    size_of::<SECURITY_CAPABILITIES>(),
                    None,
                    None,
                )
                .map_err(|error| {
                    SetupFailure::new(
                        "setup",
                        format!("could not attach AppContainer security capabilities: {error}"),
                    )
                })?;
                // Restrict inheritance to exactly the child's stdout/stderr pipe
                // ends, so no other inheritable handle of the helper leaks in.
                UpdateProcThreadAttribute(
                    list.ptr,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    Some(list._inherit.as_ptr() as *const c_void),
                    size_of::<HANDLE>() * list._inherit.len(),
                    None,
                    None,
                )
                .map_err(|error| {
                    SetupFailure::new(
                        "setup",
                        format!("could not restrict inherited handles: {error}"),
                    )
                })?;
            }
            Ok(list)
        }
    }

    impl Drop for AttributeList {
        fn drop(&mut self) {
            unsafe {
                DeleteProcThreadAttributeList(self.ptr);
            }
        }
    }

    struct PipePair {
        read: Handle,
        write: Handle,
    }

    fn create_pipe() -> Result<PipePair, SetupFailure> {
        let mut read = HANDLE::default();
        let mut write = HANDLE::default();
        let attrs = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: true.into(),
        };
        unsafe {
            CreatePipe(&mut read, &mut write, Some(&attrs), 0).map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not create stdout/stderr pipe: {error}"),
                )
            })?;
        }
        let pair = PipePair {
            read: Handle::new(read)?,
            write: Handle::new(write)?,
        };
        unsafe {
            SetHandleInformation(pair.read.raw(), HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)).map_err(
                |error| {
                    SetupFailure::new(
                        "setup",
                        format!("could not mark pipe read end private: {error}"),
                    )
                },
            )?;
        }
        Ok(pair)
    }

    fn token_for_app_container() -> Result<Handle, SetupFailure> {
        let mut process_token = HANDLE::default();
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
                &mut process_token,
            )
            .map_err(|error| {
                SetupFailure::new("setup", format!("could not open process token: {error}"))
            })?;
        }
        let process_token = Handle::new(process_token)?;

        let mut primary_token = HANDLE::default();
        unsafe {
            DuplicateTokenEx(
                process_token.raw(),
                TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
                None,
                SecurityImpersonation,
                TokenPrimary,
                &mut primary_token,
            )
            .map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not duplicate primary token: {error}"),
                )
            })?;
        }
        let primary_token = Handle::new(primary_token)?;

        let mut restricted_token = HANDLE::default();
        unsafe {
            CreateRestrictedToken(
                primary_token.raw(),
                DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED,
                None,
                None,
                None,
                &mut restricted_token,
            )
            .map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not create write-restricted token: {error}"),
                )
            })?;
        }
        let restricted_token = Handle::new(restricted_token)?;
        set_low_integrity(restricted_token.raw())?;
        Ok(restricted_token)
    }

    fn set_low_integrity(token: HANDLE) -> Result<(), SetupFailure> {
        let mut low_sid = PSID::default();
        unsafe {
            ConvertStringSidToSidW(w!("S-1-16-4096"), &mut low_sid).map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not create low-integrity SID: {error}"),
                )
            })?;
            let label = TOKEN_MANDATORY_LABEL {
                Label: SID_AND_ATTRIBUTES {
                    Sid: low_sid,
                    Attributes: SE_GROUP_INTEGRITY,
                },
            };
            let result = SetTokenInformation(
                token,
                TokenIntegrityLevel,
                &label as *const _ as *const c_void,
                size_of::<TOKEN_MANDATORY_LABEL>() as u32 + GetLengthSid(low_sid),
            );
            // ConvertStringSidToSidW documents LocalFree, not FreeSid.
            let _ = LocalFree(HLOCAL(low_sid.0));
            result.map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not set token low-integrity label: {error}"),
                )
            })
        }
    }

    fn create_job(request: &Request) -> Result<Handle, SetupFailure> {
        let job = unsafe { CreateJobObjectW(None, None) }.map_err(|error| {
            SetupFailure::new("setup", format!("could not create Job Object: {error}"))
        })?;
        let job = Handle::new(job)?;
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_PROCESS_MEMORY
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.ProcessMemoryLimit = request.app_container.job.memory_mb as usize * 1024 * 1024;
        info.BasicLimitInformation.ActiveProcessLimit = request.app_container.job.max_processes;
        unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|error| {
                SetupFailure::new("setup", format!("could not configure Job Object: {error}"))
            })?;
        }
        Ok(job)
    }

    fn proxy_stream(handle: Handle, stderr: bool) -> thread::JoinHandle<()> {
        // HANDLE is not Send; hand the thread an owning File instead.
        let raw = handle.into_raw();
        let mut file = unsafe { File::from_raw_handle(raw.0 as RawHandle) };
        thread::spawn(move || {
            let mut buffer = [0u8; 16 * 1024];
            loop {
                match file.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        if stderr {
                            let _ = io::stderr().write_all(&buffer[..n]);
                            let _ = io::stderr().flush();
                        } else {
                            let _ = io::stdout().write_all(&buffer[..n]);
                            let _ = io::stdout().flush();
                        }
                    }
                    Err(_) => break,
                }
            }
        })
    }

    fn command_line(command: &[String]) -> Vec<u16> {
        command
            .iter()
            .map(|part| quote_arg(part))
            .collect::<Vec<_>>()
            .join(" ")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    }

    fn quote_arg(value: &str) -> String {
        if value.is_empty() {
            return "\"\"".to_string();
        }
        if !value
            .bytes()
            .any(|b| b == b' ' || b == b'\t' || b == b'"' || b == b'\\')
        {
            return value.to_string();
        }
        let mut out = String::from("\"");
        let mut backslashes = 0;
        for ch in value.chars() {
            if ch == '\\' {
                backslashes += 1;
            } else if ch == '"' {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            } else {
                out.push_str(&"\\".repeat(backslashes));
                backslashes = 0;
                out.push(ch);
            }
        }
        out.push_str(&"\\".repeat(backslashes * 2));
        out.push('"');
        out
    }

    fn env_block(request: &Request) -> Vec<u16> {
        let mut block = Vec::new();
        for (key, value) in &request.env {
            block.extend(format!("{key}={value}").encode_utf16());
            block.push(0);
        }
        if request.env.is_empty() {
            // An empty Unicode block still needs two terminating NULs.
            block.push(0);
        }
        block.push(0);
        block
    }

    fn to_wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn child_exit_code(process: HANDLE) -> u32 {
        let mut code = STILL_ACTIVE;
        unsafe {
            let _ = GetExitCodeProcess(process, &mut code);
        }
        code
    }

    pub fn run(request: Request) -> Result<RunOutcome, SetupFailure> {
        let profile = AppContainerProfile::create(&request.app_container.name_prefix)?;
        let mut acl_restorer = AclRestorer::grant_all(
            profile.sid,
            &request.app_container.grants.readable,
            &request.app_container.grants.writable,
        )?;
        let token = token_for_app_container()?;
        let job = create_job(&request)?;
        let stdout_pipe = create_pipe()?;
        let stderr_pipe = create_pipe()?;
        let security = SECURITY_CAPABILITIES {
            AppContainerSid: profile.sid,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        let attributes = AttributeList::new(
            security,
            &[stdout_pipe.write.raw(), stderr_pipe.write.raw()],
        )?;
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdOutput = stdout_pipe.write.raw();
        startup.StartupInfo.hStdError = stderr_pipe.write.raw();
        startup.StartupInfo.hStdInput = HANDLE(null_mut());
        startup.lpAttributeList = attributes.ptr;

        let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
        let mut command_line = command_line(&request.command);
        let cwd = to_wide(&request.cwd);
        let env = env_block(&request);
        unsafe {
            CreateProcessAsUserW(
                token.raw(),
                PCWSTR(null()),
                PWSTR(command_line.as_mut_ptr()),
                None,
                None,
                true,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                Some(env.as_ptr() as *const c_void),
                PCWSTR(cwd.as_ptr()),
                &startup.StartupInfo,
                &mut process_info,
            )
            .map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not create confined process: {error}"),
                )
            })?;
        }

        let process = Handle::new(process_info.hProcess)?;
        let thread = Handle::new(process_info.hThread)?;
        drop(attributes);
        drop(stdout_pipe.write);
        drop(stderr_pipe.write);

        unsafe {
            if let Err(error) = AssignProcessToJobObject(job.raw(), process.raw()) {
                // The process is not in the job, so terminating the job would not
                // reach it: kill the still-suspended process directly.
                let _ = TerminateProcess(process.raw(), 111);
                return Err(SetupFailure::new(
                    "setup",
                    format!("could not assign confined process to Job Object: {error}"),
                ));
            }
            if ResumeThread(thread.raw()) == u32::MAX {
                let error = GetLastError();
                let _ = TerminateJobObject(job.raw(), 111);
                return Err(SetupFailure::new(
                    "setup",
                    format!("could not resume confined process: {error:?}"),
                ));
            }
        }

        let stdout_proxy = proxy_stream(stdout_pipe.read, false);
        let stderr_proxy = proxy_stream(stderr_pipe.read, true);
        let timeout_ms = request.app_container.job.wallclock_sec.saturating_mul(1000);
        let wait = unsafe { WaitForSingleObject(process.raw(), timeout_ms) };
        let exit_code = match wait {
            WAIT_OBJECT_0 => child_exit_code(process.raw()),
            WAIT_TIMEOUT => {
                unsafe {
                    let _ = TerminateJobObject(job.raw(), 124);
                    let _ = WaitForSingleObject(process.raw(), INFINITE);
                }
                124
            }
            _ => {
                unsafe {
                    let _ = TerminateJobObject(job.raw(), 111);
                }
                return Err(SetupFailure::new(
                    "setup",
                    format!("wait failed for confined process: {:?}", unsafe {
                        GetLastError()
                    }),
                ));
            }
        };

        drop(process);
        drop(thread);
        drop(job);
        acl_restorer.restore();
        let _ = stdout_proxy.join();
        let _ = stderr_proxy.join();
        Ok(RunOutcome { exit_code })
    }
}

#[cfg(windows)]
pub use win::run;
