//! Opt-in native jobs on a customer-owned Mac. This is not a hostile-code sandbox.
use crate::Identity;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

async fn output(program: &str, args: &[&str]) -> Option<String> {
    tokio::time::timeout(
        Duration::from_secs(15),
        Command::new(program).args(args).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}
pub async fn capability(enabled: bool) -> Option<Value> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let xcode = output("/usr/bin/xcodebuild", &["-version"]).await;
    let devices = output(
        "/usr/bin/xcrun",
        &["simctl", "list", "devices", "available", "--json"],
    )
    .await
    .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let mut simulators = vec![];
    if let Some(groups) = devices.as_ref().and_then(|d| d["devices"].as_object()) {
        for (runtime, devices) in groups {
            if !runtime.contains(".iOS-") {
                continue;
            }
            for device in devices.as_array().into_iter().flatten() {
                if device["isAvailable"] == true {
                    simulators
                        .push(json!({"id":device["udid"],"name":device["name"],"runtime":runtime}));
                }
            }
        }
    }
    Some(
        json!({"enabled":enabled,"xcode":xcode,"simulators":simulators.into_iter().take(32).collect::<Vec<_>>()}),
    )
}
fn private_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
fn field<'a>(job: &'a Value, key: &str) -> Result<&'a str> {
    job[key].as_str().with_context(|| format!("Missing {key}"))
}
fn valid(job: &Value) -> Result<()> {
    let commit = field(job, "commit")?;
    ensure!(
        commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid commit"
    );
    let repo = field(job, "repository")?;
    ensure!(
        repo.split('/').count() == 2
            && repo.split('/').all(|p| !p.is_empty()
                && p != "."
                && p != ".."
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))),
        "Invalid repository"
    );
    let container = Path::new(field(job, "container")?);
    ensure!(
        container
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
            && matches!(
                container.extension().and_then(|x| x.to_str()),
                Some("xcodeproj" | "xcworkspace")
            ),
        "Invalid Xcode container"
    );
    ensure!(
        matches!(field(job, "action")?, "build" | "test"),
        "Invalid action"
    );
    ensure!(!field(job, "scheme")?.starts_with('-'), "Invalid scheme");
    ensure!(
        (60..=3600).contains(&job["timeout_seconds"].as_u64().unwrap_or(0)),
        "Invalid timeout"
    );
    Ok(())
}
struct Session<'a> {
    client: &'a reqwest::Client,
    identity: &'a Identity,
    job: &'a Value,
    start: tokio::time::Instant,
    log: String,
}
impl Session<'_> {
    fn url(&self) -> String {
        format!(
            "{}/api/agent/{}/apple-jobs/{}",
            self.identity.api,
            self.identity.id,
            self.job["id"].as_str().unwrap_or_default()
        )
    }
    async fn cancelled(&self) -> bool {
        let result = self
            .client
            .get(self.url())
            .bearer_auth(&self.identity.credential)
            .header(
                "x-apple-attempt",
                self.job["attempt"].as_str().unwrap_or_default(),
            )
            .send()
            .await;
        // Loss of authorization/contact stops local execution; never keep running blindly.
        match result {
            Ok(r) if r.status().is_success() => r
                .json::<Value>()
                .await
                .map(|v| v["cancel"] != false)
                .unwrap_or(true),
            _ => true,
        }
    }
    fn append(&mut self, line: &str) {
        let secret = self.job["source_token"].as_str().unwrap_or("");
        let line = if secret.is_empty() {
            line.to_string()
        } else {
            line.replace(secret, "[redacted]")
        };
        self.log.push_str(&line);
        self.log.push('\n');
        if self.log.len() > 60000 {
            let mut cut = self.log.len() - 60000;
            while !self.log.is_char_boundary(cut) {
                cut += 1;
            }
            self.log.drain(..cut);
        }
    }
    async fn run(&mut self, mut command: Command) -> Result<bool> {
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        for key in [
            "GIT_TRACE",
            "GIT_TRACE_CURL",
            "GIT_CURL_VERBOSE",
            "GIT_TRACE_PACKET",
            "GIT_TRACE2",
            "GIT_TRACE2_EVENT",
            "GIT_TRACE2_PERF",
        ] {
            command.env_remove(key);
        }
        let mut child = command.spawn()?;
        let pid = child.id().context("Missing process id")?;
        let _group = ProcessGroup(pid);
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let mut out_buf = [0u8; 4096];
        let mut err_buf = [0u8; 4096];
        let mut out_done = false;
        let mut err_done = false;
        let mut tick = tokio::time::interval(Duration::from_secs(3));
        #[cfg(unix)]
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        loop {
            tokio::select! {
                _=tokio::signal::ctrl_c()=>anyhow::bail!("cancelled"),
                _=terminate.recv()=>anyhow::bail!("cancelled"),
                read=stdout.read(&mut out_buf), if !out_done=>match read {Ok(0)=>out_done=true,Ok(n)=>self.append(&String::from_utf8_lossy(&out_buf[..n])),Err(_)=>out_done=true},
                read=stderr.read(&mut err_buf), if !err_done=>match read {Ok(0)=>err_done=true,Ok(n)=>self.append(&String::from_utf8_lossy(&err_buf[..n])),Err(_)=>err_done=true},
                result=child.wait()=>return Ok(result?.success()),
                _=tick.tick()=> {
                    let timed=self.start.elapsed().as_secs()>self.job["timeout_seconds"].as_u64().unwrap_or(1800);
                    if timed || self.cancelled().await {
                        #[cfg(unix)] unsafe { libc::kill(-(pid as i32),libc::SIGKILL); }
                        let _=child.kill().await; let _=child.wait().await;
                        anyhow::bail!(if timed {"timed_out"} else {"cancelled"});
                    }
                }
            }
        }
    }
}
struct ProcessGroup(u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}
async fn execute(session: &mut Session<'_>, root: &Path) -> Result<bool> {
    valid(session.job)?;
    let job = session.job.clone();
    let source = root.join("source");
    private_dir(&source)?;
    let mut init = Command::new("/usr/bin/git");
    init.args(["init", "--quiet"]).arg(&source);
    ensure!(session.run(init).await?, "Git initialization failed");
    let mut fetch = Command::new("/usr/bin/git");
    // Credentials are environment-only for fetch, never in clone URLs, disk config or build scripts.
    let auth = base64_encode(&format!("x-access-token:{}", field(&job, "source_token")?));
    fetch
        .current_dir(&source)
        .args([
            "-c",
            "credential.helper=",
            "fetch",
            "--depth=1",
            "--no-tags",
        ])
        .arg(format!(
            "https://github.com/{}.git",
            field(&job, "repository")?
        ))
        .arg(field(&job, "commit")?)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_0", format!("Authorization: Basic {auth}"));
    ensure!(session.run(fetch).await?, "Git fetch failed");
    let mut checkout = Command::new("/usr/bin/git");
    checkout
        .current_dir(&source)
        .args(["checkout", "--detach", "--force", field(&job, "commit")?]);
    ensure!(session.run(checkout).await?, "Git checkout failed");
    build_xcode(session, root, &source).await
}
async fn build_xcode(session: &mut Session<'_>, root: &Path, source: &Path) -> Result<bool> {
    let job = session.job.clone();
    let container = source.join(field(&job, "container")?).canonicalize()?;
    ensure!(
        container.starts_with(source.canonicalize()?),
        "Xcode container escapes checkout"
    );
    let clone_name = format!("dinghy-{}", field(&job, "id")?);
    let simulator = output(
        "/usr/bin/xcrun",
        &["simctl", "clone", field(&job, "simulator")?, &clone_name],
    )
    .await
    .context("Could not create isolated simulator")?;
    ensure!(
        simulator.len() == 36
            && simulator
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-'),
        "Invalid simulator id"
    );
    std::fs::write(root.join("simulator-id"), &simulator)?;
    let mut build = Command::new("/usr/bin/xcodebuild");
    build
        .current_dir(source)
        .arg(
            if container.extension().is_some_and(|e| e == "xcworkspace") {
                "-workspace"
            } else {
                "-project"
            },
        )
        .arg(&container)
        .args([
            "-scheme",
            field(&job, "scheme")?,
            "-destination",
            &format!("platform=iOS Simulator,id={simulator}"),
            "-derivedDataPath",
        ])
        .arg(root.join("DerivedData"))
        .arg("-resultBundlePath")
        .arg(root.join("results.xcresult"))
        .args([
            "-parallel-testing-enabled",
            "NO",
            "CODE_SIGNING_ALLOWED=NO",
            field(&job, "action")?,
        ]);
    let result = session.run(build).await;
    let _ = output("/usr/bin/xcrun", &["simctl", "shutdown", &simulator]).await;
    if output("/usr/bin/xcrun", &["simctl", "delete", &simulator])
        .await
        .is_some()
    {
        let _ = std::fs::remove_file(root.join("simulator-id"));
    }
    result
}
fn base64_encode(value: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(value)
}

