#[cfg(windows)]
mod acl;
mod confine;
mod request;

use request::Request;
use std::io::Write;
use std::{env, fmt, fs, path::PathBuf};

/// Writes one diagnostic line to stderr and ignores any write error.
/// `eprintln!` panics when stderr is broken (host gone), and a panic would
/// unwind past mandatory cleanup (ACE revoke, profile delete). Every helper
/// diagnostic goes through here; none may use `eprintln!`/`println!`.
pub(crate) fn stderr_line(line: &str) {
    let mut err = std::io::stderr().lock();
    let _ = err.write_all(line.as_bytes());
    let _ = err.write_all(b"\n");
}

#[derive(Debug)]
pub struct SetupFailure {
    pub resource: &'static str,
    pub detail: String,
}

impl SetupFailure {
    pub fn new(resource: &'static str, detail: impl Into<String>) -> Self {
        Self {
            resource,
            detail: detail.into(),
        }
    }
}

/// Why the helper stopped a run itself. Written to the host-supplied result
/// file (`--result`), never to the proxied output streams, so neither child
/// output nor the output cap can forge or hide it, and a child that exits 124
/// on its own is never mistaken for a cancelled run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    /// The helper's own wall clock, or the host's `timeout` line.
    Timeout,
    /// Any other stdin line, EOF or a stdin read error (host gone).
    Cancel,
}

impl fmt::Display for CancelReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Timeout => "timeout",
            Self::Cancel => "cancel",
        })
    }
}

/// Map what the stdin listener read to a cancel reason. `None` is EOF or a
/// read error. Only an exact `timeout` line means timeout; everything else is
/// a cancel.
pub fn cancel_reason(line: Option<&str>) -> CancelReason {
    match line.map(str::trim) {
        Some("timeout") => CancelReason::Timeout,
        _ => CancelReason::Cancel,
    }
}

/// Exit code the helper itself uses for a run it stopped.
pub const CANCELLED_EXIT_CODE: u32 = 124;

pub struct RunOutcome {
    /// The child's full Windows exit status (a `UINT`), or 124 when cancelled.
    pub exit_code: u32,
    pub cancelled: Option<CancelReason>,
}

/// Status passed to `std::process::exit`: the same 32 bits as the child's
/// `UINT` exit status, so no non-zero status can be truncated to zero
/// (Windows `ExitProcess` takes the value back as unsigned).
pub fn process_exit_status(exit_code: u32) -> i32 {
    exit_code as i32
}

struct Cli {
    request: PathBuf,
    result: PathBuf,
}

fn parse_cli(args: &[std::ffi::OsString]) -> Result<Cli, SetupFailure> {
    match args {
        [request_flag, request, result_flag, result]
            if request_flag == "--request" && result_flag == "--result" =>
        {
            Ok(Cli {
                request: PathBuf::from(request),
                result: PathBuf::from(result),
            })
        }
        _ => Err(SetupFailure::new(
            "setup",
            "usage: bridle-runner-sandbox.exe --request <path> --result <path>",
        )),
    }
}

/// Record why the helper stopped the run: exactly `timeout` or `cancel`. The
/// host reserves the file empty and exclusively (in its own private temporary
/// directory) before launch; the helper replaces its content. The file must
/// already exist: a missing file is an error, never a fresh create.
pub fn write_cancel_reason(path: &std::path::Path, reason: CancelReason) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .create(false)
        .open(path)?;
    file.write_all(reason.to_string().as_bytes())?;
    file.sync_all()
}

