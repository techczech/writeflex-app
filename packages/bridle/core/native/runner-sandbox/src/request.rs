use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub command: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub policy: RunnerSandboxPolicy,
    pub app_container: AppContainerSpec,
}

#[derive(Debug, Deserialize)]
pub struct RunnerSandboxPolicy {
    pub filesystem: FilesystemPolicy,
    pub network: String,
    pub resources: ResourcePolicy,
}

#[derive(Debug, Deserialize)]
pub struct FilesystemPolicy {
    pub readable: Vec<String>,
    pub writable: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePolicy {
    // camelCase would give "memoryMb"; the TS request writes "memoryMB".
    #[serde(rename = "memoryMB")]
    pub memory_mb: u64,
    pub wallclock_sec: u32,
    pub max_processes: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppContainerSpec {
    pub name_prefix: String,
    pub capabilities: Vec<String>,
    pub network: String,
    pub integrity: String,
    pub restricted_token: String,
    pub grants: Grants,
    pub job: Job,
}

#[derive(Debug, Deserialize)]
pub struct Grants {
    pub readable: Vec<String>,
    pub writable: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    // camelCase would give "memoryMb"; the TS request writes "memoryMB".
    #[serde(rename = "memoryMB")]
    pub memory_mb: u64,
    pub wallclock_sec: u32,
    pub max_processes: u32,
}