pub async fn run_nomad(
    client: reqwest::Client,
    identity: Identity,
    root: PathBuf,
    job_id: String,
    attempt: String,
) -> Result<()> {
    ensure!(cfg!(target_os = "macos"), "Apple jobs require macOS");
    #[cfg(unix)]
    ensure!(
        unsafe { libc::geteuid() } != 0,
        "Run Apple jobs as a non-root macOS user"
    );
    uuid::Uuid::parse_str(&job_id)?;
    let allocation =
        std::env::var("NOMAD_ALLOC_ID").context("Apple jobs must run inside a Nomad allocation")?;
    uuid::Uuid::parse_str(&allocation)?;
    private_dir(&root)?;
    let url = format!(
        "{}/api/agent/{}/apple-jobs/{}/start",
        identity.api, identity.id, job_id
    );
    let started = tokio::time::Instant::now();
    let value: Value = loop {
        let response = client
            .post(&url)
            .timeout(Duration::from_secs(60))
            .bearer_auth(&identity.credential)
            .header("x-apple-attempt", &attempt)
            .json(&json!({"allocation_id":allocation}))
            .send()
            .await?;
        let status = response.status();
        if status == reqwest::StatusCode::OK {
            break response.json().await?;
        }
        if started.elapsed() > Duration::from_secs(90)
            || !matches!(status.as_u16(), 202 | 409 | 503)
        {
            anyhow::bail!("Nomad task authorization failed ({status})");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    };
    // Nomad reserves the Apple slot per node; clean only recorded leftovers from previous tasks.
    for entry in std::fs::read_dir(&root)?.flatten() {
        if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok() {
            let record = entry.path().join("simulator-id");
            if let Ok(sim) = std::fs::read_to_string(&record)
                && uuid::Uuid::parse_str(sim.trim()).is_ok()
            {
                let _ = output("/usr/bin/xcrun", &["simctl", "shutdown", sim.trim()]).await;
                if output("/usr/bin/xcrun", &["simctl", "delete", sim.trim()])
                    .await
                    .is_some()
                {
                    let _ = std::fs::remove_file(record);
                }
            }
        }
    }
    let job = &value["job"];
    let job_id = uuid::Uuid::parse_str(field(job, "id")?)?;
    let dir = root.join(job_id.to_string());
    private_dir(&dir)?;
    let mut session = Session {
        client: &client,
        identity: &identity,
        job,
        start: tokio::time::Instant::now(),
        log: String::new(),
    };
    let status = match execute(&mut session, &dir).await {
        Ok(true) => "succeeded",
        Ok(false) => "failed",
        Err(e) => {
            let msg = e.to_string();
            session.append(&msg);
            match msg.as_str() {
                "cancelled" => "cancelled",
                "timed_out" => "timed_out",
                _ => "failed",
            }
        }
    };
    std::fs::write(dir.join("build.log"), &session.log)?;
    let artifacts = dir.join("artifacts");
    private_dir(&artifacts)?;
    std::fs::copy(dir.join("build.log"), artifacts.join("build.log"))?;
    if dir.join("results.xcresult").exists() {
        std::fs::rename(
            dir.join("results.xcresult"),
            artifacts.join("results.xcresult"),
        )?;
    }
    let zip = dir.join("results.zip");
    let packed = Command::new("/usr/bin/ditto")
        .args(["-c", "-k", "--keepParent"])
        .arg(&artifacts)
        .arg(&zip)
        .kill_on_drop(true)
        .status();
    if tokio::time::timeout(Duration::from_secs(60), packed)
        .await
        .is_ok_and(|s| s.is_ok_and(|s| s.success()))
        && std::fs::metadata(&zip)?.len() <= 100 * 1024 * 1024
    {
        let uploaded = client
            .put(format!("{}/artifact", session.url()))
            .bearer_auth(&identity.credential)
            .header("x-apple-attempt", field(job, "attempt")?)
            .body(std::fs::read(&zip)?)
            .send()
            .await;
        if !uploaded.is_ok_and(|r| r.status().is_success()) {
            session.append("Artifact upload failed; local result retained.");
        }
    } else {
        session
            .append("Artifact exceeded upload limit or packaging failed; local result retained.");
    }
    let finished = client
        .post(session.url())
        .bearer_auth(&identity.credential)
        .header("x-apple-attempt", field(job, "attempt")?)
        .json(&json!({"status":status,"log":session.log}))
        .send()
        .await;
    if finished.is_ok_and(|r| r.status().is_success()) {
        // Source/build products are disposable; result files stay on the Mac for recovery.
        let _ = std::fs::remove_dir_all(dir.join("source"));
        let _ = std::fs::remove_dir_all(dir.join("DerivedData"));
    }
    ensure!(status == "succeeded", "Apple job finished with {status}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn job() -> Value {
        json!({"repository":"owner/repo","commit":"a".repeat(40),"container":"App/App.xcodeproj","scheme":"App","action":"test","timeout_seconds":1800})
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn loss_of_control_stops_command() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let identity = Identity {
            id: "local".into(),
            credential: "synthetic".into(),
            api: format!("http://{address}"),
        };
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap();
        let j = json!({"id":"local","attempt":"synthetic","timeout_seconds":60});
        let mut session = Session {
            client: &client,
            identity: &identity,
            job: &j,
            start: tokio::time::Instant::now(),
            log: String::new(),
        };
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & wait"]);
        let result = tokio::time::timeout(Duration::from_secs(3), session.run(command))
            .await
            .unwrap();
        assert_eq!(result.unwrap_err().to_string(), "cancelled");
    }
    #[test]
    fn rejects_path_escape_and_option_injection() {
        let mut j = job();
        assert!(valid(&j).is_ok());
        j["container"] = json!("../App.xcodeproj");
        assert!(valid(&j).is_err());
        j = job();
        j["scheme"] = json!("-allowProvisioningUpdates");
        assert!(valid(&j).is_err());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod native_smoke {
    use super::*;
    #[tokio::test]
    #[ignore = "runs Xcode and a simulator on an explicit disposable fixture"]
    async fn simulator_build_and_test() -> Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let source = PathBuf::from(std::env::var("PC_APPLE_SMOKE_SOURCE")?);
        let root = source.join("output");
        private_dir(&root)?;
        let cap = capability(true).await.context("macOS capability")?;
        let sim = cap["simulators"]
            .as_array()
            .and_then(|v| v.first())
            .context("Install an iOS simulator")?["id"]
            .as_str()
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let api = format!("http://{}", listener.local_addr()?);
        let server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut b = [0u8; 4096];
                    let _ = socket.read(&mut b).await;
                    let body = "{\"cancel\":false}";
                    let _=socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await;
                });
            }
        });
        let identity = Identity {
            id: "test".into(),
            credential: "synthetic".into(),
            api,
        };
        let job = json!({"id":uuid::Uuid::new_v4().to_string(),"attempt":"test","simulator":sim,"container":"AppleSmoke.xcodeproj","scheme":"AppleSmoke","action":"test","timeout_seconds":300});
        let client = reqwest::Client::new();
        let mut session = Session {
            client: &client,
            identity: &identity,
            job: &job,
            start: tokio::time::Instant::now(),
            log: String::new(),
        };
        let result = build_xcode(&mut session, &root, &source).await;
        std::fs::write(root.join("smoke.log"), &session.log)?;
        server.abort();
        ensure!(result?, "Xcode test failed; inspect smoke.log");
        ensure!(
            root.join("results.xcresult").exists(),
            "Missing test artifact"
        );
        ensure!(
            !root.join("simulator-id").exists(),
            "Simulator cleanup did not finish"
        );
        Ok(())
    }
}
