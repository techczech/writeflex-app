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
    use std::io::{self, Read, Write};
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::ptr::{null, null_mut};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, BOOL, HANDLE, PSID, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::Security::Authorization::{
        CreateAppContainerProfile, DeleteAppContainerProfile,
        DeriveAppContainerSidFromAppContainerName, FreeSid,
    };
    use windows::Win32::Security::{
        ConvertStringSidToSidW, CreateRestrictedToken, DuplicateTokenEx, SetTokenInformation,
        TokenIntegrityLevel, TokenPrimary, CREATE_RESTRICTED_TOKEN_FLAGS, DISABLE_MAX_PRIVILEGE,
        SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SECURITY_IMPERSONATION_LEVEL,
        SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_TYPE, WRITE_RESTRICTED,
    };
    use windows::Win32::System::Environment::CREATE_UNICODE_ENVIRONMENT;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows::Win32::System::Threading::{
        CreatePipe, CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess,
        GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_SUSPENDED,
        EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_CREATION_FLAGS,
        PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, STARTF_USESTDHANDLES,
        STARTUPINFOEXW,
    };
    use windows::Win32::System::WindowsProgramming::INFINITE;
    use windows::Win32::System::IO::SetHandleInformation;

    const STILL_ACTIVE: u32 = 259;
    const HANDLE_FLAG_INHERIT: u32 = 0x00000001;

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
            self.0 = HANDLE(0);
            handle
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_invalid() && self.0 != HANDLE(0) {
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
            let mut sid = PSID::default();

            let create_result = unsafe {
                CreateAppContainerProfile(
                    PCWSTR(name_w.as_ptr()),
                    PCWSTR(display_w.as_ptr()),
                    PCWSTR(description_w.as_ptr()),
                    None,
                    0,
                    &mut sid,
                )
            };

            if create_result.is_err() {
                unsafe {
                    DeriveAppContainerSidFromAppContainerName(PCWSTR(name_w.as_ptr()), &mut sid)
                }
                .map_err(|error| {
                    SetupFailure::new(
                        "setup",
                        format!("could not create or derive AppContainer profile {name}: {error}"),
                    )
                })?;
                return Ok(Self {
                    name,
                    sid,
                    should_delete: false,
                });
            }

            Ok(Self {
                name,
                sid,
                should_delete: true,
            })
        }
    }

    impl Drop for AppContainerProfile {
        fn drop(&mut self) {
            unsafe {
                if self.should_delete {
                    let name_w = to_wide(&self.name);
                    let _ = DeleteAppContainerProfile(PCWSTR(name_w.as_ptr()));
                }
                if !self.sid.is_invalid() {
                    FreeSid(self.sid);
                }
            }
        }
    }

    struct AttributeList {
        _bytes: Vec<u8>,
        ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
    }

    impl AttributeList {
        fn new(security: &mut SECURITY_CAPABILITIES) -> Result<Self, SetupFailure> {
            let mut size = 0usize;
            unsafe {
                let _ = InitializeProcThreadAttributeList(None, 1, 0, &mut size);
            }
            if size == 0 {
                return Err(SetupFailure::new(
                    "setup",
                    "could not size STARTUPINFOEX attribute list",
                ));
            }
            let mut bytes = vec![0u8; size];
            let ptr = bytes.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            unsafe {
                InitializeProcThreadAttributeList(Some(ptr), 1, 0, &mut size).map_err(|error| {
                    SetupFailure::new(
                        "setup",
                        format!("could not initialise STARTUPINFOEX attribute list: {error}"),
                    )
                })?;
                UpdateProcThreadAttribute(
                    ptr,
                    0,
                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                    Some(security as *mut _ as *const c_void),
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
            }
            Ok(Self { _bytes: bytes, ptr })
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
        let mut attrs = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: null_mut(),
            bInheritHandle: BOOL(1),
        };
        unsafe {
            CreatePipe(&mut read, &mut write, Some(&mut attrs), 0).map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not create stdout/stderr pipe: {error}"),
                )
            })?;
            SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0).map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not mark pipe read end private: {error}"),
                )
            })?;
        }
        Ok(PipePair {
            read: Handle::new(read)?,
            write: Handle::new(write)?,
        })
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
                SECURITY_IMPERSONATION_LEVEL(2),
                TOKEN_TYPE(TokenPrimary.0),
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
                CREATE_RESTRICTED_TOKEN_FLAGS(DISABLE_MAX_PRIVILEGE.0 | WRITE_RESTRICTED.0),
                None,
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
            let mut label = TOKEN_MANDATORY_LABEL {
                Label: SID_AND_ATTRIBUTES {
                    Sid: low_sid,
                    Attributes: 0x00000020,
                },
            };
            let result = SetTokenInformation(
                token,
                TokenIntegrityLevel,
                Some(&mut label as *mut _ as *const c_void),
                (size_of::<TOKEN_MANDATORY_LABEL>() + 68) as u32,
            );
            FreeSid(low_sid);
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
        thread::spawn(move || {
            let raw = handle.into_raw();
            let mut file = unsafe { std::fs::File::from_raw_handle(raw.0 as RawHandle) };
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
        let mut security = SECURITY_CAPABILITIES {
            AppContainerSid: profile.sid,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        let attributes = AttributeList::new(&mut security)?;
        let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdOutput = stdout_pipe.write.raw();
        startup.StartupInfo.hStdError = stderr_pipe.write.raw();
        startup.StartupInfo.hStdInput = HANDLE(0);
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
                PROCESS_CREATION_FLAGS(
                    EXTENDED_STARTUPINFO_PRESENT.0
                        | CREATE_SUSPENDED.0
                        | CREATE_UNICODE_ENVIRONMENT.0,
                ),
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
        drop(stdout_pipe.write);
        drop(stderr_pipe.write);

        unsafe {
            AssignProcessToJobObject(job.raw(), process.raw()).map_err(|error| {
                let _ = TerminateJobObject(job.raw(), 111);
                SetupFailure::new(
                    "setup",
                    format!("could not assign confined process to Job Object: {error}"),
                )
            })?;
            ResumeThread(thread.raw());
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
