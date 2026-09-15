//! PostgreSQL always keeps the originally selected node and Docker volume.
//! Removal stops the owned job and archives volume ownership; it never deletes data.
use super::*;
use axum::http::header;
use reqwest::Method;
use std::collections::HashSet;

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/databases", post(create_database))
        .route(
            "/api/databases/{id}",
            axum::routing::delete(delete_database),
        )
        .route("/api/databases/{id}/connection", get(connection))
        .route("/api/databases/{id}/attach", post(attach))
        .route("/api/databases/{id}/retry", post(retry))
}
#[derive(Deserialize)]
struct NewDatabase {
    project_id: Uuid,
    name: String,
    #[serde(default)]
    machine_id: Option<Uuid>,
    #[serde(default)]
    service_ids: Vec<Uuid>,
}
#[derive(Deserialize)]
struct Attach {
    service_id: Uuid,
}
fn api_failure(_: impl std::fmt::Display) -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "Database operation failed; inspect its status and verify the selected machine and runtime"
            .into(),
    )
}
fn database_uri(id: Uuid, password: &str) -> String {
    let username = format!("pc_{}", id.simple());
    format!("postgresql://{username}:{password}@pending.invalid:5432/{username}?sslmode=disable")
}
fn endpoint_uri(uri: &str, address: &str, port: u16) -> anyhow::Result<String> {
    // An IP is observed through Nomad, never supplied by the browser. Only private fleet IPs are allowed.
    let ip: std::net::IpAddr = address
        .parse()
        .context("Scheduler returned an invalid database IP")?;
    ensure!(
        private_ip(ip),
        "Database address must stay on the private fleet network"
    );
    let mut uri = reqwest::Url::parse(uri)?;
    uri.set_ip_host(ip)
        .map_err(|_| anyhow::anyhow!("Invalid database host"))?;
    uri.set_port(Some(port))
        .map_err(|_| anyhow::anyhow!("Invalid database port"))?;
    Ok(uri.to_string())
}
fn private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => ip.is_private() || ip.is_loopback(),
        std::net::IpAddr::V6(ip) => ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00,
    }
}
fn eligible_database_node(node: &Value, machine: Uuid, node_id: &str) -> bool {
    node["ID"].as_str() == Some(node_id)
        && node["Meta"]["pc_machine_id"] == machine.to_string()
        && node["Meta"]["pc_database"] == "true"
        && node["Status"] == "ready"
        && node["SchedulingEligibility"] == "eligible"
        && node["Drivers"]["docker"]["Healthy"] == true
        && node["Drain"] != true
}
async fn select_machine(
    app: &App,
    cfg: &RuntimeConfig,
    requested: Option<Uuid>,
) -> anyhow::Result<(Uuid, String, String)> {
    let machines=sqlx::query("SELECT id,report FROM machines WHERE 'database'=ANY(roles) AND last_seen>now()-interval '45 seconds' AND report->>'docker'='true' AND report->>'nomad'='true' ORDER BY (SELECT count(*) FROM databases WHERE machine_id=machines.id),created_at").fetch_all(&app.db).await?;
    let inventory = nodes(app, cfg).await?;
    for machine in machines {
        let id: Uuid = machine.get("id");
        if requested.is_some_and(|requested| requested != id) {
            continue;
        }
        let report: Value = machine.get("report");
        let Some(node_id) = report["nomad_node_id"].as_str() else {
            continue;
        };
        if let Some(node) = inventory
            .iter()
            .find(|node| eligible_database_node(node, id, node_id))
        {
            let dc = node["Datacenter"].as_str().unwrap_or("dc1").to_string();
            return Ok((id, node_id.to_string(), dc));
        }
    }
    anyhow::bail!("Choose an online database-role machine with a ready Docker scheduler node")
}
async fn create_database(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<NewDatabase>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    owner(&app, &headers).await?;
    let name = crate::text_field(&input.name, 80)?;
    if input.service_ids.len() > 100 {
        return Err(invalid("Attach at most 100 services"));
    }
    let cfg = config(&app).await.map_err(invalid)?;
    let (machine, node, _dc) = select_machine(&app, &cfg, input.machine_id)
        .await
        .map_err(invalid)?;
    let id = Uuid::new_v4();
    let volume = format!("pc-postgres-{id}");
    let job = format!("pc-db-{id}");
    let encrypted = crypto::seal(
        &app,
        &format!("database:{id}"),
        &database_uri(id, &crate::token()),
    )
    .map_err(api_failure)?;
    let mut tx = app.db.begin().await?;
    if !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1)")
        .bind(input.project_id)
        .fetch_one(&mut *tx)
        .await?
    {
        return Err(ApiError(StatusCode::NOT_FOUND, "Project not found".into()));
    }
    let service_ids: HashSet<_> = input.service_ids.into_iter().collect();
    for service in &service_ids {
        if !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM services WHERE id=$1 AND project_id=$2)",
        )
        .bind(service)
        .bind(input.project_id)
        .fetch_one(&mut *tx)
        .await?
        {
            return Err(invalid("Attach services from this database's project"));
        }
        if sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM service_database_bindings WHERE service_id=$1)",
        )
        .bind(service)
        .fetch_one(&mut *tx)
        .await?
        {
            return Err(invalid(
                "A selected service already has a database attached",
            ));
        }
    }
    sqlx::query("INSERT INTO databases(id,project_id,name,machine_id,volume_name,status,job_id,nomad_node_id,connection_encrypted) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8)")
        .bind(id).bind(input.project_id).bind(name).bind(machine).bind(volume).bind(job).bind(node).bind(encrypted).execute(&mut *tx).await?;
    for service in service_ids {
        sqlx::query("INSERT INTO service_database_bindings(service_id,database_id) VALUES($1,$2)")
            .bind(service)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO events(kind,message) VALUES('database.queued',$1)")
        .bind("PostgreSQL provisioning queued on its selected machine")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"id":id,"status":"pending","machine_id":machine})),
    ))
}

