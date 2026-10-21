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
// The policy mirror is parsed so a malformed request fails closed; the helper
// acts on `network` here and on the `appContainer` block for everything else.
#[allow(dead_code)]
pub struct RunnerSandboxPolicy {
    pub filesystem: FilesystemPolicy,
    pub network: String,
    pub resources: ResourcePolicy,
}

#[derive(Debug, Deserialize)]
// The policy mirror is parsed so a malformed request fails closed; the helper
// acts on `network` here and on the `appContainer` block for everything else.
#[allow(dead_code)]
pub struct FilesystemPolicy {
    pub readable: Vec<String>,
    pub writable: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // parsed for shape; the helper reads `appContainer.job`
pub struct ResourcePolicy {
    // camelCase would give "memoryMb"; the TS request writes "memoryMB".
    #[serde(rename = "memoryMB")]
    pub memory_mb: u64,
    pub wallclock_sec: u32,
    pub max_processes: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
// Only the Windows confinement path reads every field.
#[cfg_attr(not(windows), allow(dead_code))]
pub struct AppContainerSpec {
    pub name_prefix: String,
    pub capabilities: Vec<String>,
    pub network: String,
    pub integrity: String,
    pub restricted_token: String,
    pub grants: Grants,
    pub job: Job,
    /// The per-run scratch directory the host created (and deletes). The only
    /// tree the helper labels Low and grants writes on; every writable grant
    /// must lie inside it.
    #[serde(default)]
    pub scratch_root: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Grants {
    pub readable: Vec<String>,
    pub writable: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
// Only the Windows confinement path reads every field.
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Job {
    // camelCase would give "memoryMb"; the TS request writes "memoryMB".
    #[serde(rename = "memoryMB")]
    pub memory_mb: u64,
    pub wallclock_sec: u32,
    pub max_processes: u32,
}
