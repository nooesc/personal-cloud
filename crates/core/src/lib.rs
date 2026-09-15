use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineReport {
    pub hostname: String,
    pub os: String,
    pub architecture: String,
    pub cpu_cores: u32,
    pub cpu_percent: f32,
    pub memory_total: u64,
    pub memory_used: u64,
    pub disk_total: u64,
    pub disk_used: u64,
    pub docker: bool,
    pub nomad: bool,
    #[serde(default)]
    pub nomad_node_id: Option<String>,
    #[serde(default)]
    pub private_ip: Option<String>,
    #[serde(default)]
    pub wireguard_public_key: Option<String>,
    #[serde(default)]
    pub wireguard_endpoint: Option<String>,
    #[serde(default)]
    pub gpu: Vec<String>,
    #[serde(default)]
    pub network: Vec<String>,
}
impl MachineReport {
    pub fn validate(&self) -> Result<()> {
        for value in [&self.hostname, &self.os, &self.architecture] {
            if value.is_empty() || value.len() > 255 || value.chars().any(char::is_control) {
                bail!("Invalid machine identity");
            }
        }
        if self.cpu_cores == 0
            || !self.cpu_percent.is_finite()
            || !(0.0..=100.0).contains(&self.cpu_percent)
            || self.memory_used > self.memory_total
            || self.disk_used > self.disk_total
        {
            bail!("Invalid machine metrics");
        }
        Ok(())
    }
}

pub fn github_repository(input: &str) -> Result<String> {
    let repo = input
        .trim()
        .strip_prefix("https://github.com/")
        .unwrap_or(input.trim())
        .trim_end_matches('/')
        .trim_end_matches(".git");
    let parts: Vec<_> = repo.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || p.len() > 100
                || *p == "."
                || *p == ".."
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        })
    {
        bail!("Use a GitHub repository in owner/repository format");
    }
    Ok(repo.to_string())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "machine_id", rename_all = "snake_case")]
pub enum Placement {
    Automatic,
    Home,
    Vps,
    Machine(String),
}

/// Compile desired state only. Submitting, observing and promoting a job belongs to the controller.
pub fn nomad_job(
    service_id: &str,
    image: &str,
    architecture: &str,
    placement: Placement,
    stateful: bool,
) -> Result<Value> {
    let Some((repository, digest)) = image.split_once("@sha256:") else {
        bail!("Deployments require an immutable sha256 image digest")
    };
    if repository.is_empty() || digest.len() != 64 || !digest.bytes().all(|c| c.is_ascii_hexdigit())
    {
        bail!("Invalid image digest")
    }
    if stateful {
        bail!(
            "Stateful job compilation is unavailable until explicit volume provisioning is implemented"
        )
    }
    if !["amd64", "arm64"].contains(&architecture) {
        bail!("Unsupported architecture")
    }
    let mut constraints = vec![
        json!({"LTarget":"${attr.cpu.arch}","Operand":"=","RTarget":architecture}),
        json!({"LTarget":"${meta.pc_compute}","Operand":"=","RTarget":"true"}),
    ];
    let target = match placement {
        Placement::Automatic => None,
        Placement::Home => Some(("${meta.pc_location}", "home".to_owned())),
        Placement::Vps => Some(("${meta.pc_location}", "vps".to_owned())),
        Placement::Machine(id) => Some(("${meta.pc_machine_id}", id)),
    };
    if let Some((key, value)) = target {
        constraints.push(json!({"LTarget":key,"Operand":"=","RTarget":value}));
    }
    Ok(
        json!({"Job":{"ID":format!("pc-{service_id}"),"Name":format!("pc-{service_id}"),"Type":"service","Datacenters":["dc1"],"Constraints":constraints,"TaskGroups":[{"Name":"app","Count":1,"Update":{"MaxParallel":1,"HealthCheck":"checks","MinHealthyTime":10000000000_u64,"HealthyDeadline":180000000000_u64,"AutoRevert":true},"Tasks":[{"Name":"app","Driver":"docker","Config":{"image":image},"Resources":{"CPU":500,"MemoryMB":256}}]}]}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_github_repositories() {
        assert_eq!(
            github_repository("https://github.com/acme/api.git").unwrap(),
            "acme/api"
        );
        for input in [
            "https://gitlab.com/acme/api",
            "../api",
            "a/b/c",
            "a/repo?token=secret",
            "a/",
        ] {
            assert!(github_repository(input).is_err());
        }
    }
    #[test]
    fn refuses_mutable_images_and_unimplemented_stateful_jobs() {
        assert!(nomad_job("web", "app:latest", "amd64", Placement::Automatic, false).is_err());
        let image = format!("registry/app@sha256:{}", "a".repeat(64));
        assert!(
            nomad_job(
                "db",
                &image,
                "amd64",
                Placement::Machine("db-01".into()),
                true
            )
            .is_err()
        );
        let job = nomad_job("web", &image, "arm64", Placement::Home, false).unwrap();
        assert_eq!(job["Job"]["Constraints"][2]["RTarget"], "home");
        assert_eq!(job["Job"]["TaskGroups"][0]["Update"]["AutoRevert"], true);
    }
}
