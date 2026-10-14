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
