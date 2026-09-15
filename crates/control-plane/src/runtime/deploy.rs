use super::*;
use reqwest::Method;
use std::collections::HashSet;

pub async fn queue_deployment(
    app: &App,
    service_id: Uuid,
    commit: Option<String>,
    image: Option<String>,
) -> anyhow::Result<Value> {
    let cfg = config(app).await?;
    if cfg.require_cloudflare {
        ensure!(
            crate::integrations::registry_configuration(app)
                .await?
                .is_some(),
            "Connect Cloudflare and R2 before deploying"
        );
    }
    ensure!(
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM services WHERE id=$1)")
            .bind(service_id)
            .fetch_one(&app.db)
            .await?,
        "Service not found"
    );
    if let Some(ref image) = image {
        validate_image(image)?;
    }
    if let Some(ref sha) = commit {
        ensure!(
            sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid commit SHA"
        );
    }
    let mut tx = app.db.begin().await?;
    let state: String = sqlx::query_scalar("SELECT status FROM services WHERE id=$1 FOR UPDATE")
        .bind(service_id)
        .fetch_optional(&mut *tx)
        .await?
        .context("Service not found")?;
    ensure!(state != "deleting", "Service is being removed");
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO deployments(id,service_id,status,commit_sha,image_digest,previous_deployment_id) SELECT $1,id,'queued',$3,$4,current_deployment_id FROM services WHERE id=$2").bind(id).bind(service_id).bind(commit).bind(image).execute(&mut *tx).await.context("A deployment is already active for this service")?;
    tx.commit().await?;
    step(app, id, "queued", "Deployment queued").await?;
    app.events.send(()).ok();
    Ok(json!({"id":id,"status":"queued"}))
}
#[derive(Deserialize)]
pub struct DeployRequest {
    #[serde(default)]
    image: Option<String>,
    #[serde(default)]
    commit_sha: Option<String>,
}
pub async fn deploy_service(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<DeployRequest>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    owner(&app, &headers).await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(
            queue_deployment(&app, id, input.commit_sha, input.image)
                .await
                .map_err(invalid)?,
        ),
    ))
}
#[derive(Deserialize)]
pub struct RollbackRequest {
    deployment_id: Uuid,
}
pub async fn rollback_service(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<RollbackRequest>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    owner(&app, &headers).await?;
    let previous=sqlx::query("SELECT image_digest,commit_sha FROM deployments WHERE id=$1 AND service_id=$2 AND status IN ('healthy','rolled_back') AND image_digest IS NOT NULL").bind(input.deployment_id).bind(id).fetch_optional(&app.db).await?.ok_or_else(||invalid("Choose a previously healthy deployment"))?;
    let response = queue_deployment(
        &app,
        id,
        previous.get("commit_sha"),
        previous.get("image_digest"),
    )
    .await
    .map_err(invalid)?;
    let deployment: Uuid = serde_json::from_value(response["id"].clone()).map_err(invalid)?;
    sqlx::query("UPDATE deployments SET rollback_of=$1 WHERE id=$2")
        .bind(input.deployment_id)
        .bind(deployment)
        .execute(&app.db)
        .await?;
    Ok((StatusCode::ACCEPTED, Json(response)))
}
pub async fn step(app: &App, id: Uuid, name: &str, message: &str) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO deployment_steps(deployment_id,step,message) VALUES($1,$2,$3)")
        .bind(id)
        .bind(name)
        .bind(message.chars().take(8000).collect::<String>())
        .execute(&app.db)
        .await?;
    sqlx::query("UPDATE deployments SET step=$1,updated_at=now() WHERE id=$2")
        .bind(name)
        .bind(id)
        .execute(&app.db)
        .await?;
    app.events.send(()).ok();
    Ok(())
}
pub fn spawn_controller(app: App) {
    let observe = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        loop {
            tick.tick().await;
            if let Err(error) = reconcile_services(&observe).await {
                tracing::debug!(%error,"Service reconciliation waiting for runtime");
            }
        }
    });
    for _ in 0..4 {
        let app = app.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(2));
            loop {
                tick.tick().await;
                let selected:Result<Option<Uuid>,_>=sqlx::query_scalar("UPDATE deployments SET lease_until=now()+interval '60 seconds' WHERE id=(SELECT id FROM deployments WHERE status IN ('queued','building','deploying') AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id").fetch_optional(&app.db).await;
                if let Ok(Some(id)) = selected {
                    let lease_app = app.clone();
                    let lease = tokio::spawn(async move {
                        loop {
                            tokio::time::sleep(Duration::from_secs(15)).await;
                            let _=sqlx::query("UPDATE deployments SET lease_until=now()+interval '60 seconds' WHERE id=$1").bind(id).execute(&lease_app.db).await;
                        }
                    });
                    let result =
                        tokio::time::timeout(Duration::from_secs(1800), process(&app, id)).await;
                    lease.abort();
                    let error = match result {
                        Ok(Ok(())) => None,
                        Ok(Err(e)) => Some(e.to_string()),
                        Err(_) => Some("Deployment exceeded the 30-minute deadline".into()),
                    };
                    if let Some(error) = error {
                        let serving = sqlx::query_scalar::<_, bool>(
                            "SELECT EXISTS(SELECT 1 FROM services WHERE current_deployment_id=$1)",
                        )
                        .bind(id)
                        .fetch_one(&app.db)
                        .await
                        .unwrap_or(true);
                        if serving {
                            continue;
                        }
                        let _ = restore_routing(&app, id).await;
                        let _ = cleanup_failed(&app, id).await;
                        tracing::warn!(deployment=%id,error=%error,"Deployment failed");
                        let _ = step(&app, id, "failed", &error).await;
                        let _=sqlx::query("UPDATE deployments SET status='failed',error=$1,finished_at=now(),lease_until=NULL WHERE id=$2").bind(error).bind(id).execute(&app.db).await;
                        app.events.send(()).ok();
                    }
                }
            }
        });
    }
}

