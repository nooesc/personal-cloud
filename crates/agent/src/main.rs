mod provision;

use anyhow::{Context, Result, ensure};
use clap::Parser;
use personal_cloud_core::MachineReport;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::PathBuf, time::Duration};
use sysinfo::{Disks, System};

#[derive(Parser)]
#[command(
    about = "Connect a machine to Personal Cloud; --provision explicitly configures the private Linux runtime."
)]
struct Args {
    #[arg(long, env = "PC_API", default_value = "http://127.0.0.1:4311")]
    api: String,
    #[arg(long, env = "PC_ENROLL_TOKEN", hide_env_values = true)]
    enrollment_token: Option<String>,
    #[arg(long, default_value = ".pc-agent.json")]
    state: PathBuf,
    #[arg(long)]
    once: bool,
    #[arg(long)]
    provision: bool,
    #[arg(long, requires = "provision")]
    rotate_wireguard: bool,
    #[arg(long, env = "PC_WIREGUARD_ENDPOINT")]
    wireguard_endpoint: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Identity {
    id: String,
    credential: String,
    api: String,
}

async fn report(client: &reqwest::Client, endpoint: &Option<String>) -> MachineReport {
    let mut system = System::new_all();
    tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
    system.refresh_cpu_usage();
    system.refresh_memory();
    let disks = Disks::new_with_refreshed_list();
    let root = disks
        .iter()
        .find(|d| d.mount_point() == std::path::Path::new("/"));
    let (disk_total, disk_used) = root
        .map(|d| {
            (
                d.total_space(),
                d.total_space().saturating_sub(d.available_space()),
            )
        })
        .unwrap_or_default();
    let docker = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::process::Command::new("docker")
            .args(["info", "--format", "{{.ServerVersion}}"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .is_some_and(|o| o.status.success());
    let nomad = client
        .get("http://127.0.0.1:4646/v1/agent/health")
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success());
    MachineReport {
        hostname: System::host_name().unwrap_or("unknown".into()),
        os: System::long_os_version().unwrap_or(std::env::consts::OS.into()),
        architecture: match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "amd64",
            other => other,
        }
        .into(),
        cpu_cores: system.cpus().len() as u32,
        cpu_percent: system.global_cpu_usage(),
        memory_total: system.total_memory(),
        memory_used: system.used_memory(),
        disk_total,
        disk_used,
        docker,
        nomad,
        nomad_node_id: provision::node_id(),
        private_ip: provision::assigned_ip(),
        wireguard_public_key: provision::public_key(),
        wireguard_endpoint: endpoint.clone(),
        gpu: gpu_inventory().await,
        network: network_inventory().await,
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let url = reqwest::Url::parse(&args.api)?;
    ensure!(
        url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))),
        "Use HTTPS for a remote control plane"
    );
    let api = args.api.trim_end_matches('/').to_string();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    if args.provision {
        provision::prepare(args.rotate_wireguard)?;
    }
    let identity: Identity = if args.state.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                std::fs::metadata(&args.state)?.permissions().mode() & 0o077 == 0,
                "Agent identity must have mode 0600"
            );
        }
        let identity: Identity = serde_json::from_slice(&std::fs::read(&args.state)?)?;
        ensure!(
            identity.api == api,
            "Stored identity belongs to a different control plane"
        );
        identity
    } else {
        let enrollment = args
            .enrollment_token
            .context("Create an enrollment token in the dashboard and set PC_ENROLL_TOKEN")?;
        let response = client
            .post(format!("{api}/api/agent/enroll"))
            .json(&serde_json::json!({"token":enrollment,"report":report(&client, &args.wireguard_endpoint).await}))
            .send()
            .await?;
        ensure!(
            response.status().is_success(),
            "Enrollment rejected ({}); create a fresh token",
            response.status()
        );
        #[derive(Deserialize)]
        struct Enrollment {
            id: String,
            credential: String,
        }
        let enrollment: Enrollment = response.json().await?;
        let identity = Identity {
            id: enrollment.id,
            credential: enrollment.credential,
            api: api.clone(),
        };
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&args.state)
            .context("Cannot save agent identity")?;
        file.write_all(&serde_json::to_vec(&identity)?)?;
        file.sync_all()?;
        println!("Machine enrolled: {}", identity.id);
        identity
    };
    if args.provision {
        // Publish the local public key before requesting authenticated peer configuration.
        client
            .post(format!("{api}/api/agent/{}/heartbeat", identity.id))
            .bearer_auth(&identity.credential)
            .json(&report(&client, &args.wireguard_endpoint).await)
            .send()
            .await?
            .error_for_status()?;
        reconcile(&client, &identity).await?;
    }
    let mut last_reconcile = tokio::time::Instant::now();
    let mut last_heartbeat = tokio::time::Instant::now() - Duration::from_secs(10);
    loop {
        if args.provision {
            if let Err(error) = provision::relay(&client, &identity).await {
                eprintln!("Fleet relay: {error:#}");
            }
            if last_reconcile.elapsed() >= Duration::from_secs(30) {
                if let Err(error) = reconcile(&client, &identity).await {
                    eprintln!("Fleet configuration: {error:#}");
                }
                last_reconcile = tokio::time::Instant::now();
            }
        }
        if last_heartbeat.elapsed() < Duration::from_secs(10) {
            tokio::select! { _=tokio::time::sleep(Duration::from_millis(750))=>continue, _=tokio::signal::ctrl_c()=>break }
        }
        last_heartbeat = tokio::time::Instant::now();
        let result = client
            .post(format!("{api}/api/agent/{}/heartbeat", identity.id))
            .bearer_auth(&identity.credential)
            .json(&report(&client, &args.wireguard_endpoint).await)
            .send()
            .await;
        match result {
            Ok(response) if response.status().is_success() => println!("Heartbeat accepted"),
            Ok(response) => {
                eprintln!("Heartbeat rejected: {}", response.status());
                if args.once {
                    anyhow::bail!("Heartbeat failed");
                }
            }
            Err(error) => {
                eprintln!("Control plane unreachable: {error}");
                if args.once {
                    return Err(error.into());
                }
            }
        }
        if args.once {
            break;
        }
        tokio::select! { _=tokio::time::sleep(Duration::from_millis(750))=>{}, _=tokio::signal::ctrl_c()=>break }
    }
    Ok(())
}