fn database_job(
    id: Uuid,
    machine: Uuid,
    node: &str,
    dc: &str,
    volume: &str,
    uri: &str,
    port: Option<u16>,
) -> anyhow::Result<Value> {
    let uri = reqwest::Url::parse(uri)?;
    let database = uri.path().trim_start_matches('/');
    let job = format!("pc-db-{id}");
    let network = if let Some(port) = port {
        json!({"Mode":"host","ReservedPorts":[{"Label":"postgres","Value":port,"To":5432,"HostNetwork":"pc_private"}]})
    } else {
        json!({"Mode":"host","DynamicPorts":[{"Label":"postgres","To":5432,"HostNetwork":"pc_private"}]})
    };
    Ok(
        json!({"Job":{"ID":job,"Name":job,"Type":"service","Datacenters":[dc],"Meta":{"pc_managed":"true","pc_database_id":id.to_string()},
        "Constraints":[{"LTarget":"${node.unique.id}","Operand":"=","RTarget":node},{"LTarget":"${meta.pc_machine_id}","Operand":"=","RTarget":machine.to_string()},{"LTarget":"${meta.pc_database}","Operand":"=","RTarget":"true"}],
        "TaskGroups":[{"Name":"postgres","Count":1,"Networks":[network],
            "RestartPolicy":{"Attempts":3,"Interval":60000000000_u64,"Delay":5000000000_u64,"Mode":"delay"},
            "ReschedulePolicy":{"Attempts":0,"Unlimited":false},"Disconnect":{"Replace":false},
            "Update":{"MaxParallel":1,"Canary":0,"AutoRevert":false,"HealthCheck":"checks","MinHealthyTime":5000000000_u64,"HealthyDeadline":180000000000_u64,"ProgressDeadline":240000000000_u64},
            "Tasks":[{"Name":"postgres","Driver":"docker","Config":{"image":"postgres:17-alpine","ports":["postgres"],"volume_driver":"local","volumes":[format!("{volume}:/var/lib/postgresql/data")],"args":["postgres","-c","password_encryption=scram-sha-256"]},
                "Env":{"POSTGRES_USER":uri.username(),"POSTGRES_PASSWORD":uri.password().context("Database password is missing")?,"POSTGRES_DB":database,"POSTGRES_INITDB_ARGS":"--auth-host=scram-sha-256"},
                "Services":[{"Name":job,"Provider":"nomad","PortLabel":"postgres","Checks":[{"Name":"postgres-tcp","Type":"tcp","Interval":5000000000_u64,"Timeout":2000000000_u64}]}],
                "Resources":{"CPU":500,"MemoryMB":512},"LogConfig":{"MaxFiles":2,"MaxFileSizeMB":5},"KillTimeout":30000000000_u64}]}]}}),
    )
}
fn evaluation_request(job: &str) -> Value {
    json!({"JobID":job,"EvalOptions":{"ForceReschedule":true}})
}