fn load_request(path: &std::path::Path) -> Result<Request, SetupFailure> {
    let bytes = fs::read(path).map_err(|error| {
        SetupFailure::new(
            "setup",
            format!("could not read request {}: {error}", path.display()),
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|error| {
        SetupFailure::new(
            "setup",
            format!("could not parse request {}: {error}", path.display()),
        )
    })
}

fn validate_request(request: &Request) -> Result<(), SetupFailure> {
    if request.command.is_empty() {
        return Err(SetupFailure::new(
            "setup",
            "request.command must not be empty",
        ));
    }
    // Win32 strings are NUL-terminated: an embedded NUL would silently truncate a
    // path (widening an ACL grant to a parent) or splice extra variables into the
    // environment block. Reject rather than truncate.
    let has_nul = |value: &str| value.contains('\0');
    let grants = &request.app_container.grants;
    if request.command.iter().any(|part| has_nul(part))
        || has_nul(&request.cwd)
        || grants.readable.iter().any(|path| has_nul(path))
        || grants.writable.iter().any(|path| has_nul(path))
        || request
            .app_container
            .scratch_root
            .as_deref()
            .is_some_and(has_nul)
    {
        return Err(SetupFailure::new(
            "setup",
            "request command, cwd, grant paths and scratchRoot must not contain NUL",
        ));
    }
    // Win32 path normalisation silently drops trailing dots and spaces, and a
    // ':' after the drive names an alternate data stream: either can make a
    // name mean something else to a non-extended API call. Refuse them.
    for path in grants
        .readable
        .iter()
        .chain(grants.writable.iter())
        .chain(request.app_container.scratch_root.iter())
    {
        if let Some(component) = ambiguous_component(path) {
            return Err(SetupFailure::new(
                "filesystem",
                format!("path component {component:?} is ambiguous on Windows: {path}"),
            ));
        }
    }
    // Windows alpha only grants writes inside the host-created per-run scratch:
    // a Low-integrity child can never write a medium-labelled workspace tree,
    // and relabelling user data Low is not acceptable.
    if !grants.writable.is_empty() {
        let Some(scratch) = request.app_container.scratch_root.as_deref() else {
            return Err(SetupFailure::new(
                "filesystem",
                "Windows alpha only grants writes inside the host-created scratch; no scratchRoot was supplied",
            ));
        };
        writable_within_scratch(scratch, &grants.writable).map_err(|path| {
            SetupFailure::new("filesystem", format!("writable grant outside scratch: {path}"))
        })?;
    }
    if request
        .env
        .iter()
        .any(|(key, value)| key.is_empty() || key.contains('=') || has_nul(key) || has_nul(value))
    {
        return Err(SetupFailure::new(
            "setup",
            "request.env keys must be non-empty without '=' and no entry may contain NUL",
        ));
    }
    if request.policy.network != "none" || request.app_container.network != "none" {
        return Err(SetupFailure::new(
            "network",
            "Runner Sandbox alpha only accepts network:none",
        ));
    }
    if !request.app_container.capabilities.is_empty() {
        return Err(SetupFailure::new(
            "network",
            "Runner Sandbox alpha requires an empty AppContainer capability list",
        ));
    }
    if request.app_container.integrity != "low" {
        return Err(SetupFailure::new(
            "setup",
            "Runner Sandbox alpha requires integrity:low",
        ));
    }
    if request.app_container.restricted_token != "write-restricted" {
        return Err(SetupFailure::new(
            "setup",
            "Runner Sandbox alpha requires restrictedToken:write-restricted",
        ));
    }
    Ok(())
}

/// Path components of an absolute Windows-or-POSIX path, for lexical
/// containment: `\\?\` stripped, `/` and `\` unified, lower-cased, empty
/// components dropped. The first component records the root form (drive,
/// UNC or `/`) so `\\server\x` never equals `\x`. `None` (fail closed) for a
/// relative path or any `.` / `..` component.
fn path_components(path: &str) -> Option<Vec<String>> {
    let lower = strip_verbatim(&path.replace('\\', "/")).to_lowercase();
    let bytes = lower.as_bytes();
    let (root, rest) = if let Some(rest) = lower.strip_prefix("//") {
        ("//".to_string(), rest)
    } else if let Some(rest) = lower.strip_prefix('/') {
        ("/".to_string(), rest)
    } else if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        if bytes.len() > 2 && bytes[2] != b'/' {
            // "C:foo" is drive-relative.
            return None;
        }
        (lower[..2].to_string(), &lower[2..])
    } else {
        return None;
    };
    let mut components = vec![root];
    for part in rest.split('/') {
        match part {
            "" => continue,
            "." | ".." => return None,
            other => components.push(other.to_string()),
        }
    }
    Some(components)
}

/// Remove an extended-length prefix from a `/`-separated path:
/// `//?/C:/x` becomes `C:/x` and `//?/UNC/server/share` becomes
/// `//server/share`. Used only on comparison copies, never for API calls.
fn strip_verbatim(unified: &str) -> String {
    // `get` rather than indexing: byte 4 may fall inside a multi-byte
    // character (`//?/C:/Č...`), where slicing would panic.
    match unified.strip_prefix("//?/") {
        Some(rest) if rest.get(..4).is_some_and(|head| head.eq_ignore_ascii_case("unc/")) => {
            format!("//{}", &rest[4..])
        }
        Some(rest) => rest.to_string(),
        None => unified.to_string(),
    }
}

/// The first path component that a Win32 call could reinterpret: one that
/// ends in '.' or ' ' (normalisation strips them; this also covers `.` and
/// `..`) or contains ':' (an alternate data stream) other than the drive.
pub fn ambiguous_component(path: &str) -> Option<String> {
    let unified = strip_verbatim(&path.replace('\\', "/"));
    let bytes = unified.as_bytes();
    let rest = if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        &unified[2..]
    } else {
        &unified[..]
    };
    rest.split('/')
        .filter(|part| !part.is_empty())
        .find(|part| part.contains(':') || part.ends_with('.') || part.ends_with(' '))
        .map(str::to_string)
}

