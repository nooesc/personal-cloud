use anyhow::{Context, Result, ensure};
use clap::Parser;
use personal_cloud_core::MachineReport;
use serde::{Deserialize, Serialize};
use std::{io::Write, path::PathBuf, time::Duration};
use sysinfo::{Disks, System};

#[derive(Parser)]
#[command(
    about = "Connect a machine to your Personal Cloud. Reports inventory; does not install runtimes or alter networking."
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
}
#[derive(Serialize, Deserialize)]
struct Identity {
    id: String,
    credential: String,
    api: String,
}

async fn report(client: &reqwest::Client) -> MachineReport {
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
            .json(&serde_json::json!({"token":enrollment,"report":report(&client).await}))
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
    loop {
        let result = client
            .post(format!("{api}/api/agent/{}/heartbeat", identity.id))
            .bearer_auth(&identity.credential)
            .json(&report(&client).await)
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
        tokio::select! { _=tokio::time::sleep(Duration::from_secs(10))=>{}, _=tokio::signal::ctrl_c()=>break }
    }
    Ok(())
}
