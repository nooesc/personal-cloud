mod crypto;
mod github_app;
mod integrations;
mod networking;
mod runtime;
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, State,
        ws::{Message, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use personal_cloud_core::{MachineReport, Placement, github_repository};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use std::{env, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::sync::broadcast;
use uuid::Uuid;

#[derive(Clone)]
struct App {
    db: PgPool,
    admin_hash: Arc<String>,
    origin: Arc<String>,
    events: broadcast::Sender<()>,
    client: reqwest::Client,
    secret_key: Arc<[u8; 32]>,
}
#[derive(Debug)]
struct ApiError(StatusCode, String);
type ApiResult<T> = Result<T, ApiError>;
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error=%e,"Database operation failed");
        if e.as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            return Self(StatusCode::CONFLICT, "This record already exists".into());
        }
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Database operation failed".into(),
        )
    }
}
fn invalid(message: impl ToString) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.to_string())
}
fn unauthorized() -> ApiError {
    ApiError(StatusCode::UNAUTHORIZED, "Authentication required".into())
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
fn check_origin(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    if let Some(origin) = headers.get(header::ORIGIN)
        && origin.to_str().ok() != Some(app.origin.as_str())
    {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "Request origin is not allowed".into(),
        ));
    }
    Ok(())
}
fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .map(str::trim)
                .find_map(|part| part.strip_prefix("pc_session="))
        })
}
async fn owner(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    check_origin(app, headers)?;
    if let Some(credential) = bearer(headers) {
        if bool::from(hash(credential).as_bytes().ct_eq(app.admin_hash.as_bytes())) {
            return Ok(());
        }
        return Err(unauthorized());
    }
    let cookie = session_cookie(headers).ok_or_else(unauthorized)?;
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM owner_sessions s WHERE token_hash=$1 AND admin_hash=$2 AND expires_at>now() AND (s.github_user_id IS NULL OR EXISTS(SELECT 1 FROM github_owner g WHERE g.user_id=s.github_user_id)))").bind(hash(cookie)).bind(app.admin_hash.as_str()).fetch_one(&app.db).await?;
    if valid { Ok(()) } else { Err(unauthorized()) }
}
fn text_field(value: &str, max: usize) -> ApiResult<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(invalid(format!(
            "Enter between 1 and {max} printable characters"
        )));
    }
    Ok(value.into())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "personal_cloud_api=info,tower_http=info".into()),
        )
        .init();
    let admin = env::var("PC_ADMIN_TOKEN")?;
    anyhow::ensure!(
        admin.len() >= 32,
        "PC_ADMIN_TOKEN must contain at least 32 characters"
    );
    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&env::var("DATABASE_URL")?)
        .await?;
    sqlx::migrate!("../../migrations").run(&db).await?;
    let app = App {
        db,
        admin_hash: Arc::new(hash(&admin)),
        origin: Arc::new(env::var("PC_WEB_ORIGIN").unwrap_or("http://127.0.0.1:4310".into())),
        events: broadcast::channel(64).0,
        client: reqwest::Client::builder()
            .user_agent("personal-cloud/0.1")
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        secret_key: Arc::new(crypto::load_key()?),
    };
    runtime::spawn_controller(app.clone());
    runtime::spawn_database_controller(app.clone());
    integrations::spawn_controller(app.clone());
    let router = Router::new()
        .merge(runtime::router())
        .merge(integrations::router())
        .merge(github_app::router())
        .merge(networking::router())
        .route(
            "/install.sh",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/x-shellscript")],
                    include_str!("../../../scripts/install.sh"),
                )
            }),
        )
        .route(
            "/api/health",
            get(|| async { Json(json!({"status":"ok","version":env!("CARGO_PKG_VERSION")})) }),
        )
        .route("/api/session", post(login).delete(logout))
        .route("/api/snapshot", get(get_snapshot))
        .route("/api/fleet/history", get(fleet_history))
        .route("/api/projects", post(create_project))
        .route("/api/projects/{id}/services", post(create_service))
        .route("/api/enrollment-tokens", post(create_enrollment))
        .route("/api/agent/enroll", post(enroll))
        .route("/api/agent/{id}/heartbeat", post(heartbeat))
        .route("/api/events", get(events))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(app);
    let address = env::var("PC_BIND").unwrap_or("127.0.0.1:4311".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address,"dinghy control plane ready");
    use std::future::IntoFuture;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = stopped.await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
      result=&mut server=>result?,
      _=tokio::signal::ctrl_c()=>{
        let _=stop.send(());
        // Long-lived WebSockets must not prevent upgrades or shutdown indefinitely.
        if let Ok(result)=tokio::time::timeout(Duration::from_secs(5),&mut server).await{result?;}
      }
    }

    Ok(())
}
#[derive(Deserialize)]
struct Login {
    token: String,
}
async fn login(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> ApiResult<Response> {
    check_origin(&app, &headers)?;
    if !bool::from(
        hash(&input.token)
            .as_bytes()
            .ct_eq(app.admin_hash.as_bytes()),
    ) {
        return Err(unauthorized());
    }
    issue_session(&app, None).await
}
async fn issue_session(app: &App, github_user_id: Option<i64>) -> ApiResult<Response> {
    let secure = if app.origin.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    let session = token();
    sqlx::query("DELETE FROM owner_sessions WHERE expires_at<=now()")
        .execute(&app.db)
        .await?;
    sqlx::query(
        "INSERT INTO owner_sessions(token_hash,admin_hash,github_user_id) VALUES($1,$2,$3)",
    )
    .bind(hash(&session))
    .bind(app.admin_hash.as_str())
    .bind(github_user_id)
    .execute(&app.db)
    .await?;
    let cookie = format!(
        "pc_session={session}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200{secure}"
    );
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({"ok":true}))).into_response())
}
async fn logout(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    check_origin(&app, &headers)?;
    if let Some(cookie) = session_cookie(&headers) {
        sqlx::query("DELETE FROM owner_sessions WHERE token_hash=$1")
            .bind(hash(cookie))
            .execute(&app.db)
            .await?;
    }
    Ok((
        [(
            header::SET_COOKIE,
            "pc_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0",
        )],
        Json(json!({"ok":true})),
    )
        .into_response())
}
async fn snapshot(app: &App) -> ApiResult<Value> {
    let machines:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'location',location,'roles',roles,'tags',tags,'report',report,'last_seen',last_seen,'status',CASE WHEN last_seen < now()-interval '45 seconds' THEN 'offline' WHEN NOT (report->>'docker')::boolean OR NOT (report->>'nomad')::boolean THEN 'degraded' ELSE 'online' END) FROM machines ORDER BY created_at").fetch_all(&app.db).await?;
    let projects: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(p) FROM projects p ORDER BY created_at DESC")
            .fetch_all(&app.db)
            .await?;
    let services: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(s) FROM services s ORDER BY created_at")
            .fetch_all(&app.db)
            .await?;
    let activity: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(e) FROM (SELECT * FROM events ORDER BY id DESC LIMIT 30) e",
    )
    .fetch_all(&app.db)
    .await?;
    let deployments: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(d) FROM (SELECT * FROM deployments ORDER BY created_at DESC LIMIT 200) d",
    )
    .fetch_all(&app.db)
    .await?;
    let databases: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(d)-'connection_encrypted' FROM databases d ORDER BY created_at",
    )
    .fetch_all(&app.db)
    .await?;
    let database_bindings: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(b) FROM service_database_bindings b ORDER BY service_id",
    )
    .fetch_all(&app.db)
    .await?;
    let domains: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(d) FROM domains d ORDER BY created_at")
            .fetch_all(&app.db)
            .await?;
    let integrations = integrations::status(app).await?;
    Ok(
        json!({"machines":machines,"projects":projects,"services":services,"deployments":deployments,"databases":databases,"database_bindings":database_bindings,"domains":domains,"activity":activity,"integrations":integrations,"generated_at":Utc::now()}),
    )
}
async fn get_snapshot(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(snapshot(&app).await?))
}
#[derive(Deserialize)]
struct NewProject {
    name: String,
    repository: String,
    #[serde(default = "main_branch")]
    branch: String,
}
fn main_branch() -> String {
    "main".into()
}
async fn create_project(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<NewProject>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    owner(&app, &headers).await?;
    let name = text_field(&input.name, 80)?;
    let repo = github_repository(&input.repository).map_err(invalid)?;
    let branch = text_field(&input.branch, 200)?;
    let id = Uuid::new_v4();
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO projects(id,name,repository,branch) VALUES($1,$2,$3,$4)")
        .bind(id)
        .bind(&name)
        .bind(&repo)
        .bind(&branch)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO events(kind,message) VALUES('project.created',$1)")
        .bind(format!("{name} added to your cloud"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":id,"name":name,"repository":repo,"branch":branch})),
    ))
}
#[derive(Deserialize)]
struct NewService {
    name: String,
    port: u16,
    placement: Placement,
    #[serde(default = "runtime::root_dir")]
    root_directory: String,
    #[serde(default = "runtime::health_path")]
    health_path: String,
    #[serde(default = "runtime::cpu")]
    cpu_mhz: i32,
    #[serde(default = "runtime::memory")]
    memory_mb: i32,
    #[serde(default = "runtime::architecture")]
    architecture: String,
    #[serde(default = "runtime::yes")]
    auto_deploy: bool,
}
async fn create_service(
    State(app): State<App>,
    headers: HeaderMap,
    Path(project_id): Path<Uuid>,
    Json(input): Json<NewService>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    owner(&app, &headers).await?;
    let name = text_field(&input.name, 80)?;
    runtime::validate_service(
        &input.root_directory,
        &input.health_path,
        input.cpu_mhz,
        input.memory_mb,
        &input.architecture,
    )?;
    if input.port == 0 {
        return Err(invalid("Port must be between 1 and 65535"));
    }
    if !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1)")
        .bind(project_id)
        .fetch_one(&app.db)
        .await?
    {
        return Err(ApiError(StatusCode::NOT_FOUND, "Project not found".into()));
    }
    if let Placement::Machine(ref id) = input.placement {
        let id = Uuid::parse_str(id).map_err(|_| invalid("Invalid machine"))?;
        if !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM machines WHERE id=$1)")
            .bind(id)
            .fetch_one(&app.db)
            .await?
        {
            return Err(invalid("Machine not found"));
        }
    }
    let id = Uuid::new_v4();
    let mut tx = app.db.begin().await?;
    sqlx::query("INSERT INTO services(id,project_id,name,port,placement,root_directory,health_path,cpu_mhz,memory_mb,architecture,auto_deploy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)")
        .bind(id)
        .bind(project_id)
        .bind(&name)
        .bind(i32::from(input.port))
        .bind(json!(input.placement))
        .bind(input.root_directory).bind(input.health_path).bind(input.cpu_mhz).bind(input.memory_mb).bind(input.architecture).bind(input.auto_deploy)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO events(kind,message) VALUES('service.created',$1)")
        .bind(format!("{name} service configured"))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok((StatusCode::CREATED, Json(json!({"id":id}))))
}
#[derive(Deserialize)]
struct NewEnrollment {
    location: String,
    roles: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
}
async fn create_enrollment(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<NewEnrollment>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    if !["home", "vps", "dedicated"].contains(&input.location.as_str())
        || input.roles.is_empty()
        || input.roles.len() > 3
        || input
            .roles
            .iter()
            .any(|r| !["compute", "builder", "database"].contains(&r.as_str()))
    {
        return Err(invalid("Choose a location and at least one valid role"));
    }
    if input.tags.len() > 10
        || input.tags.iter().any(|t| {
            t.is_empty()
                || t.len() > 30
                || !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
    {
        return Err(invalid(
            "Use up to 10 alphanumeric tags, at most 30 characters each",
        ));
    }
    let enrollment = token();
    let id = Uuid::new_v4();
    let expires:DateTime<Utc>=sqlx::query_scalar("INSERT INTO enrollment_tokens(id,token_hash,location,roles,tags) VALUES($1,$2,$3,$4,$5) RETURNING expires_at").bind(id).bind(hash(&enrollment)).bind(input.location).bind(input.roles).bind(input.tags).fetch_one(&app.db).await?;
    Ok(Json(
        json!({"id":id,"token":enrollment,"expires_at":expires}),
    ))
}
#[derive(Deserialize)]
struct Enroll {
    token: String,
    report: MachineReport,
}
async fn enroll(
    State(app): State<App>,
    Json(input): Json<Enroll>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    input.report.validate().map_err(invalid)?;
    let mut tx = app.db.begin().await?;
    let row=sqlx::query("UPDATE enrollment_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING location,roles,tags").bind(hash(&input.token)).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError(StatusCode::UNAUTHORIZED,"Enrollment token expired or already used".into()))?;
    let id = Uuid::new_v4();
    let credential = token();
    sqlx::query("INSERT INTO machines(id,credential_hash,location,roles,tags,report) VALUES($1,$2,$3,$4,$5,$6)").bind(id).bind(hash(&credential)).bind(row.get::<String,_>("location")).bind(row.get::<Vec<String>,_>("roles")).bind(row.get::<Vec<String>,_>("tags")).bind(json!(input.report)).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO events(kind,message) VALUES('machine.joined',$1)")
        .bind(format!("{} joined your cloud", input.report.hostname))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok((
        StatusCode::CREATED,
        Json(json!({"id":id,"credential":credential})),
    ))
}
async fn heartbeat(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(report): Json<MachineReport>,
) -> ApiResult<Json<Value>> {
    let credential = bearer(&headers).ok_or_else(unauthorized)?;
    report.validate().map_err(invalid)?;
    let mut tx = app.db.begin().await?;
    let result = sqlx::query(
        "UPDATE machines SET report=$1,last_seen=now() WHERE id=$2 AND credential_hash=$3",
    )
    .bind(json!(report))
    .bind(id)
    .bind(hash(credential))
    .execute(&mut *tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(unauthorized());
    }
    // One row per heartbeat (10 s); a day of retention bounds the table at ~8.6k rows per machine.
    // `containers` is the services currently placed on this machine — the closest observed analogue.
    sqlx::query(
        "INSERT INTO machine_samples(machine_id,cpu,load,mem,mem_total,disk,disk_total,uptime,cpu_count,containers) \
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT count(*) FROM services WHERE machine_id=$1)) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(report.cpu_percent)
    .bind(report.load_avg1)
    .bind(report.memory_used as i64)
    .bind(report.memory_total as i64)
    .bind(report.disk_used as i64)
    .bind(report.disk_total as i64)
    .bind(report.uptime_sec.map(|v| v as i64))
    .bind(report.cpu_cores as i32)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM machine_samples WHERE machine_id=$1 AND at < now()-interval '24 hours'",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok(Json(json!({"ok":true})))
}
/// Last hour of vitals for every machine, oldest first. Shape matches the fleet dashboard's
/// `hosts[].samples[]` contract: a machine without heartbeats in 45 s is `unreachable`.
async fn fleet_history(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let since = Utc::now() - Duration::from_secs(3600);
    let machines = sqlx::query(
        "SELECT id, report->>'hostname' AS name, report->>'private_ip' AS ip, last_seen, \
         EXTRACT(EPOCH FROM now()-last_seen)::bigint AS silent_for FROM machines ORDER BY created_at",
    )
    .fetch_all(&app.db)
    .await?;
    let rows = sqlx::query(
        "SELECT machine_id, at, cpu, load, mem, mem_total, disk, disk_total, uptime, cpu_count, containers \
         FROM machine_samples WHERE at >= $1 ORDER BY at",
    )
    .bind(since)
    .fetch_all(&app.db)
    .await?;
    let mut samples: std::collections::HashMap<Uuid, Vec<Value>> = std::collections::HashMap::new();
    for row in rows {
        let at: DateTime<Utc> = row.get("at");
        samples
            .entry(row.get("machine_id"))
            .or_default()
            .push(json!({
                "t": at.timestamp_millis(),
                "cpuPercent": row.get::<f32,_>("cpu"),
                "loadAvg1": row.get::<Option<f32>,_>("load"),
                "memUsedBytes": row.get::<i64,_>("mem"),
                "memTotalBytes": row.get::<i64,_>("mem_total"),
                "diskUsedBytes": row.get::<i64,_>("disk"),
                "diskTotalBytes": row.get::<i64,_>("disk_total"),
                "uptimeSec": row.get::<Option<i64>,_>("uptime"),
                "cpuCount": row.get::<i32,_>("cpu_count"),
                "containerCount": row.get::<i32,_>("containers"),
            }));
    }
    let hosts: Vec<Value> = machines
        .into_iter()
        .map(|m| {
            let id: Uuid = m.get("id");
            let silent: i64 = m.get("silent_for");
            let samples = samples.remove(&id).unwrap_or_default();
            let latest = samples.last().cloned();
            let (status, error) = if silent > 45 {
                (
                    "unreachable",
                    Some(format!("no heartbeat for {}", human_duration(silent))),
                )
            } else if latest.is_some() {
                ("ok", None)
            } else {
                ("pending", None)
            };
            json!({
                "hostKey": id, "serverId": id,
                "name": m.get::<Option<String>,_>("name").unwrap_or_else(|| id.to_string()),
                "aliases": [], "ipAddress": m.get::<Option<String>,_>("ip"),
                "status": status, "error": error,
                "latest": if status == "ok" { latest } else { None },
                "samples": samples,
            })
        })
        .collect();
    Ok(Json(
        json!({"pollMs":10_000,"maxSamples":360,"hosts":hosts}),
    ))
}
fn human_duration(seconds: i64) -> String {
    match seconds {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h {}m", s / 3600, (s % 3600) / 60),
        s => format!("{}d {}h", s / 86_400, (s % 86_400) / 3600),
    }
}
async fn events(
    State(app): State<App>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    owner(&app, &headers).await?;
    // A browser WebSocket must carry the approved origin; CLI clients may use a bearer token.
    if headers.get(header::ORIGIN).is_none() && bearer(&headers).is_none() {
        return Err(unauthorized());
    }
    Ok(ws.on_upgrade(move |mut socket|async move {
        let mut receiver=app.events.subscribe();
        let mut timer=tokio::time::interval(Duration::from_secs(10));
        loop {
            tokio::select! {
                _=timer.tick()=>{},
                result=receiver.recv()=>{ if matches!(result,Err(broadcast::error::RecvError::Closed)) { break; } },
                msg=socket.recv()=>{ match msg { Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,_=>continue } }
            }
            // Recheck expiry and revocation for long-lived connections.
            if owner(&app,&headers).await.is_err() { let _=socket.send(Message::Close(None)).await; break; }
            match snapshot(&app).await {
                Ok(data)=>{ if socket.send(Message::Text(data.to_string().into())).await.is_err(){break;} },
                Err(_)=>{let _=socket.send(Message::Close(None)).await;break;}
            }
        }
    }))
}