/// Every writable grant must equal or lie inside `scratch` by whole path
/// components (case-insensitive, separator-normalised). Returns the first
/// escaping (or unparseable) writable as the error.
pub fn writable_within_scratch(scratch: &str, writable: &[String]) -> Result<(), String> {
    let Some(root) = path_components(scratch) else {
        return Err(scratch.to_string());
    };
    for path in writable {
        match path_components(path) {
            Some(parts) if parts.len() >= root.len() && parts[..root.len()] == root[..] => {}
            _ => return Err(path.clone()),
        }
    }
    Ok(())
}

fn run(cli: &Cli) -> Result<RunOutcome, SetupFailure> {
    let request = load_request(&cli.request)?;
    validate_request(&request)?;
    confine::run(request)
}

fn main() {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let status = match parse_cli(&args).and_then(|cli| run(&cli).map(|outcome| (cli, outcome))) {
        Ok((cli, outcome)) => {
            if let Some(reason) = outcome.cancelled {
                // Without the record the host sees an ordinary exit 124: a
                // misreported reason, never a success.
                if let Err(error) = write_cancel_reason(&cli.result, reason) {
                    stderr_line(&format!(
                        "BRIDLE_SANDBOX_WARN setup: could not record cancel reason {reason}: {error}"
                    ));
                }
            }
            process_exit_status(outcome.exit_code)
        }
        Err(error) => {
            stderr_line(&format!("BRIDLE_SANDBOX_DENIED {}: {}", error.resource, error.detail));
            111
        }
    };
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(status);
}

#[cfg(test)]
mod tests {
    use super::{
        ambiguous_component, cancel_reason, parse_cli, process_exit_status,
        writable_within_scratch, write_cancel_reason, CancelReason,
    };
    use std::ffi::OsString;

    #[test]
    fn does_not_panic_on_non_ascii_after_the_verbatim_prefix() {
        // Byte 4 of "C:\Česká" falls inside the two-byte 'Č'.
        assert_eq!(
            writable_within_scratch(r"\\?\C:\Česká\scratch", &paths(&[r"C:\Česká\scratch\x"])),
            Ok(())
        );
        assert_eq!(ambiguous_component(r"\\?\C:\Česká\scratch"), None);
        assert!(writable_within_scratch(r"\\?\Čx", &paths(&[r"C:\x"])).is_err());
        assert!(writable_within_scratch(r"\\?\UNČ", &paths(&[r"C:\x"])).is_err());
    }

    #[test]
    fn requires_both_request_and_result_paths() {
        let args = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        let cli = parse_cli(&args(&["--request", "r.json", "--result", "out"])).unwrap();
        assert_eq!(cli.request.to_str(), Some("r.json"));
        assert_eq!(cli.result.to_str(), Some("out"));
        assert!(parse_cli(&args(&["--request", "r.json"])).is_err());
        assert!(parse_cli(&args(&["--result", "out", "--request", "r.json"])).is_err());
        assert!(parse_cli(&args(&["--request", "r.json", "--result", "out", "x"])).is_err());
    }

