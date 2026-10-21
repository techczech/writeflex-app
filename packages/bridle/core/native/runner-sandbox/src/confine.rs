use crate::request::Request;
use crate::{RunOutcome, SetupFailure};
#[cfg(windows)]
use crate::{cancel_reason, CancelReason, CANCELLED_EXIT_CODE};

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
    use crate::acl::{AclGrants, ScratchRoot};
    use std::ffi::c_void;
    use std::fs::File;
    use std::io::{self, BufRead, Read, Write};
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use std::path::{Component, Path, PathBuf};
    use std::ptr::{null, null_mut};
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, ERROR_ALREADY_EXISTS, HANDLE,
        HANDLE_FLAGS, HANDLE_FLAG_INHERIT, HLOCAL, WAIT_EVENT, WAIT_OBJECT_0, WAIT_TIMEOUT,
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
    };
    use windows::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY,
    };
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CreateEventW, CreateProcessAsUserW, DeleteProcThreadAttributeList, GetCurrentProcess,
        GetExitCodeProcess, InitializeProcThreadAttributeList, OpenProcessToken, ResumeThread,
        SetEvent, UpdateProcThreadAttribute, WaitForMultipleObjects, WaitForSingleObject,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
        LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        PROC_THREAD_ATTRIBUTE_JOB_LIST, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        STARTF_USESTDHANDLES, STARTUPINFOEXW,
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

        /// Deletes the profile this run created. Fallible, so it is called
        /// explicitly on every path of `run` and reported there, never from
        /// `Drop`. A profile this run did not create (derived from an existing
        /// one) is left alone. The SID stays valid until `Drop` frees it.
        fn delete(&mut self) -> Result<(), SetupFailure> {
            if !self.should_delete {
                return Ok(());
            }
            self.should_delete = false;
            let name = &self.name;
            let name_w = to_wide(name);
            unsafe { DeleteAppContainerProfile(PCWSTR(name_w.as_ptr())) }.map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not delete AppContainer profile {name}: {error}"),
                )
            })
        }
    }

    impl Drop for AppContainerProfile {
        fn drop(&mut self) {
            // Infallible only: profile deletion is `delete()`, called from `run`.
            unsafe {
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
        _jobs: Box<[HANDLE]>,
        ptr: LPPROC_THREAD_ATTRIBUTE_LIST,
    }

    impl AttributeList {
        fn new(
            security: SECURITY_CAPABILITIES,
            inherit: &[HANDLE],
            job: HANDLE,
        ) -> Result<Self, SetupFailure> {
            const ATTRIBUTE_COUNT: u32 = 3;
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
                _jobs: vec![job].into_boxed_slice(),
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
                // Create the child inside the Job atomically: there is no window
                // in which it exists outside the job's limits and kill-on-close.
                UpdateProcThreadAttribute(
                    list.ptr,
                    0,
                    PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                    Some(list._jobs.as_ptr() as *const c_void),
                    size_of::<HANDLE>() * list._jobs.len(),
                    None,
                    None,
                )
                .map_err(|error| {
                    SetupFailure::new(
                        "setup",
                        format!("could not attach the Job Object to the process: {error}"),
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
                // WRITE_RESTRICTED without restricting SIDs adds nothing; the
                // AppContainer package-SID check is the write boundary.
                DISABLE_MAX_PRIVILEGE,
                None,
                None,
                None,
                &mut restricted_token,
            )
            .map_err(|error| {
                SetupFailure::new(
                    "setup",
                    format!("could not create privilege-stripped token: {error}"),
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
        // Checked: a huge memory_mb must fail setup, not overflow (a panic in
        // debug builds, a wrapped limit in release).
        info.ProcessMemoryLimit = request
            .app_container
            .job
            .memory_mb
            .checked_mul(1024 * 1024)
            .and_then(|bytes| usize::try_from(bytes).ok())
            .ok_or_else(|| {
                SetupFailure::new("setup", "memory_mb is too large for a Job Object limit")
            })?;
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

    /// `Builder::spawn`, never `thread::spawn`: a failed thread start must be
    /// an error the caller can clean up after, not a panic that unwinds past
    /// revoke and profile delete. On error the read end is closed.
    fn proxy_stream(handle: Handle, stderr: bool) -> io::Result<thread::JoinHandle<()>> {
        // HANDLE is not Send; hand the thread an owning File instead.
        let raw = handle.into_raw();
        let mut file = unsafe { File::from_raw_handle(raw.0 as RawHandle) };
        let name = if stderr { "bridle-stderr" } else { "bridle-stdout" };
        thread::Builder::new().name(name.into()).spawn(move || {
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

    fn child_exit_code(process: HANDLE) -> Result<u32, SetupFailure> {
        let mut code = STILL_ACTIVE;
        unsafe { GetExitCodeProcess(process, &mut code) }.map_err(|error| {
            SetupFailure::new("setup", format!("could not read the child exit status: {error}"))
        })?;
        Ok(code)
    }

    /// Manual-reset event shared with the stdin-cancel thread, plus the reason
    /// the thread read. Closed only when the last owner drops, so the thread
    /// can never signal a recycled handle.
    struct CancelSignal {
        event: HANDLE,
        /// 0 = not set, 1 = cancel, 2 = timeout.
        reason: AtomicU8,
    }

    // SAFETY: an event handle may be signalled from any thread.
    unsafe impl Send for CancelSignal {}
    unsafe impl Sync for CancelSignal {}

    impl CancelSignal {
        fn new() -> Result<Self, SetupFailure> {
            let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(|error| {
                SetupFailure::new("setup", format!("could not create cancel event: {error}"))
            })?;
            Ok(Self {
                event,
                reason: AtomicU8::new(0),
            })
        }

        fn pending(&self) -> bool {
            unsafe { WaitForSingleObject(self.event, 0) == WAIT_OBJECT_0 }
        }

        fn reason(&self) -> CancelReason {
            match self.reason.load(Ordering::SeqCst) {
                2 => CancelReason::Timeout,
                _ => CancelReason::Cancel,
            }
        }
    }

    impl Drop for CancelSignal {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.event);
            }
        }
    }

    /// The host cancels by writing one line to the helper's stdin (`timeout`
    /// or `cancel`); EOF or a read error means the host is gone. Any of them
    /// cancels the run.
    fn spawn_cancel_listener(signal: Arc<CancelSignal>) -> Result<(), SetupFailure> {
        thread::Builder::new()
            .name("bridle-cancel".into())
            .spawn(move || {
                let mut line = String::new();
                let read = match io::stdin().lock().read_line(&mut line) {
                    Ok(0) | Err(_) => None,
                    Ok(_) => Some(line.as_str()),
                };
                let code = match cancel_reason(read) {
                    CancelReason::Timeout => 2,
                    CancelReason::Cancel => 1,
                };
                signal.reason.store(code, Ordering::SeqCst);
                if let Err(error) = unsafe { SetEvent(signal.event) } {
                    crate::stderr_line(&format!("BRIDLE_SANDBOX_WARN setup: could not signal cancel: {error}"));
                }
            })
            .map(|_| ())
            .map_err(|error| {
                SetupFailure::new("setup", format!("could not start cancel listener: {error}"))
            })
    }

    /// Canonical extended (`\\?\`) form of an existing path, for the
    /// containment check of writable grants only (no security change is made
    /// through a writable path).
    fn canonical_string(path: &Path) -> Result<String, SetupFailure> {
        let canonical = std::fs::canonicalize(path).map_err(|error| {
            SetupFailure::new(
                "filesystem",
                format!("could not resolve {}: {error}", path.display()),
            )
        })?;
        canonical.to_str().map(str::to_string).ok_or_else(|| {
            SetupFailure::new(
                "filesystem",
                format!("resolved path is not valid Unicode: {}", canonical.display()),
            )
        })
    }

    /// Canonicalise the longest existing ancestor and re-append the missing
    /// tail (a writable such as `<scratch>\bun-install-cache` may not exist
    /// yet). Any `.`/`..` component or an unresolvable root fails closed.
    fn canonical_allowing_missing_tail(path: &str) -> Result<String, SetupFailure> {
        let original = Path::new(path);
        if original
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        {
            return Err(SetupFailure::new(
                "filesystem",
                format!("writable grant has a relative component: {path}"),
            ));
        }
        let mut cursor: &Path = original;
        let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
        loop {
            match std::fs::metadata(cursor) {
                Ok(_) => break,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    let (Some(name), Some(parent)) = (cursor.file_name(), cursor.parent()) else {
                        return Err(SetupFailure::new(
                            "filesystem",
                            format!("could not resolve {path}: no existing ancestor"),
                        ));
                    };
                    tail.push(name);
                    cursor = parent;
                }
                Err(error) => {
                    return Err(SetupFailure::new(
                        "filesystem",
                        format!("could not resolve {}: {error}", cursor.display()),
                    ))
                }
            }
        }
        let mut resolved = PathBuf::from(canonical_string(cursor)?);
        for name in tail.iter().rev() {
            resolved.push(name);
        }
        resolved.to_str().map(str::to_string).ok_or_else(|| {
            SetupFailure::new("filesystem", format!("path is not valid Unicode: {path}"))
        })
    }

    /// Open the scratch root by handle first, then check write containment
    /// against that handle's own final path: every writable must lie inside
    /// it after links and junctions are resolved. The returned handle is the
    /// scratch's identity through labelling; it is never looked up by name
    /// again.
    fn confirm_scratch(request: &Request) -> Result<Option<ScratchRoot>, SetupFailure> {
        let Some(requested) = request.app_container.scratch_root.as_deref() else {
            return Ok(None);
        };
        let scratch = ScratchRoot::open(requested)?;
        let writable = request
            .app_container
            .grants
            .writable
            .iter()
            .map(|path| canonical_allowing_missing_tail(path))
            .collect::<Result<Vec<_>, _>>()?;
        crate::writable_within_scratch(scratch.path(), &writable).map_err(|path| {
            SetupFailure::new("filesystem", format!("writable grant outside scratch: {path}"))
        })?;
        Ok(Some(scratch))
    }

    /// Kill every process in the job and wait for the direct child. If
    /// TerminateJobObject fails, closing the (only) job handle still kills the
    /// job through KILL_ON_JOB_CLOSE. Returns a note for anything that failed.
    fn kill_job_and_wait(job: Handle, process: &Handle, code: u32) -> Option<String> {
        let mut notes = Vec::new();
        if let Err(error) = unsafe { TerminateJobObject(job.raw(), code) } {
            notes.push(format!(
                "TerminateJobObject failed ({error}); closed the job to kill it"
            ));
        }
        drop(job);
        if unsafe { WaitForSingleObject(process.raw(), INFINITE) } != WAIT_OBJECT_0 {
            notes.push(format!("wait for the killed process failed: {:?}", unsafe {
                GetLastError()
            }));
        }
        (!notes.is_empty()).then(|| notes.join("; "))
    }

    fn with_note(detail: String, note: Option<String>) -> String {
        match note {
            Some(note) => format!("{detail}; {note}"),
            None => detail,
        }
    }

    fn cancelled(reason: CancelReason) -> RunOutcome {
        RunOutcome {
            exit_code: CANCELLED_EXIT_CODE,
            cancelled: Some(reason),
        }
    }

    /// Label scratch, build the token and job, run the child to completion
    /// (or cancellation) and return its outcome. Every path that returns
    /// after the child exists has killed the job and waited for the child.
    fn launch(
        request: &Request,
        profile: &AppContainerProfile,
        scratch_root: Option<ScratchRoot>,
    ) -> Result<RunOutcome, SetupFailure> {
        let cancel = Arc::new(CancelSignal::new()?);
        spawn_cancel_listener(Arc::clone(&cancel))?;
        if let Some(scratch) = scratch_root {
            AclGrants::label_scratch(profile.sid, scratch)?;
        }
        let token = token_for_app_container()?;
        let job = create_job(request)?;
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
            job.raw(),
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
        let env = env_block(request);

        // Cancelled during setup: no child is ever created.
        if cancel.pending() {
            return Ok(cancelled(cancel.reason()));
        }
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

        // The child exists, suspended and already inside the job
        // (PROC_THREAD_ATTRIBUTE_JOB_LIST). CreateProcessAsUserW succeeded, so
        // both handles are valid.
        let process = Handle(process_info.hProcess);
        let thread = Handle(process_info.hThread);
        drop(attributes);
        drop(stdout_pipe.write);
        drop(stderr_pipe.write);
        let (stdout_proxy, stderr_proxy) = match (
            proxy_stream(stdout_pipe.read, false),
            proxy_stream(stderr_pipe.read, true),
        ) {
            (Ok(stdout_proxy), Ok(stderr_proxy)) => (stdout_proxy, stderr_proxy),
            (stdout_proxy, stderr_proxy) => {
                // The child is still suspended: kill it, close our handles,
                // join whichever proxy did start, then fail through the
                // normal revoke + delete path.
                let note = kill_job_and_wait(job, &process, 111);
                drop(thread);
                drop(process);
                let mut errors = Vec::new();
                for proxy in [stdout_proxy, stderr_proxy] {
                    match proxy {
                        Ok(handle) => {
                            let _ = handle.join();
                        }
                        Err(error) => errors.push(error.to_string()),
                    }
                }
                return Err(SetupFailure::new(
                    "setup",
                    with_note(
                        format!("could not start output proxy: {}", errors.join("; ")),
                        note,
                    ),
                ));
            }
        };
        let finish = |process: Handle, thread: Handle| {
            drop(thread);
            drop(process);
            let _ = stdout_proxy.join();
            let _ = stderr_proxy.join();
        };

        // Cancelled while the child was being created: it never runs.
        if cancel.pending() {
            if let Some(note) = kill_job_and_wait(job, &process, CANCELLED_EXIT_CODE) {
                crate::stderr_line(&format!("BRIDLE_SANDBOX_WARN setup: {note}"));
            }
            finish(process, thread);
            return Ok(cancelled(cancel.reason()));
        }
        if unsafe { ResumeThread(thread.raw()) } == u32::MAX {
            let error = unsafe { GetLastError() };
            let note = kill_job_and_wait(job, &process, 111);
            finish(process, thread);
            return Err(SetupFailure::new(
                "setup",
                with_note(format!("could not resume confined process: {error:?}"), note),
            ));
        }

        let timeout_ms = request.app_container.job.wallclock_sec.saturating_mul(1000);
        let handles = [process.raw(), cancel.event];
        let wait = unsafe { WaitForMultipleObjects(&handles, false, timeout_ms) };
        let outcome = if wait == WAIT_OBJECT_0 {
            drop(job);
            match child_exit_code(process.raw()) {
                Ok(exit_code) => RunOutcome {
                    exit_code,
                    cancelled: None,
                },
                Err(failure) => {
                    finish(process, thread);
                    return Err(failure);
                }
            }
        } else if wait == WAIT_EVENT(WAIT_OBJECT_0.0 + 1) || wait == WAIT_TIMEOUT {
            let reason = if wait == WAIT_TIMEOUT {
                CancelReason::Timeout
            } else {
                cancel.reason()
            };
            if let Some(note) = kill_job_and_wait(job, &process, CANCELLED_EXIT_CODE) {
                crate::stderr_line(&format!("BRIDLE_SANDBOX_WARN setup: {note}"));
            }
            cancelled(reason)
        } else {
            let error = unsafe { GetLastError() };
            let note = kill_job_and_wait(job, &process, 111);
            finish(process, thread);
            return Err(SetupFailure::new(
                "setup",
                with_note(format!("wait failed for confined process: {error:?}"), note),
            ));
        };
        finish(process, thread);
        Ok(outcome)
    }

    pub fn run(request: Request) -> Result<RunOutcome, SetupFailure> {
        // Open scratch and re-check write containment against it before any
        // side effect. Every security change after this goes through a handle
        // opened once (scratch here, each read root inside grant_reads).
        let scratch_root = confirm_scratch(&request)?;
        // Declared first so it drops last: the grants below copy its SID,
        // which stays allocated until the profile drops (after delete()).
        let mut profile = AppContainerProfile::create(&request.app_container.name_prefix)?;
        let inner = run_in_profile(&request, &profile, scratch_root);
        // Every path after the profile exists ends here: grant failure,
        // launch failure, success. Runs after grants.revoke() (inside
        // run_in_profile), never before.
        let deleted = profile.delete();
        match (inner, deleted) {
            (Ok(outcome), Ok(())) => Ok(outcome),
            (Ok(outcome), Err(failure)) => {
                crate::stderr_line(&format!("BRIDLE_SANDBOX_WARN setup: {}", failure.detail));
                Ok(outcome)
            }
            (Err(failure), Ok(())) => Err(failure),
            (Err(mut failure), Err(delete)) => {
                failure.detail = format!("{}; {}", failure.detail, delete.detail);
                Err(failure)
            }
        }
    }

    /// Grant, launch, revoke, inside an existing profile. Returns once every
    /// grant made here has been revoked (or the revoke failure merged in).
    fn run_in_profile(
        request: &Request,
        profile: &AppContainerProfile,
        scratch_root: Option<ScratchRoot>,
    ) -> Result<RunOutcome, SetupFailure> {
        let mut grants =
            AclGrants::grant_reads(profile.sid, &request.app_container.grants.readable)?;
        let launched = launch(request, profile, scratch_root);
        let revoked = grants.revoke();
        match (launched, revoked) {
            (Ok(outcome), Ok(())) => Ok(outcome),
            (Ok(outcome), Err(failure)) => {
                crate::stderr_line(&format!("BRIDLE_SANDBOX_WARN filesystem: {}", failure.detail));
                Ok(outcome)
            }
            (Err(failure), Ok(())) => Err(failure),
            (Err(mut failure), Err(revoke)) => {
                failure.detail = format!("{}; {}", failure.detail, revoke.detail);
                Err(failure)
            }
        }
    }
}

#[cfg(windows)]
pub use win::run;