fn validate_image(image: &str) -> anyhow::Result<()> {
    let (repo, digest) = image
        .split_once("@sha256:")
        .context("Use an immutable image@sha256 digest")?;
    ensure!(
        !repo.is_empty()
            && !repo.contains(char::is_whitespace)
            && digest.len() == 64
            && digest.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid immutable image reference"
    );
    Ok(())
}
fn ready(node: &Value, role: &str) -> bool {
    node["Status"] == "ready"
        && node["SchedulingEligibility"] != "ineligible"
        && node["Meta"][format!("pc_{role}")] == "true"
        && node["Drivers"]["docker"]["Healthy"] == true
}
fn fits(node: &Value, placement: &Value) -> bool {
    match placement["kind"].as_str().unwrap_or("automatic") {
        "home" => node["Meta"]["pc_location"] == "home",
        "vps" => node["Meta"]["pc_location"] == "vps",
        "machine" => node["Meta"]["pc_machine_id"] == placement["machine_id"],
        _ => true,
    }
}
pub(super) async fn process(app: &App, id: Uuid) -> anyhow::Result<()> {
    let cfg = config(app).await?;
    let d:Value=sqlx::query_scalar("SELECT to_jsonb(d)||jsonb_build_object('service',to_jsonb(s),'project',to_jsonb(p)) FROM deployments d JOIN services s ON s.id=d.service_id JOIN projects p ON p.id=s.project_id WHERE d.id=$1").bind(id).fetch_one(&app.db).await?;
    let service = &d["service"];
    let project = &d["project"];
    let service_id = Uuid::parse_str(service["id"].as_str().context("Missing service")?)?;
    let project_id = Uuid::parse_str(project["id"].as_str().context("Missing project")?)?;
    let inventory = nodes(app, &cfg).await?;
    let target = inventory
        .iter()
        .find(|n| {
            ready(n, "compute")
                && fits(n, &service["placement"])
                && (service["architecture"] == "auto"
                    || service["architecture"] == n["Attributes"]["cpu.arch"])
        })
        .context("No healthy compute machine matches placement and architecture")?;
    let arch = target["Attributes"]["cpu.arch"].as_str().unwrap_or("amd64");
    let image = if let Some(image) = d["image_digest"].as_str() {
        validate_image(image)?;
        image.to_string()
    } else {
        let builder = inventory
            .iter()
            .find(|n| ready(n, "builder") && n["Attributes"]["cpu.arch"] == arch)
            .context("No healthy builder is available for this architecture")?;
        let repo = project["repository"]
            .as_str()
            .context("Missing repository")?;
        let source_token = crate::integrations::github_token(app).await?;
        let _ = crate::integrations::ensure_repository_webhook(app, repo).await;
        if cfg.require_cloudflare {
            provision_registry(app).await?;
        }
        let commit = if let Some(sha) = d["commit_sha"].as_str() {
            sha.to_owned()
        } else {
            let branch = project["branch"].as_str().unwrap_or("main");
            let mut url =
                reqwest::Url::parse(&format!("https://api.github.com/repos/{repo}/commits/"))?;
            url.path_segments_mut()
                .map_err(|_| anyhow::anyhow!("Invalid GitHub URL"))?
                .pop_if_empty()
                .push(branch);
            let mut req = app
                .client
                .get(url)
                .header("Accept", "application/vnd.github+json");
            if let Some(token) = &source_token {
                req = req.bearer_auth(token);
            }
            let res = req.send().await?;
            ensure!(
                res.status().is_success(),
                "GitHub could not resolve the production branch ({})",
                res.status()
            );
            res.json::<Value>().await?["sha"]
                .as_str()
                .context("GitHub returned no commit")?
                .to_string()
        };
        ensure!(
            commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid source commit"
        );
        sqlx::query(
            "UPDATE deployments SET status='building',commit_sha=$1,architecture=$2 WHERE id=$3",
        )
        .bind(&commit)
        .bind(arch)
        .bind(id)
        .execute(&app.db)
        .await?;
        step(
            app,
            id,
            "clone",
            "Scheduling source build on a builder machine",
        )
        .await?;
        let image = build_image(
            app,
            &cfg,
            BuildInput {
                id,
                service_id,
                service,
                repo,
                commit: &commit,
                arch,
                builder,
                source_token,
            },
        )
        .await?;
        sqlx::query("UPDATE deployments SET image_digest=$1 WHERE id=$2")
            .bind(&image)
            .bind(id)
            .execute(&app.db)
            .await?;
        let _ = nomad_raw(
            app,
            &cfg,
            Method::DELETE,
            &format!("/v1/job/pc-build-{id}?purge=true"),
            None,
        )
        .await;
        image
    };
    let env = environment(app, project_id, service_id).await?;
    let job_id = format!("pc-deploy-{id}");
    sqlx::query("UPDATE deployments SET status='deploying',job_id=$1,architecture=$2 WHERE id=$3")
        .bind(&job_id)
        .bind(arch)
        .bind(id)
        .execute(&app.db)
        .await?;
    step(
        app,
        id,
        "schedule",
        "Scheduling the new version; previous version remains running",
    )
    .await?;
    let job = application_job(&cfg, &job_id, service_id, &image, arch, service, env)?;
    nomad(app, &cfg, Method::POST, "/v1/jobs", Some(job)).await?;
    let allocation = wait_healthy(app, &cfg, &job_id, "app", Duration::from_secs(240)).await?;
    let allocation_id = allocation["ID"].as_str().context("Missing allocation")?;
    let node_id = allocation["NodeID"].as_str().context("Missing node")?;
    let address = allocation_address(app, &cfg, &job_id, allocation_id).await?;
    let node = nomad(app, &cfg, Method::GET, &format!("/v1/node/{node_id}"), None).await?;
    let machine_id = node["Meta"]["pc_machine_id"]
        .as_str()
        .and_then(|v| Uuid::parse_str(v).ok());
    let machine_id = if let Some(id) = machine_id {
        if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM machines WHERE id=$1)")
            .bind(id)
            .fetch_one(&app.db)
            .await?
        {
            Some(id)
        } else {
            None
        }
    } else {
        None
    };
    step(
        app,
        id,
        "health",
        "Health check passed; promoting this version",
    )
    .await?;
    // Public routing can stage the checked target while the durable current version stays intact.
    sqlx::query("UPDATE services SET promotion_deployment_id=$1,promotion_address=$2 WHERE id=$3")
        .bind(id)
        .bind(&address)
        .bind(service_id)
        .execute(&app.db)
        .await?;
    if let Err(error) = crate::integrations::refresh_service_domains(app, service_id).await {
        restore_routing(app, id).await?;
        anyhow::bail!("Domain routing could not switch: {error}. Previous version retained");
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("UPDATE services SET current_deployment_id=$1,address=$2,machine_id=$3,image_digest=$4,status='healthy',promotion_deployment_id=NULL,promotion_address=NULL,unhealthy_since=NULL WHERE id=$5").bind(id).bind(&address).bind(machine_id).bind(&image).bind(service_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE deployments SET status='healthy',step='healthy',allocation_id=$1,machine_id=$2,finished_at=now(),lease_until=NULL WHERE id=$3").bind(allocation_id).bind(machine_id).bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO events(kind,message) VALUES('deployment.healthy',$1)")
        .bind(format!(
            "{} deployed successfully",
            service["name"].as_str().unwrap_or("Service")
        ))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // Cleanup is retryable housekeeping after the atomic healthy commit, never a failed deployment.
    let _ = cleanup_superseded(app, &cfg, service_id).await;
    let _ = step(app, id, "healthy", "Deployment successful").await;
    app.events.send(()).ok();
    Ok(())
}
fn application_job(
    cfg: &RuntimeConfig,
    job_id: &str,
    service_id: Uuid,
    image: &str,
    arch: &str,
    service: &Value,
    mut env: serde_json::Map<String, Value>,
) -> anyhow::Result<Value> {
    validate_image(image)?;
    let placement: personal_cloud_core::Placement =
        serde_json::from_value(service["placement"].clone())?;
    let mut job =
        personal_cloud_core::nomad_job(&service_id.to_string(), image, arch, placement, false)?;
    job["Job"]["ID"] = json!(job_id);
    job["Job"]["Name"] = json!(job_id);
    let port = service["port"].as_i64().unwrap_or(3000);
    env.insert("PORT".into(), json!(port.to_string()));
    let group = &mut job["Job"]["TaskGroups"][0];
    group["Networks"] = json!([{"Mode":"host","DynamicPorts":[{"Label":"http","To":port,"HostNetwork":"pc_private"}]}]);
    group["RestartPolicy"] =
        json!({"Attempts":3,"Interval":60000000000_u64,"Delay":5000000000_u64,"Mode":"delay"});
    group["ReschedulePolicy"] = json!({"Unlimited":true,"Delay":5000000000_u64,"DelayFunction":"exponential","MaxDelay":60000000000_u64});
    let task = &mut group["Tasks"][0];
    task["Env"] = json!(env);
    task["Config"]["ports"] = json!(["http"]);
    task["Config"]["cap_drop"] = json!(["ALL"]);
    if let (Some(username), Some(password)) = (&cfg.registry_username, &cfg.registry_password) {
        task["Config"]["auth"] = json!({"username":username,"password":password});
    }
    task["Resources"] = json!({"CPU":service["cpu_mhz"].as_i64().unwrap_or(500),"MemoryMB":service["memory_mb"].as_i64().unwrap_or(256)});
    // A probe must not race an application's idle keep-alive timeout and report a false EOF.
    task["Services"] = json!([{"Name":format!("pc-{service_id}"),"Provider":"nomad","PortLabel":"http","Checks":[{"Name":"ready","Type":"http","Header":{"Connection":["close"]},"Path":service["health_path"].as_str().unwrap_or("/"),"Interval":5000000000_u64,"Timeout":2000000000_u64}]}]);
    Ok(job)
}
struct BuildInput<'a> {
    id: Uuid,
    service_id: Uuid,
    service: &'a Value,
    repo: &'a str,
    commit: &'a str,
    arch: &'a str,
    builder: &'a Value,
    source_token: Option<String>,
}
async fn build_image(
    app: &App,
    cfg: &RuntimeConfig,
    input: BuildInput<'_>,
) -> anyhow::Result<String> {
    let BuildInput {
        id,
        service_id,
        service,
        repo,
        commit,
        arch,
        builder,
        source_token,
    } = input;
    let registry = reqwest::Url::parse(&cfg.registry_url)?;
    let host = registry.host_str().context("Invalid registry")?;
    let host = if let Some(port) = registry.port() {
        format!("{host}:{port}")
    } else {
        host.to_string()
    };
    let tag = format!("{host}/personal-cloud/{service_id}:{id}");
    let mut env = json!({"PC_REPOSITORY":repo,"PC_COMMIT":commit,"PC_IMAGE_TAG":tag,"PC_REGISTRY_HOST":host,"PC_SERVICE_ID":service_id,"PC_ROOT_DIRECTORY":service["root_directory"].as_str().unwrap_or("."),"PC_PLATFORM":format!("linux/{arch}"),"PC_INSECURE_REGISTRY":cfg.allow_insecure_registry.to_string(),"BUILDKIT_HOST":cfg.buildkit_address});
    if let Some(token) = source_token {
        env["PC_SOURCE_TOKEN"] = json!(token);
    }
    if let Some(value) = &cfg.registry_username {
        env["PC_REGISTRY_USERNAME"] = json!(value);
    }
    if let Some(value) = &cfg.registry_password {
        env["PC_REGISTRY_PASSWORD"] = json!(value);
    }
    let job_id = format!("pc-build-{id}");
    let job = json!({"Job":{"ID":job_id,"Name":job_id,"Type":"batch","Datacenters":["dc1"],"Constraints":[{"LTarget":"${meta.pc_builder}","Operand":"=","RTarget":"true"},{"LTarget":"${attr.cpu.arch}","Operand":"=","RTarget":arch},{"LTarget":"${node.unique.id}","Operand":"=","RTarget":builder["ID"]}],"TaskGroups":[{"Name":"build","Count":1,"RestartPolicy":{"Attempts":0,"Mode":"fail"},"ReschedulePolicy":{"Attempts":0,"Unlimited":false},"Tasks":[{"Name":"build","Driver":"docker","Config":{"image":cfg.builder_image,"network_mode":"host","force_pull":false},"Env":env,"Resources":{"CPU":1000,"MemoryMB":1024},"LogConfig":{"MaxFiles":2,"MaxFileSizeMB":5}}]}]}});
    let existing = nomad_raw(app, cfg, Method::GET, &format!("/v1/job/{job_id}"), None).await?;
    if existing.0 == 404 {
        nomad(app, cfg, Method::POST, "/v1/jobs", Some(job)).await?;
    } else {
        ensure!(existing.0 == 200, "Build scheduler is unavailable");
    }
    let mut seen = HashSet::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1200);
    loop {
        ensure!(
            tokio::time::Instant::now() < deadline,
            "Build exceeded 20-minute deadline"
        );
        let list = nomad(
            app,
            cfg,
            Method::GET,
            &format!("/v1/job/{job_id}/allocations"),
            None,
        )
        .await?;
        if let Some(alloc) = list
            .as_array()
            .and_then(|v| v.iter().max_by_key(|a| a["CreateIndex"].as_u64()))
        {
            let alloc_id = alloc["ID"].as_str().context("Missing build allocation")?;
            let mut stdout = String::new();
            for kind in ["stdout", "stderr"] {
                if let Ok(log) = allocation_logs(app, cfg, alloc_id, "build", kind).await {
                    if kind == "stdout" {
                        stdout = log.clone();
                    }
                    for line in log.lines() {
                        if seen.len() < 5000 && seen.insert(line.to_string()) {
                            let (name, msg) = if let Some(value) = line.strip_prefix("PC_STEP=") {
                                value.split_once(' ').unwrap_or(("build", value))
                            } else {
                                ("log", line)
                            };
                            if !line.starts_with("PC_IMAGE=") {
                                step(app, id, name, msg).await?;
                            }
                        }
                    }
                }
            }
            match alloc["ClientStatus"].as_str() {
                Some("complete") => {
                    let image = stdout
                        .lines()
                        .rev()
                        .find_map(|l| l.strip_prefix("PC_IMAGE="))
                        .context("Build completed without a verified image digest")?;
                    validate_image(image)?;
                    ensure!(
                        image.starts_with(&format!("{host}/personal-cloud/{service_id}@")),
                        "Builder returned unexpected image repository"
                    );
                    step(app, id, "upload", "Immutable image uploaded to registry").await?;
                    return Ok(image.into());
                }
                Some("failed" | "lost") => {
                    if let Some(events) = alloc["TaskStates"]["build"]["Events"].as_array() {
                        for event in events.iter().rev().take(5) {
                            if let Some(message) = event["DisplayMessage"].as_str() {
                                step(
                                    app,
                                    id,
                                    "build_error",
                                    &super::observability::redact(
                                        message,
                                        env.as_object().context("Invalid build environment")?,
                                    ),
                                )
                                .await?;
                            }
                        }
                    }
                    anyhow::bail!("Application build failed; inspect deployment logs")
                }
                _ => {}
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
pub async fn wait_healthy(
    app: &App,
    cfg: &RuntimeConfig,
    job: &str,
    task: &str,
    timeout: Duration,
) -> anyhow::Result<Value> {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        let list = nomad(
            app,
            cfg,
            Method::GET,
            &format!("/v1/job/{job}/allocations"),
            None,
        )
        .await?;
        for alloc in list.as_array().into_iter().flatten().rev() {
            if alloc["DesiredStatus"] == "stop" {
                continue;
            }
            if alloc["ClientStatus"] == "running" {
                let id = alloc["ID"].as_str().context("Missing allocation ID")?;
                let detail =
                    nomad(app, cfg, Method::GET, &format!("/v1/allocation/{id}"), None).await?;
                if detail["TaskStates"][task]["State"] != "running" {
                    continue;
                }
                if let Ok(checks) = nomad(
                    app,
                    cfg,
                    Method::GET,
                    &format!("/v1/client/allocation/{id}/checks"),
                    None,
                )
                .await
                    && let Some(checks) = checks.as_object()
                    && !checks.is_empty()
                    && checks.values().all(|c| c["Status"] == "success")
                {
                    return Ok(detail);
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    anyhow::bail!("Health check deadline exceeded; previous healthy deployment retained")
}
pub async fn allocation_address(
    app: &App,
    cfg: &RuntimeConfig,
    job: &str,
    allocation: &str,
) -> anyhow::Result<String> {
    let list = nomad(
        app,
        cfg,
        Method::GET,
        &format!("/v1/job/{job}/services"),
        None,
    )
    .await?;
    let svc = list
        .as_array()
        .and_then(|v| v.iter().find(|s| s["AllocID"] == allocation))
        .context("Healthy allocation has no registered private address")?;
    Ok(format!(
        "http://{}:{}",
        svc["Address"].as_str().context("Missing service address")?,
        svc["Port"].as_u64().context("Missing service port")?
    ))
}
pub async fn service_address(app: &App, id: Uuid) -> anyhow::Result<String> {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT COALESCE(promotion_address,address) FROM services WHERE id=$1 AND (current_deployment_id IS NOT NULL OR promotion_deployment_id IS NOT NULL)",
    )
    .bind(id)
    .fetch_optional(&app.db)
    .await?
    .flatten()
    .context("Deploy a healthy service first")
}
pub async fn allocation_logs(
    app: &App,
    cfg: &RuntimeConfig,
    alloc: &str,
    task: &str,
    kind: &str,
) -> anyhow::Result<String> {
    let (status, text) = nomad_raw(
        app,
        cfg,
        Method::GET,
        &format!(
            "/v1/client/fs/logs/{alloc}?task={task}&type={kind}&plain=true&origin=end&offset=65536"
        ),
        None,
    )
    .await?;
    ensure!(status == 200, "Logs are not yet available");
    Ok(text)
}
pub async fn deployment_detail(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let mut d: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM deployments d WHERE id=$1")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| invalid("Deployment not found"))?;
    let steps:Vec<Value>=sqlx::query_scalar("SELECT to_jsonb(s) FROM (SELECT * FROM deployment_steps WHERE deployment_id=$1 ORDER BY id DESC LIMIT 1000) s ORDER BY id").bind(id).fetch_all(&app.db).await?;
    d["steps"] = json!(steps);
    Ok(Json(d))
}
pub async fn service_logs(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let alloc:String=sqlx::query_scalar("SELECT d.allocation_id FROM services s JOIN deployments d ON d.id=s.current_deployment_id WHERE s.id=$1 AND d.allocation_id IS NOT NULL").bind(id).fetch_optional(&app.db).await?.ok_or_else(||invalid("No running deployment"))?;
    let cfg = config(&app).await.map_err(invalid)?;
    let project: Uuid = sqlx::query_scalar("SELECT project_id FROM services WHERE id=$1")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    let env = read_environment(&app, project, id, false)
        .await
        .map_err(invalid)?;
    let mut lines = Vec::new();
    for kind in ["stdout", "stderr"] {
        if let Ok(log) = allocation_logs(&app, &cfg, &alloc, "app", kind).await {
            lines.extend(log.lines().map(
                |line| json!({"stream":kind,"message":super::observability::redact(line,&env)}),
            ));
        }
    }
    Ok(Json(json!({"lines":lines,"allocation_id":alloc})))
}
pub async fn service_metrics(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let alloc:String=sqlx::query_scalar("SELECT d.allocation_id FROM services s JOIN deployments d ON d.id=s.current_deployment_id WHERE s.id=$1 AND d.allocation_id IS NOT NULL").bind(id).fetch_optional(&app.db).await?.ok_or_else(||invalid("No running deployment"))?;
    let cfg = config(&app).await.map_err(invalid)?;
    Ok(Json(
        nomad(
            &app,
            &cfg,
            Method::GET,
            &format!("/v1/client/allocation/{alloc}/stats"),
            None,
        )
        .await
        .map_err(invalid)?,
    ))
}
async fn reconcile_services(app: &App) -> anyhow::Result<()> {
    let cfg = config(app).await?;
    let failed:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM deployments WHERE status='failed' AND stopped_at IS NULL ORDER BY created_at LIMIT 20").fetch_all(&app.db).await?;
    for id in failed {
        let _ = cleanup_failed(app, id).await;
    }

    let rows=sqlx::query("SELECT s.id,s.current_deployment_id,s.unhealthy_since,d.job_id,d.rollback_of FROM services s JOIN deployments d ON d.id=s.current_deployment_id WHERE d.job_id IS NOT NULL AND s.status<>'deleting'").fetch_all(&app.db).await?;
    for row in rows {
        let id: Uuid = row.get("id");
        let deployment: Uuid = row.get("current_deployment_id");
        let _ = cleanup_superseded(app, &cfg, id).await;
        let job: String = row.get("job_id");
        let list = nomad(
            app,
            &cfg,
            Method::GET,
            &format!("/v1/job/{job}/allocations"),
            None,
        )
        .await?;
        let running = list.as_array().and_then(|v| {
            v.iter()
                .filter(|a| a["ClientStatus"] == "running" && a["DesiredStatus"] == "run")
                .max_by_key(|a| a["CreateIndex"].as_u64())
        });
        let mut healthy = false;
        if let Some(alloc) = running {
            let allocation = alloc["ID"].as_str().context("Missing allocation")?;
            let checks = nomad(
                app,
                &cfg,
                Method::GET,
                &format!("/v1/client/allocation/{allocation}/checks"),
                None,
            )
            .await?;
            healthy = checks
                .as_object()
                .is_some_and(|c| !c.is_empty() && c.values().all(|v| v["Status"] == "success"));
            if healthy {
                let addr = allocation_address(app, &cfg, &job, allocation).await?;
                let node = nomad(
                    app,
                    &cfg,
                    Method::GET,
                    &format!(
                        "/v1/node/{}",
                        alloc["NodeID"].as_str().context("Missing node")?
                    ),
                    None,
                )
                .await?;
                let machine = node["Meta"]["pc_machine_id"]
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok());
                let changed=sqlx::query("UPDATE services SET address=$1,machine_id=(SELECT id FROM machines WHERE id=$2) WHERE id=$3 AND current_deployment_id=$4 AND (address IS DISTINCT FROM $1 OR machine_id IS DISTINCT FROM $2)").bind(&addr).bind(machine).bind(id).bind(deployment).execute(&app.db).await?.rows_affected()>0;
                if changed {
                    crate::integrations::refresh_service_domains(app, id).await?;
                }
                sqlx::query("UPDATE deployments SET allocation_id=$1,machine_id=(SELECT id FROM machines WHERE id=$2) WHERE id=$3").bind(allocation).bind(machine).bind(deployment).execute(&app.db).await?;
            }
        }
        sqlx::query("UPDATE services SET status=$1,unhealthy_since=CASE WHEN $2 THEN NULL ELSE COALESCE(unhealthy_since,now()) END WHERE id=$3 AND current_deployment_id=$4 AND status<>'deleting'").bind(if healthy{"healthy"}else{"degraded"}).bind(healthy).bind(id).bind(deployment).execute(&app.db).await?;
        // Node loss is handled by Nomad rescheduling. Rollback only an unhealthy running release.
        if !healthy
            && running.is_some()
            && row.get::<Option<Uuid>, _>("rollback_of").is_none()
            && row
                .get::<Option<chrono::DateTime<chrono::Utc>>, _>("unhealthy_since")
                .is_some_and(|t| chrono::Utc::now() - t > chrono::Duration::seconds(45))
        {
            let prior=sqlx::query("SELECT id,image_digest,commit_sha FROM deployments WHERE service_id=$1 AND status='healthy' AND id<>$2 ORDER BY created_at DESC LIMIT 1").bind(id).bind(deployment).fetch_optional(&app.db).await?;
            if let Some(prior) = prior
                && let Ok(queued) =
                    queue_deployment(app, id, prior.get("commit_sha"), prior.get("image_digest"))
                        .await
            {
                let queued = Uuid::parse_str(queued["id"].as_str().context("Missing rollback")?)?;
                sqlx::query("UPDATE deployments SET rollback_of=$1 WHERE id=$2")
                    .bind(prior.get::<Uuid, _>("id"))
                    .bind(queued)
                    .execute(&app.db)
                    .await?;
                step(
                    app,
                    queued,
                    "rollback",
                    "Current release failed health checks; restoring the previous immutable image",
                )
                .await?;
            }
        }
    }
    app.events.send(()).ok();
    Ok(())
}
pub async fn run_tunnel(app: &App, tunnel_id: &str, token: &str) -> anyhow::Result<()> {
    let parsed = Uuid::parse_str(tunnel_id)?;
    let cfg = config(app).await?;
    let name = format!("pc-tunnel-{parsed}");
    let job = json!({"Job":{"ID":name,"Name":name,"Type":"service","Datacenters":["dc1"],"Constraints":[{"LTarget":"${meta.pc_compute}","Operand":"=","RTarget":"true"}],"TaskGroups":[{"Name":"tunnel","Count":1,"Tasks":[{"Name":"cloudflared","Driver":"docker","Config":{"image":"cloudflare/cloudflared:2026.9.1","args":["tunnel","--no-autoupdate","run"],"network_mode":"host"},"Env":{"TUNNEL_TOKEN":token},"Resources":{"CPU":100,"MemoryMB":128}}]}]}});
    nomad(app, &cfg, Method::POST, "/v1/jobs", Some(job)).await?;
    Ok(())
}
pub async fn stop_tunnel(app: &App, tunnel_id: &str) -> anyhow::Result<()> {
    let id = Uuid::parse_str(tunnel_id)?;
    let cfg = config(app).await?;
    let (status, _) = nomad_raw(
        app,
        &cfg,
        Method::DELETE,
        &format!("/v1/job/pc-tunnel-{id}?purge=true"),
        None,
    )
    .await?;
    ensure!(
        (200..300).contains(&status) || status == 404,
        "Could not stop tunnel connector"
    );
    Ok(())
}
pub async fn bootstrap_registry(
    State(app): State<App>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    provision_registry(&app).await.map_err(invalid)?;
    Ok(Json(json!({"ok":true})))
}
async fn provision_registry(app: &App) -> anyhow::Result<()> {
    let r2 = crate::integrations::registry_configuration(app)
        .await?
        .context("Connect Cloudflare R2 credentials first")?;
    let cfg = config(app).await?;
    let registry = reqwest::Url::parse(&cfg.registry_url)?;
    let port = registry.port().unwrap_or(5000);
    let inventory = nodes(app, &cfg).await?;
    let registry_host = registry.host_str().context("Missing registry hostname")?;
    let node = inventory
        .iter()
        .find(|n| {
            ready(n, "compute")
                && (n["Meta"]["pc_private_ip"] == registry_host
                    || n["Address"] == registry_host
                    || n["HTTPAddr"]
                        .as_str()
                        .is_some_and(|a| a.split(':').next() == Some(registry_host)))
        })
        .context("Registry address must match a connected compute machine's private IP")?;
    let job = json!({"Job":{"ID":"pc-registry","Name":"pc-registry","Type":"service","Datacenters":["dc1"],"Constraints":[{"LTarget":"${node.unique.id}","Operand":"=","RTarget":node["ID"]}],"TaskGroups":[{"Name":"registry","Count":1,"Networks":[{"Mode":"host","ReservedPorts":[{"Label":"registry","Value":port,"To":5000,"HostNetwork":"pc_private"}]}],"Tasks":[{"Name":"registry","Driver":"docker","Config":{"image":"registry:3","ports":["registry"]},"Env":{"REGISTRY_STORAGE":"s3","REGISTRY_STORAGE_S3_ACCESSKEY":r2["access_key_id"],"REGISTRY_STORAGE_S3_SECRETKEY":r2["secret_access_key"],"REGISTRY_STORAGE_S3_BUCKET":r2["bucket"],"REGISTRY_STORAGE_S3_REGION":"auto","REGISTRY_STORAGE_S3_REGIONENDPOINT":format!("https://{}.r2.cloudflarestorage.com",r2["account_id"].as_str().context("Missing R2 account")?),"REGISTRY_STORAGE_S3_FORCEPATHSTYLE":"true","REGISTRY_STORAGE_REDIRECT_DISABLE":"true"},"Services":[{"Name":"pc-registry","Provider":"nomad","PortLabel":"registry","Checks":[{"Name":"ready","Type":"http","Path":"/v2/","Interval":5000000000_u64,"Timeout":2000000000_u64}]}],"Resources":{"CPU":200,"MemoryMB":256}}]}]}});
    nomad(app, &cfg, Method::POST, "/v1/jobs", Some(job)).await?;
    wait_healthy(
        app,
        &cfg,
        "pc-registry",
        "registry",
        Duration::from_secs(180),
    )
    .await?;
    Ok(())
}

pub(super) async fn cleanup_failed(app: &App, id: Uuid) -> anyhow::Result<()> {
    let cfg = config(app).await?;
    let current: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM services WHERE current_deployment_id=$1)")
            .bind(id)
            .fetch_one(&app.db)
            .await?;
    if current {
        return Ok(());
    }
    let protected:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM domains d JOIN services s ON s.id=d.service_id JOIN deployments p ON p.service_id=d.service_id WHERE p.id=$1 AND (d.configuration_applied=false OR d.upstream IS DISTINCT FROM s.address OR s.promotion_deployment_id IS NOT NULL))").bind(id).fetch_one(&app.db).await?;
    if !protected {
        let (status, _) = nomad_raw(
            app,
            &cfg,
            Method::DELETE,
            &format!("/v1/job/pc-deploy-{id}"),
            None,
        )
        .await?;
        if (200..300).contains(&status) || status == 404 {
            sqlx::query("UPDATE deployments SET stopped_at=now() WHERE id=$1")
                .bind(id)
                .execute(&app.db)
                .await?;
        }
    }
    let _ = nomad_raw(
        app,
        &cfg,
        Method::DELETE,
        &format!("/v1/job/pc-build-{id}?purge=true"),
        None,
    )
    .await;
    Ok(())
}

pub(super) async fn restore_routing(app: &App, deployment: Uuid) -> anyhow::Result<()> {
    let mut tx = app.db.begin().await?;
    let service: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM services WHERE promotion_deployment_id=$1 FOR UPDATE")
            .bind(deployment)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(service) = service {
        // The edge may already serve this target. Keep it alive until reverting is acknowledged.
        sqlx::query("UPDATE domains SET configuration_applied=false WHERE service_id=$1")
            .bind(service)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE services SET promotion_deployment_id=NULL,promotion_address=NULL WHERE id=$1",
        )
        .bind(service)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    if let Some(service) = service {
        crate::integrations::refresh_service_domains(app, service).await?;
    }
    Ok(())
}
async fn cleanup_superseded(app: &App, cfg: &RuntimeConfig, service: Uuid) -> anyhow::Result<()> {
    let jobs:Vec<String>=sqlx::query_scalar("SELECT d.job_id FROM deployments d JOIN services s ON s.id=d.service_id WHERE s.id=$1 AND d.status='healthy' AND d.id<>s.current_deployment_id AND d.job_id IS NOT NULL AND d.stopped_at IS NULL AND (s.promotion_deployment_id IS NULL OR d.id<>s.promotion_deployment_id)").bind(service).fetch_all(&app.db).await?;
    for job in jobs {
        let (status, _) =
            nomad_raw(app, cfg, Method::DELETE, &format!("/v1/job/{job}"), None).await?;
        if (200..300).contains(&status) || status == 404 {
            sqlx::query("UPDATE deployments SET stopped_at=now() WHERE job_id=$1")
                .bind(job)
                .execute(&app.db)
                .await?;
        }
    }
    Ok(())
}