    #[test]
    fn records_the_cancel_reason_only_in_the_reserved_file() {
        let dir = std::env::temp_dir().join(format!(
            "bridle-cancel-reason-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("result");
        // Mirror the host: reserve the file empty and exclusively.
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        write_cancel_reason(&path, CancelReason::Timeout).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "timeout");
        // A second write replaces the content (truncation, not append).
        write_cancel_reason(&path, CancelReason::Cancel).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "cancel");
        // A path the host did not reserve is refused, and not created.
        let missing = dir.join("missing");
        assert!(write_cancel_reason(&missing, CancelReason::Timeout).is_err());
        assert!(!missing.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_components_win32_would_reinterpret() {
        assert_eq!(ambiguous_component(r"C:\tmp\scratch."), Some("scratch.".into()));
        assert_eq!(ambiguous_component(r"\\?\C:\tmp\scratch "), Some("scratch ".into()));
        assert_eq!(ambiguous_component(r"C:\tmp\file:stream"), Some("file:stream".into()));
        assert_eq!(ambiguous_component(r"C:\tmp\..\x"), Some("..".into()));
        assert_eq!(ambiguous_component(r"\\.\C:\x"), Some(".".into()));
        assert_eq!(ambiguous_component(r"C:\tmp\a.b\c d\e"), None);
        assert_eq!(ambiguous_component(r"\\?\C:\tmp\scratch-abc"), None);
        assert_eq!(ambiguous_component(r"\\?\UNC\server\share\x"), None);
    }

    #[test]
    fn parses_the_cancel_line() {
        assert_eq!(cancel_reason(Some("timeout\n")), CancelReason::Timeout);
        assert_eq!(cancel_reason(Some("timeout\r\n")), CancelReason::Timeout);
        assert_eq!(cancel_reason(Some("cancel\n")), CancelReason::Cancel);
        assert_eq!(cancel_reason(Some("anything\n")), CancelReason::Cancel);
        assert_eq!(cancel_reason(Some("")), CancelReason::Cancel);
        assert_eq!(cancel_reason(None), CancelReason::Cancel);
        assert_eq!(CancelReason::Timeout.to_string(), "timeout");
        assert_eq!(CancelReason::Cancel.to_string(), "cancel");
    }

    #[test]
    fn passes_the_full_exit_status_through() {
        assert_eq!(process_exit_status(0), 0);
        assert_eq!(process_exit_status(256), 256);
        assert_eq!(process_exit_status(124), 124);
        assert_eq!(process_exit_status(0xC000_0005) as u32, 0xC000_0005);
        assert_ne!(process_exit_status(0x100), 0);
    }

    #[test]
    fn compares_extended_unc_paths_like_plain_unc() {
        assert_eq!(
            writable_within_scratch(r"\\?\UNC\Server\Share\s", &paths(&[r"\\server\share\s\x"])),
            Ok(())
        );
    }

    fn paths(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn accepts_paths_inside_scratch() {
        assert_eq!(
            writable_within_scratch(
                r"C:\tmp\scratch-abc",
                &paths(&[r"C:\tmp\scratch-abc\bun-install-cache", "C:/tmp/scratch-abc/a/b"]),
            ),
            Ok(())
        );
    }

    #[test]
    fn accepts_the_scratch_root_itself() {
        assert_eq!(
            writable_within_scratch(r"C:\tmp\scratch-abc", &paths(&[r"C:\tmp\scratch-abc\"])),
            Ok(())
        );
    }

    #[test]
    fn rejects_a_sibling_sharing_the_prefix() {
        assert_eq!(
            writable_within_scratch(r"C:\tmp\scratch-abc", &paths(&[r"C:\tmp\scratch-abc2"])),
            Err(r"C:\tmp\scratch-abc2".to_string())
        );
    }

    #[test]
    fn rejects_dot_dot_components() {
        let escape = r"C:\tmp\scratch-abc\..\..\Users\me";
        assert_eq!(
            writable_within_scratch(r"C:\tmp\scratch-abc", &paths(&[escape])),
            Err(escape.to_string())
        );
        assert!(writable_within_scratch(r"C:\tmp\scratch-abc\..", &paths(&[r"C:\tmp\x"])).is_err());
    }

    #[test]
    fn compares_case_insensitively_and_strips_verbatim_prefix() {
        assert_eq!(
            writable_within_scratch(
                r"\\?\C:\Tmp\Scratch-ABC",
                &paths(&[r"c:\tmp\scratch-abc\Cache", r"\\?\C:\TMP\SCRATCH-abc"]),
            ),
            Ok(())
        );
    }

    #[test]
    fn rejects_paths_outside_scratch() {
        assert!(writable_within_scratch(r"C:\tmp\scratch-abc", &paths(&[r"C:\outside\work"])).is_err());
        assert!(writable_within_scratch(r"C:\tmp\scratch-abc", &paths(&[r"D:\tmp\scratch-abc"])).is_err());
        assert!(writable_within_scratch(r"C:\tmp\scratch-abc", &paths(&["relative\\path"])).is_err());
        assert!(writable_within_scratch(r"\\server\share\s", &paths(&[r"\\share\s"])).is_err());
    }
}
