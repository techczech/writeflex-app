mod acl;
mod confine;
mod request;

use request::Request;
use std::{env, fs, path::PathBuf, process::ExitCode};

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

pub struct RunOutcome {
    pub exit_code: u32,
}

fn request_path() -> Result<PathBuf, SetupFailure> {
    let mut args = env::args_os().skip(1);
    match (args.next(), args.next(), args.next()) {
        (Some(flag), Some(path), None) if flag == "--request" => Ok(PathBuf::from(path)),
        _ => Err(SetupFailure::new(
            "setup",
            "usage: bridle-runner-sandbox.exe --request <path>",
        )),
    }
}

fn load_request() -> Result<Request, SetupFailure> {
    let path = request_path()?;
    let bytes = fs::read(&path).map_err(|error| {
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
    {
        return Err(SetupFailure::new(
            "setup",
            "request command, cwd and grant paths must not contain NUL",
        ));
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

fn run() -> Result<RunOutcome, SetupFailure> {
    let request = load_request()?;
    validate_request(&request)?;
    confine::run(request)
}

fn main() -> ExitCode {
    match run() {
        Ok(outcome) => ExitCode::from((outcome.exit_code & 0xff) as u8),
        Err(error) => {
            eprintln!("BRIDLE_SANDBOX_DENIED {}: {}", error.resource, error.detail);
            ExitCode::from(111)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Request {
        serde_json::from_value(serde_json::json!({
            "command": ["cmd.exe", "/c", "exit 0"], "cwd": "C:\\", "env": {},
            "policy": {"filesystem": {"readable": [], "writable": []}, "network": "none",
                "resources": {"memoryMB": 128, "wallclockSec": 5, "maxProcesses": 1}},
            "appContainer": {"namePrefix": "Bridle.Test", "capabilities": [], "network": "none",
                "integrity": "low", "restrictedToken": "write-restricted",
                "grants": {"readable": [], "writable": []},
                "job": {"memoryMB": 128, "wallclockSec": 5, "maxProcesses": 1}}
        }))
        .unwrap()
    }

    #[test]
    fn restricted_request_is_accepted() {
        assert!(validate_request(&request()).is_ok());
    }

    #[test]
    fn network_and_capability_requests_fail_closed() {
        let mut input = request();
        input.policy.network = "internet".into();
        assert_eq!(validate_request(&input).unwrap_err().resource, "network");
        input = request();
        input.app_container.network = "internet".into();
        assert_eq!(validate_request(&input).unwrap_err().resource, "network");
        input = request();
        input
            .app_container
            .capabilities
            .push("internetClient".into());
        assert_eq!(validate_request(&input).unwrap_err().resource, "network");
    }

    #[test]
    fn missing_confinement_requirements_fail_closed() {
        let mut input = request();
        input.command.clear();
        assert!(validate_request(&input).is_err());
        input = request();
        input.app_container.integrity = "medium".into();
        assert!(validate_request(&input).is_err());
        input = request();
        input.app_container.restricted_token = "unrestricted".into();
        assert!(validate_request(&input).is_err());
    }
}