async fn provision(app: &App, id: Uuid) -> anyhow::Result<()> {
    let mut lock = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("database:{id}"))
        .execute(&mut *lock)
        .await?;
    let row =
        sqlx::query("SELECT * FROM databases WHERE id=$1 AND status IN ('pending','provisioning')")
            .bind(id)
            .fetch_optional(&app.db)
            .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let cfg = config(app).await?;
    let machine: Uuid = row.get("machine_id");
    let node_id: String = row.get("nomad_node_id");
    let node = nomad(app, &cfg, Method::GET, &format!("/v1/node/{node_id}"), None).await?;
    ensure!(
        eligible_database_node(&node, machine, &node_id),
        "The database's pinned machine is offline or no longer eligible; no other machine will be used"
    );
    let job: String = row.get("job_id");
    ensure!(
        job == format!("pc-db-{id}"),
        "Database job ownership mismatch"
    );
    let volume: String = row.get("volume_name");
    let encrypted: String = row.get("connection_encrypted");
    let uri = crypto::open(app, &format!("database:{id}"), &encrypted)?;
    sqlx::query(
        "UPDATE databases SET status='provisioning',error=NULL,updated_at=now() WHERE id=$1",
    )
    .bind(id)
    .execute(&app.db)
    .await?;
    app.events.send(()).ok();
    let existing = nomad_raw(app, &cfg, Method::GET, &format!("/v1/job/{job}"), None).await?;
    if existing.0 == 404 {
        let spec = database_job(
            id,
            machine,
            &node_id,
            node["Datacenter"].as_str().unwrap_or("dc1"),
            &volume,
            &uri,
            row.get::<Option<i32>, _>("port").map(|p| p as u16),
        )?;
        nomad(app, &cfg, Method::POST, "/v1/jobs", Some(spec)).await?;
    } else {
        ensure!(
            existing.0 == 200,
            "Scheduler could not inspect the database job"
        );
        let existing: Value = serde_json::from_str(&existing.1)?;
        ensure!(
            existing["Meta"]["pc_database_id"] == id.to_string(),
            "The scheduler job belongs to another resource"
        );
        // This path only runs on initial recovery or an explicit owner retry. Placement stays pinned.
        nomad(
            app,
            &cfg,
            Method::POST,
            &format!("/v1/job/{job}/evaluate"),
            Some(evaluation_request(&job)),
        )
        .await?;
    }
    let allocation =
        super::deploy::wait_healthy(app, &cfg, &job, "postgres", Duration::from_secs(180)).await?;
    ensure!(
        allocation["NodeID"] == node_id,
        "Database allocation escaped its pinned node; refusing to publish credentials"
    );
    let (host, port) = registered_endpoint(
        app,
        &cfg,
        &job,
        allocation["ID"].as_str().context("Missing allocation ID")?,
    )
    .await?;
    let uri = endpoint_uri(&uri, &host, port)?;
    verify_postgres(app, &cfg, id, &node_id, &uri).await?;
    let encrypted = crypto::seal(app, &format!("database:{id}"), &uri)?;
    sqlx::query("UPDATE databases SET status='healthy',allocation_id=$2,address=$3,port=$4,connection_encrypted=$5,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status='provisioning'")
        .bind(id).bind(allocation["ID"].as_str()).bind(format!("{host}:{port}")).bind(i32::from(port)).bind(encrypted).execute(&app.db).await?;
    sqlx::query("INSERT INTO events(kind,message) VALUES('database.healthy','PostgreSQL accepted an authenticated query; attached services receive DATABASE_URL on their next deployment')").execute(&app.db).await?;
    lock.commit().await?;
    app.events.send(()).ok();
    Ok(())
}
async fn registered_endpoint(
    app: &App,
    cfg: &RuntimeConfig,
    job: &str,
    allocation: &str,
) -> anyhow::Result<(String, u16)> {
    let services = nomad(
        app,
        cfg,
        Method::GET,
        &format!("/v1/job/{job}/services"),
        None,
    )
    .await?;
    let service = services
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["AllocID"] == allocation))
        .context("Database service is not registered for its healthy allocation")?;
    let host = service["Address"]
        .as_str()
        .context("Missing private database address")?
        .to_string();
    let port = service["Port"]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .context("Invalid database port")? as u16;
    Ok((host, port))
}
fn probe_job(job: &str, node: &str, uri: &str) -> anyhow::Result<Value> {
    let uri = reqwest::Url::parse(uri)?;
    Ok(
        json!({"Job":{"ID":job,"Name":job,"Type":"batch","Datacenters":["dc1"],"Constraints":[{"LTarget":"${node.unique.id}","Operand":"=","RTarget":node}],
        "TaskGroups":[{"Name":"probe","Count":1,"RestartPolicy":{"Attempts":0,"Mode":"fail"},"ReschedulePolicy":{"Attempts":0,"Unlimited":false},
            "Tasks":[{"Name":"probe","Driver":"docker","Config":{"image":"postgres:17-alpine","network_mode":"host","command":"psql","args":["-w","-v","ON_ERROR_STOP=1","-tAc","SELECT 1"]},
                "Env":{"PGHOST":uri.host_str(),"PGPORT":uri.port().unwrap_or(5432).to_string(),"PGUSER":uri.username(),"PGPASSWORD":uri.password(),"PGDATABASE":uri.path().trim_start_matches('/'),"PGCONNECT_TIMEOUT":"5"},
                "Resources":{"CPU":100,"MemoryMB":64},"LogConfig":{"MaxFiles":1,"MaxFileSizeMB":1}}]}]}}),
    )
}
async fn verify_postgres(
    app: &App,
    cfg: &RuntimeConfig,
    id: Uuid,
    node: &str,
    uri: &str,
) -> anyhow::Result<()> {
    let job = format!("pc-db-probe-{id}-{}", Uuid::new_v4().simple());
    nomad(
        app,
        cfg,
        Method::POST,
        "/v1/jobs",
        Some(probe_job(&job, node, uri)?),
    )
    .await?;
    let result: anyhow::Result<()> = async {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        while tokio::time::Instant::now() < deadline {
            let list = nomad(
                app,
                cfg,
                Method::GET,
                &format!("/v1/job/{job}/allocations"),
                None,
            )
            .await?;
            for allocation in list.as_array().into_iter().flatten() {
                if allocation["ClientStatus"] == "failed" || allocation["ClientStatus"] == "lost" {
                    anyhow::bail!("PostgreSQL did not accept an authenticated query");
                }
                if allocation["ClientStatus"] == "complete" {
                    let alloc = allocation["ID"]
                        .as_str()
                        .context("Missing probe allocation")?;
                    let detail = nomad(
                        app,
                        cfg,
                        Method::GET,
                        &format!("/v1/allocation/{alloc}"),
                        None,
                    )
                    .await?;
                    ensure!(
                        detail["TaskStates"]["probe"]["Failed"] != true,
                        "PostgreSQL authentication probe failed"
                    );
                    let log =
                        super::deploy::allocation_logs(app, cfg, alloc, "probe", "stdout").await?;
                    ensure!(
                        log.lines().any(|line| line.trim() == "1"),
                        "PostgreSQL did not return the expected authenticated query result"
                    );
                    return Ok(());
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        anyhow::bail!("PostgreSQL authentication probe exceeded its deadline")
    }
    .await;
    let _ = nomad_raw(
        app,
        cfg,
        Method::DELETE,
        &format!("/v1/job/{job}?purge=true"),
        None,
    )
    .await;
    result
}

async fn connection(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<([(header::HeaderName, &'static str); 1], Json<Value>)> {
    owner(&app, &headers).await?;
    let row = sqlx::query("SELECT connection_encrypted,address,status FROM databases WHERE id=$1")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Database not found".into()))?;
    if row.get::<Option<String>, _>("address").is_none() {
        return Err(invalid("Database provisioning has not completed"));
    }
    let encrypted: String = row.get("connection_encrypted");
    let uri = crypto::open(&app, &format!("database:{id}"), &encrypted).map_err(api_failure)?;
    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"connection_string":uri,"url":uri,"status":row.get::<String,_>("status")})),
    ))
}
async fn attach(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<Attach>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let mut tx = app.db.begin().await?;
    let row = sqlx::query("SELECT project_id,status FROM databases WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Database not found".into()))?;
    let project: Uuid = row.get("project_id");
    if row.get::<String, _>("status") != "healthy" {
        return Err(invalid("Wait for a healthy database before attaching it"));
    }
    if !sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM services WHERE id=$1 AND project_id=$2)",
    )
    .bind(input.service_id)
    .bind(project)
    .fetch_one(&mut *tx)
    .await?
    {
        return Err(invalid("Choose a service in this database's project"));
    }
    sqlx::query("INSERT INTO service_database_bindings(service_id,database_id) VALUES($1,$2) ON CONFLICT(service_id) DO UPDATE SET database_id=excluded.database_id").bind(input.service_id).bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok(Json(
        json!({"ok":true,"message":"DATABASE_URL will be applied on the service's next deployment"}),
    ))
}
async fn retry(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let result=sqlx::query("UPDATE databases SET status='pending',error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 AND status IN ('failed','degraded')").bind(id).execute(&app.db).await?;
    if result.rows_affected() == 0 {
        return Err(invalid("Only failed or degraded databases can be retried"));
    }
    app.events.send(()).ok();
    Ok(Json(json!({"ok":true,"status":"pending"})))
}
async fn stop_database_job(
    app: &App,
    cfg: &RuntimeConfig,
    id: Uuid,
    job: &str,
) -> anyhow::Result<()> {
    ensure!(
        job == format!("pc-db-{id}"),
        "Refusing to stop an unowned scheduler job"
    );
    let existing = nomad_raw(app, cfg, Method::GET, &format!("/v1/job/{job}"), None).await?;
    if existing.0 != 404 {
        ensure!(
            existing.0 == 200,
            "Could not inspect database job ownership"
        );
        let existing: Value = serde_json::from_str(&existing.1)?;
        ensure!(
            existing["Meta"]["pc_database_id"] == id.to_string(),
            "Refusing to stop a scheduler job owned by another resource"
        );
        let (status, _) =
            nomad_raw(app, cfg, Method::DELETE, &format!("/v1/job/{job}"), None).await?;
        ensure!(
            (200..300).contains(&status) || status == 404,
            "Scheduler could not stop the database job"
        );
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let (status, text) = nomad_raw(
            app,
            cfg,
            Method::GET,
            &format!("/v1/job/{job}/allocations"),
            None,
        )
        .await?;
        if status == 404 {
            return Ok(());
        }
        ensure!(
            status == 200,
            "Could not confirm stopped database allocations"
        );
        let rows: Value = serde_json::from_str(&text)?;
        if allocations_stopped(&rows) {
            return Ok(());
        }
        ensure!(
            tokio::time::Instant::now() < deadline,
            "Database is still stopping; its volume and record are retained"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
fn allocations_stopped(allocations: &Value) -> bool {
    allocations.as_array().is_some_and(|rows| {
        rows.iter()
            .all(|row| matches!(row["ClientStatus"].as_str(), Some("complete" | "failed")))
    })
}
async fn delete_database(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(remove_database(&app, id).await?))
}
async fn remove_database(app: &App, id: Uuid) -> ApiResult<Value> {
    let mut lock = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("database:{id}"))
        .execute(&mut *lock)
        .await?;
    let row = sqlx::query("SELECT * FROM databases WHERE id=$1")
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Database not found".into()))?;
    sqlx::query("UPDATE databases SET status='deleting',error=NULL,lease_until=NULL,updated_at=now() WHERE id=$1").bind(id).execute(&app.db).await?;
    app.events.send(()).ok();
    let cfg = config(app).await.map_err(api_failure)?;
    let job: String = row.get("job_id");
    if stop_database_job(app, &cfg, id, &job).await.is_err() {
        sqlx::query("UPDATE databases SET status='delete_failed',error='Database shutdown could not be confirmed. The volume and ownership record are retained; retry removal.',updated_at=now() WHERE id=$1").bind(id).execute(&app.db).await?;
        app.events.send(()).ok();
        return Err(ApiError(StatusCode::BAD_GATEWAY,"Database shutdown could not be confirmed; its record and persistent volume are retained. Retry removal.".into()));
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO retained_database_volumes(database_id,project_id,machine_id,nomad_node_id,volume_name,connection_encrypted) SELECT id,project_id,machine_id,nomad_node_id,volume_name,connection_encrypted FROM databases WHERE id=$1 ON CONFLICT(database_id) DO NOTHING").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM service_database_bindings WHERE database_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM databases WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO events(kind,message) VALUES('database.removed','PostgreSQL stopped; its named Docker volume is retained on the original machine')").execute(&mut *tx).await?;
    tx.commit().await?;
    lock.commit().await?;
    app.events.send(()).ok();
    Ok(
        json!({"ok":true,"volume_preserved":true,"volume_name":row.get::<String,_>("volume_name"),"machine_id":row.get::<Uuid,_>("machine_id")}),
    )
}

pub fn spawn_controller(app: App) {
    let observation_app = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            if let Ok(ids) =
                sqlx::query_scalar::<_, Uuid>("SELECT id FROM databases WHERE status='deleting'")
                    .fetch_all(&observation_app.db)
                    .await
            {
                for id in ids {
                    let _ = remove_database(&observation_app, id).await;
                }
            }
            if observe_databases(&observation_app).await.is_err() {
                tracing::warn!("Database health observations are unavailable");
            }
        }
    });
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let selected:Result<Option<Uuid>,_>=sqlx::query_scalar("UPDATE databases SET lease_until=now()+interval '6 minutes' WHERE id=(SELECT id FROM databases WHERE status IN ('pending','provisioning') AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id").fetch_optional(&app.db).await;
            if let Ok(Some(id)) = selected {
                let result =
                    tokio::time::timeout(Duration::from_secs(300), provision(&app, id)).await;
                if !matches!(result, Ok(Ok(()))) {
                    let error = match result {
                        Ok(Err(error)) => error.to_string(),
                        Err(_) => "Database provisioning exceeded its deadline".into(),
                        _ => unreachable!(),
                    };
                    // Our errors contain IDs/status only; never propagate SQL auth errors or a connection URI.
                    tracing::warn!(database=%id,"Database provisioning failed");
                    let message = if error.contains("pinned") {
                        "The pinned database machine is unavailable. Data will not move automatically."
                    } else {
                        "Database provisioning or its authenticated health check failed. Data stays on the selected machine; inspect the runtime and retry."
                    };
                    let _=sqlx::query("UPDATE databases SET status='failed',error=$2,lease_until=NULL,updated_at=now() WHERE id=$1 AND status IN ('pending','provisioning')").bind(id).bind(message).execute(&app.db).await;
                    app.events.send(()).ok();
                }
            }
        }
    });
}
async fn observe_databases(app: &App) -> anyhow::Result<()> {
    let rows=sqlx::query("SELECT id,job_id,nomad_node_id,allocation_id,status FROM databases WHERE status IN ('healthy','degraded')").fetch_all(&app.db).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let cfg = config(app).await?;
    for row in rows {
        let id: Uuid = row.get("id");
        let job: String = row.get("job_id");
        let pinned: String = row.get("nomad_node_id");
        let observed = async {
            let allocations = nomad(
                app,
                &cfg,
                Method::GET,
                &format!("/v1/job/{job}/allocations"),
                None,
            )
            .await?;
            let allocation = allocations
                .as_array()
                .and_then(|rows| {
                    rows.iter().find(|a| {
                        a["ClientStatus"] == "running"
                            && a["DesiredStatus"] == "run"
                            && a["NodeID"] == pinned
                    })
                })
                .context("Database is not running on its original node")?;
            let alloc = allocation["ID"]
                .as_str()
                .context("Missing database allocation")?;
            ensure!(row.get::<Option<String>,_>("allocation_id").as_deref()==Some(alloc),"Database allocation changed; explicitly retry verification before deploying attached services");

            let checks = nomad(
                app,
                &cfg,
                Method::GET,
                &format!("/v1/client/allocation/{alloc}/checks"),
                None,
            )
            .await?;
            ensure!(
                checks.as_object().is_some_and(|checks| !checks.is_empty()
                    && checks.values().all(|c| c["Status"] == "success")),
                "Database health check failed"
            );
            Ok::<_, anyhow::Error>(alloc.to_string())
        }
        .await;
        let (status, error) = if observed.is_ok() {
            ("healthy", None)
        } else {
            (
                "degraded",
                Some(
                    "Database is unavailable on its original node; its persistent volume will not move automatically",
                ),
            )
        };
        sqlx::query("UPDATE databases SET status=$2,error=$3,updated_at=now() WHERE id=$1 AND status IN ('healthy','degraded')").bind(id).bind(status).bind(error).execute(&app.db).await?;
    }
    app.events.send(()).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn database_job_pins_both_node_and_machine_and_preserves_named_volume() {
        let id = Uuid::new_v4();
        let machine = Uuid::new_v4();
        let uri = database_uri(id, "test-password");
        let job = database_job(
            id,
            machine,
            "node-one",
            "dc1",
            "pc-postgres-test",
            &uri,
            Some(24321),
        )
        .unwrap();
        let constraints = job["Job"]["Constraints"].as_array().unwrap();
        assert!(
            constraints
                .iter()
                .any(|c| c["LTarget"] == "${node.unique.id}" && c["RTarget"] == "node-one")
        );
        assert!(constraints.iter().any(
            |c| c["LTarget"] == "${meta.pc_machine_id}" && c["RTarget"] == machine.to_string()
        ));
        let group = &job["Job"]["TaskGroups"][0];
        assert_eq!(group["ReschedulePolicy"]["Attempts"], 0);
        assert_eq!(group["ReschedulePolicy"]["Unlimited"], false);
        assert_eq!(group["Disconnect"]["Replace"], false);
        assert_eq!(
            group["Networks"][0]["ReservedPorts"][0]["HostNetwork"],
            "pc_private"
        );
        assert_eq!(
            group["Tasks"][0]["Config"]["volumes"][0],
            "pc-postgres-test:/var/lib/postgresql/data"
        );
        assert_eq!(group["Tasks"][0]["Config"]["volume_driver"], "local");
    }
    #[test]
    fn database_private_endpoint_and_generated_credentials_are_stable() {
        let id = Uuid::new_v4();
        let uri = database_uri(id, "secret123");
        let final_uri = endpoint_uri(&uri, "10.42.0.4", 25432).unwrap();
        let parsed = reqwest::Url::parse(&final_uri).unwrap();
        assert_eq!(parsed.password(), Some("secret123"));
        assert_eq!(parsed.port(), Some(25432));
        assert_eq!(parsed.username(), format!("pc_{}", id.simple()));
        assert!(endpoint_uri(&uri, "8.8.8.8", 5432).is_err());
        assert!(endpoint_uri(&uri, "attacker.example", 5432).is_err());
        assert!(endpoint_uri(&uri, "127.0.0.1", 5432).is_ok());
        assert!(endpoint_uri(&uri, "fd00::1", 5432).is_ok());
    }
    #[test]
    fn shutdown_requires_observed_terminal_allocations() {
        assert!(allocations_stopped(&json!([])));
        assert!(allocations_stopped(
            &json!([{"ClientStatus":"complete"},{"ClientStatus":"failed"}])
        ));
        for state in ["running", "pending", "lost", "unknown"] {
            assert!(!allocations_stopped(
                &json!([{"ClientStatus":state,"DesiredStatus":"stop"}])
            ));
        }
        assert!(!allocations_stopped(&Value::Null));
    }
    #[test]
    fn probe_runs_authenticated_query_without_password_arguments() {
        let id = Uuid::new_v4();
        let uri = endpoint_uri(&database_uri(id, "probe-secret"), "10.42.0.2", 25432).unwrap();
        let job = probe_job("pc-probe", "node-1", &uri).unwrap();
        let task = &job["Job"]["TaskGroups"][0]["Tasks"][0];
        assert_eq!(task["Env"]["PGPASSWORD"], "probe-secret");
        assert_eq!(task["Env"]["PGHOST"], "10.42.0.2");
        assert!(!task["Config"]["args"].to_string().contains("probe-secret"));
        assert!(task["Config"]["args"].to_string().contains("SELECT 1"));
    }
}

