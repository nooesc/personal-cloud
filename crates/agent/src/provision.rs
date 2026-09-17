use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
const ROOT: &str = "/var/lib/personal-cloud";
fn run(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("Cannot execute {program}"))?;
    ensure!(
        output.status.success(),
        "{program} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
pub fn secure_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("new");
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temp, path)?;
    Ok(())
}
pub fn prepare(rotate: bool) -> Result<()> {
    ensure!(
        std::env::consts::OS == "linux",
        "Provisioning requires Ubuntu 22.04/24.04, Debian 12/13, Fedora/Asahi 44, Arch, or Omarchy 4. On macOS use the documented Linux VM path."
    );
    ensure!(
        run("id", &["-u"])? == "0",
        "Run explicit provisioning as root"
    );
    ensure!(
        supported_os(&fs::read_to_string("/etc/os-release")?),
        "Use supported Ubuntu 22.04/24.04, Debian 12/13, Fedora/Asahi 44, Arch, or Omarchy 4"
    );
    let missing = ["docker", "nomad", "wg", "ip", "iptables", "systemctl"]
        .iter()
        .any(|executable| {
            Command::new("sh")
                .args(["-c", &format!("command -v {executable}")])
                .output()
                .map_or(true, |out| !out.status.success())
        });
    if missing {
        let mut installer = Command::new("sh").stdin(Stdio::piped()).spawn()?;
        installer
            .stdin
            .take()
            .context("Runtime installer stdin unavailable")?
            .write_all(include_bytes!("../../../scripts/fleet-runtime-install.sh"))?;
        ensure!(
            installer.wait()?.success(),
            "Linux runtime installation failed"
        );
    }
    let unit = b"[Unit]\nDescription=dinghy Nomad runtime\nWants=network-online.target\nAfter=network-online.target docker.service\nRequires=docker.service\n[Service]\nExecStart=/usr/local/bin/nomad agent -config=/etc/nomad.d/personal-cloud.json\nRestart=on-failure\nRestartSec=5\nKillMode=process\nLimitNOFILE=65536\n[Install]\nWantedBy=multi-user.target\n";
    let nomad_binary = run("sh", &["-c", "command -v nomad"])?;
    ensure!(
        matches!(
            nomad_binary.as_str(),
            "/usr/local/bin/nomad"
                | "/usr/local/sbin/nomad"
                | "/usr/bin/nomad"
                | "/usr/sbin/nomad"
                | "/bin/nomad"
                | "/sbin/nomad"
        ),
        "Install Nomad in a standard system binary directory"
    );
    let unit = String::from_utf8_lossy(unit).replace("/usr/local/bin/nomad", &nomad_binary);
    if write_changed("/etc/systemd/system/nomad.service", unit.as_bytes())? {
        run("systemctl", &["daemon-reload"])?;
    }
    fs::create_dir_all(ROOT)?;
    let path = Path::new(ROOT).join("wireguard.key");
    if rotate || !path.exists() {
        let key = run("wg", &["genkey"])?;
        secure_write(&path, key.as_bytes())?;
    }
    Ok(())
}
pub fn public_key() -> Option<String> {
    let private = fs::read_to_string(Path::new(ROOT).join("wireguard.key")).ok()?;
    let mut child = Command::new("wg")
        .arg("pubkey")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(private.as_bytes()).ok()?;
    let out = child.wait_with_output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
pub fn assigned_ip() -> Option<String> {
    fs::read_to_string(Path::new(ROOT).join("private-ip")).ok()
}
pub fn token() -> Option<String> {
    fs::read_to_string(Path::new(ROOT).join("nomad.token")).ok()
}
pub fn node_id() -> Option<String> {
    let path = std::env::var_os("PC_NOMAD_DATA_DIR")
        .map(|p| Path::new(&p).join("client/client-id"))
        .unwrap_or_else(|| Path::new("/opt/nomad/client/client-id").to_path_buf());
    fs::read_to_string(path).ok().map(|s| s.trim().to_owned())
}
fn key_valid(s: &str) -> bool {
    s.len() == 44
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b))
}
fn ip_valid(s: &str) -> bool {
    s.parse::<std::net::Ipv4Addr>()
        .is_ok_and(|ip| ip.octets()[..2] == [10, 77])
}
fn write_changed(path: &str, bytes: &[u8]) -> Result<bool> {
    if fs::read(path).ok().as_deref() == Some(bytes) {
        return Ok(false);
    }
    secure_write(Path::new(path), bytes)?;
    Ok(true)
}
pub async fn apply(client: &reqwest::Client, config: &Value) -> Result<bool> {
    let ip = config["private_ip"]
        .as_str()
        .context("Missing private IP")?;
    ensure!(ip_valid(ip), "Invalid private IP from control plane");
    let private = fs::read_to_string(Path::new(ROOT).join("wireguard.key"))?;
    ensure!(
        key_valid(private.trim()),
        "Invalid local WireGuard private key"
    );
    let mut wg = format!(
        "[Interface]\nPrivateKey = {}\nListenPort = 51820\n",
        private.trim()
    );
    for peer in config["peers"].as_array().context("Missing peers")? {
        let key = peer["public_key"].as_str().context("Peer key missing")?;
        let address = peer["private_ip"]
            .as_str()
            .context("Peer address missing")?;
        ensure!(
            key_valid(key) && ip_valid(address),
            "Invalid WireGuard peer"
        );
        let allowed = peer["allowed_ips"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{address}/32"));
        ensure!(
            allowed == "10.77.0.0/16" || allowed == format!("{address}/32"),
            "Invalid peer route"
        );
        wg.push_str(&format!(
            "\n[Peer]\nPublicKey = {key}\nAllowedIPs = {allowed}\nPersistentKeepalive = 25\n"
        ));
        if let Some(endpoint) = peer["endpoint"].as_str() {
            ensure!(
                endpoint.len() < 300
                    && endpoint
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b)),
                "Invalid WireGuard endpoint"
            );
            wg.push_str(&format!("Endpoint = {endpoint}\n"));
        }
    }
    let wg_changed = write_changed("/var/lib/personal-cloud/wireguard.conf", wg.as_bytes())?;
    let exists = Command::new("ip")
        .args(["link", "show", "pc0"])
        .output()?
        .status
        .success();
    if !exists {
        run("ip", &["link", "add", "pc0", "type", "wireguard"])?;
    }
    if wg_changed || !exists {
        run(
            "wg",
            &["syncconf", "pc0", "/var/lib/personal-cloud/wireguard.conf"],
        )?;
    }
    run(
        "ip",
        &["address", "replace", &format!("{ip}/16"), "dev", "pc0"],
    )?;
    run("ip", &["link", "set", "pc0", "up"])?;
    write_changed("/var/lib/personal-cloud/private-ip", ip.as_bytes())?;
    let roles = config["roles"]
        .as_array()
        .context("Missing machine roles")?;
    let has_role = |role: &str| roles.iter().any(|v| v.as_str() == Some(role));
    let mut meta = json!({"pc_machine_id":config["machine_id"],"pc_compute":has_role("compute").to_string(),"pc_builder":has_role("builder").to_string(),"pc_database":has_role("database").to_string(),"pc_location":config["location"]});
    for tag in config["tags"].as_array().context("Missing tags")? {
        let tag = tag.as_str().context("Invalid tag")?;
        // Hex encoding preserves arbitrary owner tags without collisions or HCL interpolation.
        let encoded = tag
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        meta[format!("pc_tag_{encoded}")] = json!("true");
    }
    let server = config["nomad"]["server"].as_bool().unwrap_or(false);
    if server {
        write_changed(
            "/etc/sysctl.d/90-personal-cloud.conf",
            b"net.ipv4.ip_forward=1\n",
        )?;
        run("sysctl", &["-w", "net.ipv4.ip_forward=1"])?;
        if !Command::new("iptables")
            .args(["-C", "FORWARD", "-i", "pc0", "-o", "pc0", "-j", "ACCEPT"])
            .output()?
            .status
            .success()
        {
            run(
                "iptables",
                &["-I", "FORWARD", "-i", "pc0", "-o", "pc0", "-j", "ACCEPT"],
            )?;
        }
    }
    let mut nomad = json!({"data_dir":"/opt/nomad","bind_addr":ip,"addresses":{"http":format!("127.0.0.1 {ip}")},"advertise":{"http":format!("{ip}:4646"),"rpc":format!("{ip}:4647"),"serf":format!("{ip}:4648")},"server":{"enabled":server,"bootstrap_expect":if server{1}else{0}},"client":{"enabled":true,"servers":config["nomad"]["servers"],"network_interface":"pc0","host_network":{"pc_private":{"cidr":format!("{ip}/32")}},"host_volume":{"pc-data":{"path":"/opt/personal-cloud/data","read_only":false}},"meta":meta},"acl":{"enabled":true},"plugin":{"docker":{"config":{"allow_privileged":false,"volumes":{"enabled":true}}}},"telemetry":{"publish_allocation_metrics":true,"publish_node_metrics":true,"collection_interval":"1s"},"consul":{"auto_advertise":false,"server_auto_join":false,"client_auto_join":false}});
    // ARM VMs can expose CPU frequency to sysinfo while Nomad still reports zero.
    // Persist the initial capacity so changing CPU clock speeds never trigger restarts.
    let capacity_file = Path::new(ROOT).join("cpu-capacity-mhz");
    let system = sysinfo::System::new_all();
    let minimum_capacity = system.cpus().len().max(1) as u64 * 100;
    let capacity = fs::read_to_string(&capacity_file)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v >= minimum_capacity);
    let capacity = match capacity {
        Some(value) => value,
        None => {
            let value = system
                .cpus()
                .iter()
                .map(|cpu| {
                    if cpu.frequency() >= 100 {
                        cpu.frequency()
                    } else {
                        1000
                    }
                })
                .sum::<u64>()
                .max(1000);
            secure_write(&capacity_file, value.to_string().as_bytes())?;
            value
        }
    };
    nomad["client"]["cpu_total_compute"] = json!(capacity);
    fs::create_dir_all("/opt/personal-cloud/data")?;
    let changed = write_changed(
        "/etc/nomad.d/personal-cloud.json",
        &serde_json::to_vec_pretty(&nomad)?,
    )?;
    // Only private fleet addresses are permitted as plain-HTTP registries.
    let daemon_path = PathBuf::from("/etc/docker/daemon.json");
    let mut daemon: Value = if daemon_path.exists() {
        serde_json::from_slice(&fs::read(&daemon_path)?)?
    } else {
        json!({})
    };
    let registries = daemon
        .as_object_mut()
        .context("Invalid Docker config")?
        .entry("insecure-registries")
        .or_insert(json!([]))
        .as_array_mut()
        .context("Invalid Docker registry config")?;
    if !registries.contains(&json!("10.77.0.0/16")) {
        registries.push(json!("10.77.0.0/16"));
        secure_write(&daemon_path, &serde_json::to_vec_pretty(&daemon)?)?;
    }
    // Reload registry settings without restarting other applications or Swarm.
    // Check live state even on retries: writing daemon.json alone is not success.
    if !docker_has_fleet_registry()? {
        run(
            "dockerd",
            &["--validate", "--config-file=/etc/docker/daemon.json"],
        )?;
        run(
            "systemctl",
            &["kill", "--kill-whom=main", "--signal=HUP", "docker.service"],
        )?;
        for _ in 0..20 {
            if docker_has_fleet_registry()? {
                break;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        ensure!(
            docker_has_fleet_registry()?,
            "Docker did not reload the private fleet registry; existing workloads were not restarted"
        );
    }
    if changed {
        run(
            "nomad",
            &["config", "validate", "/etc/nomad.d/personal-cloud.json"],
        )?;
        run("systemctl", &["restart", "nomad"])?;
    } else {
        run("systemctl", &["start", "nomad"])?;
    }
    if has_role("builder") {
        let existing = Command::new("docker")
            .args([
                "inspect",
                "--format",
                "{{index .Config.Labels \"personal-cloud.managed\"}}",
                "pc-buildkit",
            ])
            .output()?;
        if existing.status.success() {
            ensure!(
                String::from_utf8_lossy(&existing.stdout).trim() == "true",
                "pc-buildkit name is owned by another application"
            );
            run("docker", &["start", "pc-buildkit"])?;
        } else {
            run(
                "docker",
                &[
                    "run",
                    "-d",
                    "--name",
                    "pc-buildkit",
                    "--label",
                    "personal-cloud.managed=true",
                    "--restart",
                    "unless-stopped",
                    "--privileged",
                    "--network",
                    "host",
                    "moby/buildkit:v0.33.0",
                    "--addr",
                    "tcp://127.0.0.1:1234",
                ],
            )?;
        }
    }
    if server && token().is_none() {
        for _ in 0..30 {
            if let Ok(response) = client
                .post("http://127.0.0.1:4646/v1/acl/bootstrap")
                .send()
                .await
            {
                if response.status().is_success() {
                    let result: Value = response.json().await?;
                    let token = result["SecretID"].as_str().context("Missing Nomad token")?;
                    secure_write(&Path::new(ROOT).join("nomad.token"), token.as_bytes())?;
                    break;
                }
                if response.status() == reqwest::StatusCode::FORBIDDEN {
                    anyhow::bail!(
                        "Nomad ACL was already bootstrapped; restore the node-local nomad.token backup before continuing"
                    );
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        ensure!(
            token().is_some(),
            "Nomad did not become ready for ACL bootstrap"
        );
    }
    Ok(server)
}
pub async fn relay(client: &reqwest::Client, identity: &super::Identity) -> Result<()> {
    let response = client
        .get(format!(
            "{}/api/agent/{}/commands",
            identity.api, identity.id
        ))
        .bearer_auth(&identity.credential)
        .send()
        .await?
        .error_for_status()?;
    let commands: Value = response.json().await?;
    for command in commands["commands"]
        .as_array()
        .context("Missing command list")?
    {
        let request = &command["request"];
        let method = request["method"].as_str().unwrap_or("");
        let path = request["path"].as_str().unwrap_or("");
        ensure!(
            matches!(method, "GET" | "POST" | "PUT" | "DELETE")
                && path.starts_with("/v1/")
                && !path.contains(".."),
            "Invalid controller command"
        );
        if let Some(allocation) = path
            .strip_prefix("/v1/personal-cloud/allocation/")
            .and_then(|p| p.strip_suffix("/network"))
        {
            ensure!(method == "GET", "Network counters are read-only");
            let (status, body) =
                match tokio::time::timeout(Duration::from_secs(20), docker_network(allocation))
                    .await
                {
                    Ok(Ok(value)) => (200, value.to_string()),
                    _ => (
                        503,
                        json!({"error":"Docker network counters unavailable"}).to_string(),
                    ),
                };
            send_result(client, identity, command, status, body).await?;
            continue;
        }
        let mut local = client
            .request(method.parse()?, format!("http://127.0.0.1:4646{path}"))
            .timeout(Duration::from_secs(40));
        if let Some(token) = token() {
            local = local.header("X-Nomad-Token", token);
        }
        if !request["body"].is_null() {
            local = local.json(&request["body"]);
        }
        let (status, body) = match local.send().await {
            Ok(mut response) => {
                let status = response.status().as_u16();
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await? {
                    if bytes.len() + chunk.len() > 1024 * 1024 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk);
                }
                (status, String::from_utf8_lossy(&bytes).into_owned())
            }
            Err(_) => (502, "Local Nomad is unreachable".to_owned()),
        };
        send_result(client, identity, command, status, body).await?;
    }
    Ok(())
}

async fn send_result(
    client: &reqwest::Client,
    identity: &super::Identity,
    command: &Value,
    status: u16,
    body: String,
) -> Result<()> {
    client
        .post(format!(
            "{}/api/agent/{}/commands/{}",
            identity.api,
            identity.id,
            command["id"].as_str().context("Missing command ID")?
        ))
        .bearer_auth(&identity.credential)
        .json(&json!({"status":status,"body":body}))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}
async fn docker_network(allocation: &str) -> Result<Value> {
    let id = uuid::Uuid::parse_str(allocation).context("Invalid allocation ID")?;
    ensure!(
        id.to_string() == allocation,
        "Use the canonical allocation UUID"
    );
    let engine = reqwest::Client::builder()
        .unix_socket("/var/run/docker.sock")
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build()?;
    let filters = json!({"label":[format!("com.hashicorp.nomad.alloc_id={id}")]}).to_string();
    let containers: Vec<Value> = engine
        .get("http://localhost/containers/json")
        .query(&[("filters", filters)])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    ensure!(
        !containers.is_empty() && containers.len() <= 32,
        "No running allocation containers"
    );
    let (mut rx, mut tx, mut restarts) = (0_u64, 0_u64, 0_u64);
    let mut observed_at = None;
    for container in containers {
        let container_id = container["Id"].as_str().context("Missing container ID")?;
        ensure!(
            container_id.len() == 64 && container_id.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid Docker container ID"
        );
        let stats: Value = engine
            .get(format!(
                "http://localhost/containers/{container_id}/stats?stream=false&one-shot=true"
            ))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let networks = stats["networks"]
            .as_object()
            .context("Network accounting is unavailable for this container's network mode")?;
        for network in networks.values() {
            rx = rx.saturating_add(
                network["rx_bytes"]
                    .as_u64()
                    .context("Missing receive counter")?,
            );
            tx = tx.saturating_add(
                network["tx_bytes"]
                    .as_u64()
                    .context("Missing transmit counter")?,
            );
        }
        if let Some(time) = stats["read"].as_str() {
            observed_at = Some(time.to_owned());
        }
        // The formatter exposes only the restart count, never Docker config or environment.
        let output = tokio::time::timeout(
            Duration::from_secs(3),
            tokio::process::Command::new("docker")
                .args(["inspect", "--format", "{{.RestartCount}}", container_id])
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        ensure!(output.status.success(), "Docker restart count unavailable");
        restarts = restarts.saturating_add(
            String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<u64>()?,
        );
    }
    Ok(json!({"rx_bytes":rx,"tx_bytes":tx,"restarts":restarts,"observed_at":observed_at}))
}

fn supported_os(release: &str) -> bool {
    let value = |key: &str| {
        release
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once('=')?;
                (name == key).then(|| value.trim_matches(['"', '\'']))
            })
            .unwrap_or("")
    };
    value("ID") == "arch"
        || (value("ID") == "omarchy" && value("VERSION_ID").starts_with("4."))
        || matches!(
            (value("ID"), value("VERSION_ID")),
            ("ubuntu", "22.04" | "24.04")
                | ("debian", "12" | "13")
                | ("fedora" | "fedora-asahi-remix", "44")
        )
}

fn docker_has_fleet_registry() -> Result<bool> {
    let cidrs: Vec<String> = serde_json::from_str(&run(
        "docker",
        &[
            "info",
            "--format",
            "{{json .RegistryConfig.InsecureRegistryCIDRs}}",
        ],
    )?)?;
    Ok(cidrs.iter().any(|cidr| cidr == "10.77.0.0/16"))
}

#[cfg(test)]
mod tests {
    use super::supported_os;
    #[test]
    fn exact_supported_distributions_only() {
        for os in [
            "ID=arch",
            "ID=omarchy\nVERSION_ID=4.0.2\nID_LIKE=arch",
            "ID=ubuntu\nVERSION_ID=22.04",
            "ID=ubuntu\nVERSION_ID=24.04",
            "ID=debian\nVERSION_ID=12",
            "ID=debian\nVERSION_ID=13",
            "ID=fedora\nVERSION_ID=44",
            "ID=fedora-asahi-remix\nVERSION_ID=\"44\"\nID_LIKE=fedora",
        ] {
            assert!(supported_os(os), "{os}");
        }
        for os in [
            "ID=unknown\nID_LIKE=arch",
            "ID=omarchy\nVERSION_ID=3.0",
            "ID=unknown\nID_LIKE=fedora\nVERSION_ID=44",
            "ID=fedora\nVERSION_ID=40",
            "ID=ubuntu\nVERSION_ID=20.04",
            "ID=fedora",
            "",
        ] {
            assert!(!supported_os(os), "{os}");
        }
    }
}