async fn reconcile(client: &reqwest::Client, identity: &Identity) -> Result<()> {
    let config: serde_json::Value = client
        .get(format!("{}/api/agent/{}/config", identity.api, identity.id))
        .bearer_auth(&identity.credential)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if provision::apply(client, &config).await? {
        client
            .post(format!(
                "{}/api/agent/{}/runtime-ready",
                identity.api, identity.id
            ))
            .bearer_auth(&identity.credential)
            .send()
            .await?
            .error_for_status()?;
    }
    Ok(())
}
async fn gpu_inventory() -> Vec<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("nvidia-smi")
            .args(["--query-gpu=name,memory.total", "--format=csv,noheader"])
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let nvidia: Vec<String> = output
        .ok()
        .and_then(Result::ok)
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .take(32)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if !nvidia.is_empty() {
        return nvidia;
    }
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return vec![];
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("card") || !name[4..].chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let vendor = std::fs::read_to_string(entry.path().join("device/vendor")).ok()?;
            let device = std::fs::read_to_string(entry.path().join("device/device")).ok()?;
            let brand = match vendor.trim() {
                "0x1002" => "AMD",
                "0x8086" => "Intel",
                "0x10de" => "NVIDIA",
                _ => "PCI",
            };
            Some(format!("{brand} GPU ({})", device.trim()))
        })
        .take(32)
        .collect()
}
async fn network_inventory() -> Vec<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("ip")
            .args(["-j", "address", "show", "up"])
            .kill_on_drop(true)
            .output(),
    )
    .await;
    let Some(output) = output
        .ok()
        .and_then(Result::ok)
        .filter(|o| o.status.success())
    else {
        return vec![];
    };
    let Ok(values) = serde_json::from_slice::<Vec<serde_json::Value>>(&output.stdout) else {
        return vec![];
    };
    values
        .iter()
        .flat_map(|v| {
            v["addr_info"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a["local"].as_str().map(str::to_owned))
        })
        .take(64)
        .collect()
}