#[cfg(test)]
mod runtime_validation {
    use super::*;
    #[tokio::test]
    #[ignore = "requires PC_TEST_NOMAD_ADDR pointing to the owned disposable harness"]
    async fn nomad_accepts_stateful_job_and_authenticated_probe() -> anyhow::Result<()> {
        let base = std::env::var("PC_TEST_NOMAD_ADDR")?;
        let client = reqwest::Client::new();
        let id = Uuid::new_v4();
        let machine = Uuid::new_v4();
        let uri = database_uri(id, "validation-only-password");
        let specs = [
            database_job(
                id,
                machine,
                "00000000-0000-4000-8000-000000000001",
                "dc1",
                "pc-validation-volume",
                &uri,
                None,
            )?,
            probe_job(
                "pc-validation-probe",
                "00000000-0000-4000-8000-000000000001",
                &uri,
            )?,
        ];
        for spec in specs {
            let response = client
                .post(format!("{base}/v1/validate/job"))
                .json(&spec)
                .send()
                .await?;
            ensure!(
                response.status().is_success(),
                "Nomad job validation HTTP failure"
            );
            let result: Value = response.json().await?;
            ensure!(
                result["ValidationErrors"]
                    .as_array()
                    .is_none_or(|errors| errors.is_empty()),
                "Nomad validation errors: {}",
                result["ValidationErrors"]
            );
            ensure!(
                result["Error"].as_str().is_none_or(str::is_empty),
                "Nomad validation error: {}",
                result["Error"]
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod recovery_protocol_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires PC_TEST_NOMAD_ADDR pointing to the owned disposable harness"]
    async fn explicit_retry_evaluation_is_accepted_by_real_nomad() -> anyhow::Result<()> {
        let base = std::env::var("PC_TEST_NOMAD_ADDR")?;
        let client = reqwest::Client::new();
        let job = format!("pc-db-evaluation-test-{}", Uuid::new_v4());
        // A nonexistent node constraint ensures this protocol fixture never runs a task.
        let spec = probe_job(
            &job,
            &Uuid::new_v4().to_string(),
            &database_uri(Uuid::new_v4(), "protocol-test-only"),
        )?;
        let response = client
            .post(format!("{base}/v1/jobs"))
            .json(&spec)
            .send()
            .await?;
        ensure!(
            response.status().is_success(),
            "Could not register the isolated evaluation fixture"
        );
        let result: anyhow::Result<()> = async {
            let response = client
                .post(format!("{base}/v1/job/{job}/evaluate"))
                .json(&evaluation_request(&job))
                .send()
                .await?;
            ensure!(
                response.status().is_success(),
                "Nomad rejected the production database retry request"
            );
            let evaluation: Value = response.json().await?;
            ensure!(
                evaluation["EvalID"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty()),
                "Nomad did not create a retry evaluation"
            );
            Ok(())
        }
        .await;
        let cleanup = client
            .delete(format!("{base}/v1/job/{job}?purge=true"))
            .send()
            .await?;
        ensure!(
            cleanup.status().is_success(),
            "Could not remove the isolated evaluation fixture"
        );
        result
    }
}
