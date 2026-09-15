mod database;
mod deploy;
mod observability;
use crate::{ApiError, ApiResult, App, crypto, invalid, owner};
use anyhow::{Context, ensure};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post, put},
};
pub use database::spawn_controller as spawn_database_controller;
pub use deploy::{queue_deployment, run_tunnel, service_address, spawn_controller, stop_tunnel};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeConfig {
    pub nomad_url: String,
    #[serde(default)]
    pub nomad_token: Option<String>,
    pub registry_url: String,
    #[serde(default)]
    pub registry_username: Option<String>,
    #[serde(default)]
    pub registry_password: Option<String>,
    #[serde(default = "default_buildkit")]
    pub buildkit_address: String,
    #[serde(default = "default_builder")]
    pub builder_image: String,
    #[serde(default)]
    pub allow_insecure_registry: bool,
    #[serde(default = "yes")]
    pub require_cloudflare: bool,
}
fn default_buildkit() -> String {
    "tcp://127.0.0.1:1234".into()
}
fn default_builder() -> String {
    "ghcr.io/nooesc/personal-cloud-builder:latest".into()
}
pub fn router() -> Router<App> {
    Router::new()
        .route("/api/runtime", get(get_runtime).put(save_runtime))
        .route(
            "/api/runtime/bootstrap-registry",
            post(deploy::bootstrap_registry),
        )
        .route(
            "/api/services/{id}",
            put(update_service).delete(delete_service),
        )
        .route("/api/services/{id}/deploy", post(deploy::deploy_service))
        .route(
            "/api/services/{id}/rollback",
            post(deploy::rollback_service),
        )
        .route("/api/services/{id}/logs", get(deploy::service_logs))
        .route("/api/services/{id}/metrics", get(deploy::service_metrics))
        .route("/api/services/{id}/events", get(observability::events))
        .route("/api/deployments/{id}", get(deploy::deployment_detail))
        .route("/api/projects/{id}", axum::routing::delete(delete_project))
        .route(
            "/api/projects/{id}/environment",
            get(list_environment).put(set_environment),
        )
        .route(
            "/api/projects/{id}/environment/{key}",
            axum::routing::delete(delete_environment),
        )
        .route(
            "/api/projects/{id}/environment/{key}/reveal",
            get(reveal_environment),
        )
        .route(
            "/api/machines/{id}",
            put(update_machine).delete(delete_machine),
        )
        .merge(database::router())
}
pub async fn config(app: &App) -> anyhow::Result<RuntimeConfig> {
    let value: Value = sqlx::query_scalar("SELECT value FROM settings WHERE key='runtime'")
        .fetch_optional(&app.db)
        .await?
        .context("Add a server machine or connect a runtime first")?;
    let mut cfg: RuntimeConfig = serde_json::from_value(value)?;
    for (field, context) in [
        (&mut cfg.nomad_token, "runtime:nomad"),
        (&mut cfg.registry_password, "runtime:registry"),
    ] {
        if let Some(value) = field {
            *value = crypto::open(app, context, value)?;
        }
    }
    Ok(cfg)
}
pub async fn nomad_raw(
    app: &App,
    cfg: &RuntimeConfig,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(u16, String)> {
    if let Some(id) = cfg.nomad_url.strip_prefix("agent://") {
        return crate::networking::nomad_request(
            app,
            Uuid::parse_str(id)?,
            method.as_str(),
            path,
            body,
        )
        .await;
    }
    let mut req = app.client.request(
        method,
        format!("{}{}", cfg.nomad_url.trim_end_matches('/'), path),
    );
    if let Some(token) = &cfg.nomad_token {
        req = req.header("X-Nomad-Token", token);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let res = req.send().await.context("Scheduler is unreachable")?;
    let status = res.status().as_u16();
    let text = res.text().await?;
    ensure!(
        text.len() < 4 * 1024 * 1024,
        "Scheduler response exceeds size limit"
    );
    Ok((status, text))
}
pub async fn nomad(
    app: &App,
    cfg: &RuntimeConfig,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<Value> {
    let (status, text) = nomad_raw(app, cfg, method, path, body).await?;
    ensure!(
        (200..300).contains(&status),
        "Scheduler rejected request ({status}) at {}",
        path.split('?').next().unwrap_or(path)
    );
    if text.trim().is_empty() {
        Ok(Value::Null)
    } else {
        Ok(serde_json::from_str(&text)?)
    }
}
pub async fn nodes(app: &App, cfg: &RuntimeConfig) -> anyhow::Result<Vec<Value>> {
    let list = nomad(app, cfg, reqwest::Method::GET, "/v1/nodes", None).await?;
    let mut result = Vec::new();
    for stub in list.as_array().context("Invalid node inventory")? {
        let id = stub["ID"].as_str().context("Missing node identity")?;
        let node = nomad(
            app,
            cfg,
            reqwest::Method::GET,
            &format!("/v1/node/{id}"),
            None,
        )
        .await?;
        let mut public = serde_json::Map::new();
        for key in [
            "ID",
            "Name",
            "Status",
            "SchedulingEligibility",
            "Attributes",
            "Meta",
            "NodeResources",
            "Resources",
            "Drivers",
            "HTTPAddr",
        ] {
            public.insert(key.into(), node[key].clone());
        }
        result.push(Value::Object(public));
    }
    Ok(result)
}
pub async fn status(app: &App) -> Value {
    match config(app).await {
        Ok(cfg) => match nodes(app, &cfg).await {
            Ok(nodes) => {
                json!({"status":"connected","nomad_url":cfg.nomad_url,"registry_url":cfg.registry_url,"buildkit_address":cfg.buildkit_address,"builder_image":cfg.builder_image,"allow_insecure_registry":cfg.allow_insecure_registry,"nodes":nodes})
            }
            Err(e) => {
                json!({"status":"unreachable","error":e.to_string(),"nomad_url":cfg.nomad_url,"registry_url":cfg.registry_url})
            }
        },
        Err(_) => json!({"status":"not_configured","nodes":[]}),
    }
}
async fn get_runtime(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(status(&app).await))
}
async fn save_runtime(
    State(app): State<App>,
    headers: HeaderMap,
    Json(mut cfg): Json<RuntimeConfig>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    if !cfg.nomad_url.starts_with("agent://") {
        validate_endpoint(&cfg.nomad_url).map_err(invalid)?;
    }
    validate_endpoint(&cfg.registry_url).map_err(invalid)?;
    if let Ok(old) = config(&app).await {
        if cfg.nomad_token.as_deref().is_none_or(str::is_empty) {
            cfg.nomad_token = old.nomad_token;
        }
        if cfg.registry_password.as_deref().is_none_or(str::is_empty) {
            cfg.registry_password = old.registry_password;
        }
    }
    nodes(&app, &cfg).await.map_err(invalid)?;
    for (field, context) in [
        (&mut cfg.nomad_token, "runtime:nomad"),
        (&mut cfg.registry_password, "runtime:registry"),
    ] {
        if let Some(value) = field {
            *value = crypto::seal(&app, context, value).map_err(invalid)?;
        }
    }
    sqlx::query("INSERT INTO settings(key,value) VALUES('runtime',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(json!(cfg)).execute(&app.db).await?;
    app.events.send(()).ok();
    Ok(Json(status(&app).await))
}
fn validate_endpoint(value: &str) -> anyhow::Result<()> {
    let url = reqwest::Url::parse(value)?;
    ensure!(
        ["http", "https"].contains(&url.scheme())
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Use an HTTP(S) URL without embedded credentials"
    );
    Ok(())
}
#[derive(Deserialize)]
struct UpdateService {
    name: String,
    port: u16,
    placement: personal_cloud_core::Placement,
    #[serde(default = "root_dir")]
    root_directory: String,
    #[serde(default = "health_path")]
    health_path: String,
    #[serde(default = "cpu")]
    cpu_mhz: i32,
    #[serde(default = "memory")]
    memory_mb: i32,
    #[serde(default = "architecture")]
    architecture: String,
    #[serde(default = "yes")]
    auto_deploy: bool,
}
pub(crate) fn root_dir() -> String {
    ".".into()
}
pub(crate) fn health_path() -> String {
    "/".into()
}
pub(crate) fn cpu() -> i32 {
    500
}
pub(crate) fn memory() -> i32 {
    256
}
pub(crate) fn architecture() -> String {
    "auto".into()
}
pub(crate) fn yes() -> bool {
    true
}
async fn update_service(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateService>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let name = crate::text_field(&input.name, 80)?;
    if input.port == 0
        || !(100..=128000).contains(&input.cpu_mhz)
        || !(64..=1048576).contains(&input.memory_mb)
    {
        return Err(invalid("Invalid port, CPU or memory"));
    }
    let path = std::path::Path::new(&input.root_directory);
    if path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || input.root_directory.len() > 200
    {
        return Err(invalid("Root directory must stay inside the repository"));
    }
    if !input.health_path.starts_with('/')
        || input.health_path.len() > 200
        || input.health_path.chars().any(char::is_control)
    {
        return Err(invalid("Health path must begin with /"));
    }
    if !["auto", "amd64", "arm64"].contains(&input.architecture.as_str()) {
        return Err(invalid("Invalid architecture"));
    }
    let result=sqlx::query("UPDATE services SET name=$1,port=$2,placement=$3,root_directory=$4,health_path=$5,cpu_mhz=$6,memory_mb=$7,architecture=$8,auto_deploy=$9 WHERE id=$10").bind(name).bind(i32::from(input.port)).bind(json!(input.placement)).bind(input.root_directory).bind(input.health_path).bind(input.cpu_mhz).bind(input.memory_mb).bind(input.architecture).bind(input.auto_deploy).bind(id).execute(&app.db).await?;
    if result.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "Service not found".into()));
    }
    app.events.send(()).ok();
    Ok(Json(json!({"ok":true})))
}
async fn delete_service(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    remove_service(&app, id).await.map_err(invalid)?;
    Ok(Json(json!({"ok":true})))
}
async fn remove_service(app: &App, id: Uuid) -> anyhow::Result<()> {
    let mut guard = app.db.begin().await?;
    let exists: Option<Uuid> = sqlx::query_scalar("SELECT id FROM services WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *guard)
        .await?;
    if exists.is_none() {
        return Ok(());
    }
    ensure!(
        !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM domains WHERE service_id=$1)")
            .bind(id)
            .fetch_one(&mut *guard)
            .await?,
        "Remove this service's domains first"
    );
    ensure!(!sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM deployments WHERE service_id=$1 AND status IN ('queued','building','deploying'))").bind(id).fetch_one(&mut *guard).await?,"Wait for the active deployment to finish");
    sqlx::query("UPDATE services SET status='deleting' WHERE id=$1")
        .bind(id)
        .execute(&mut *guard)
        .await?;
    guard.commit().await?;
    let jobs: Vec<String> = sqlx::query_scalar(
        "SELECT job_id FROM deployments WHERE service_id=$1 AND job_id IS NOT NULL",
    )
    .bind(id)
    .fetch_all(&app.db)
    .await?;
    if !jobs.is_empty() {
        let cfg = config(app).await?;
        for job in jobs {
            let (status, _) = nomad_raw(
                app,
                &cfg,
                reqwest::Method::DELETE,
                &format!("/v1/job/{job}?purge=true"),
                None,
            )
            .await?;
            ensure!(
                (200..300).contains(&status) || status == 404,
                "Could not stop service job"
            );
        }
    }
    let mut tx = app.db.begin().await?;
    sqlx::query(
        "UPDATE deployments SET rollback_of=NULL,previous_deployment_id=NULL WHERE service_id=$1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM deployments WHERE service_id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM services WHERE id=$1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok(())
}
async fn delete_project(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM databases WHERE project_id=$1)")
        .bind(id)
        .fetch_one(&app.db)
        .await?
    {
        return Err(invalid(
            "Remove project databases first; persistent volumes are preserved",
        ));
    }
    let services: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM services WHERE project_id=$1")
        .bind(id)
        .fetch_all(&app.db)
        .await?;
    for service in services {
        remove_service(&app, service).await.map_err(invalid)?;
    }
    sqlx::query("DELETE FROM projects WHERE id=$1")
        .bind(id)
        .execute(&app.db)
        .await?;
    app.events.send(()).ok();
    Ok(Json(json!({"ok":true})))
}
async fn list_environment(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let vars:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('key',key,'updated_at',updated_at) FROM environment_variables WHERE project_id=$1 ORDER BY key").bind(id).fetch_all(&app.db).await?;
    Ok(Json(json!({"variables":vars})))
}
#[derive(Deserialize)]
struct SetVariable {
    key: String,
    value: String,
}
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .enumerate()
            .all(|(i, c)| c == b'_' || c.is_ascii_alphabetic() || (i > 0 && c.is_ascii_digit()))
}
async fn set_environment(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<SetVariable>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    if !valid_key(&input.key) || input.value.len() > 16384 || input.value.contains('\0') {
        return Err(invalid(
            "Use a valid environment variable name and a value under 16 KiB",
        ));
    }
    let encrypted =
        crypto::seal(&app, &format!("env:{id}:{}", input.key), &input.value).map_err(invalid)?;
    sqlx::query("INSERT INTO environment_variables(project_id,key,value_encrypted) VALUES($1,$2,$3) ON CONFLICT(project_id,key) DO UPDATE SET value_encrypted=excluded.value_encrypted,updated_at=now()").bind(id).bind(input.key).bind(encrypted).execute(&app.db).await?;
    app.events.send(()).ok();
    Ok(Json(json!({"ok":true})))
}
async fn delete_environment(
    State(app): State<App>,
    headers: HeaderMap,
    Path((id, key)): Path<(Uuid, String)>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    sqlx::query("DELETE FROM environment_variables WHERE project_id=$1 AND key=$2")
        .bind(id)
        .bind(key)
        .execute(&app.db)
        .await?;
    Ok(Json(json!({"ok":true})))
}
async fn reveal_environment(
    State(app): State<App>,
    headers: HeaderMap,
    Path((id, key)): Path<(Uuid, String)>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let enc: String = sqlx::query_scalar(
        "SELECT value_encrypted FROM environment_variables WHERE project_id=$1 AND key=$2",
    )
    .bind(id)
    .bind(&key)
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(|| ApiError(StatusCode::NOT_FOUND, "Variable not found".into()))?;
    Ok(Json(
        json!({"key":key,"value":crypto::open(&app,&format!("env:{id}:{key}"),&enc).map_err(invalid)?}),
    ))
}
pub async fn environment(
    app: &App,
    project: Uuid,
    service: Uuid,
) -> anyhow::Result<serde_json::Map<String, Value>> {
    read_environment(app, project, service, true).await
}
pub async fn read_environment(
    app: &App,
    project: Uuid,
    service: Uuid,
    require_healthy: bool,
) -> anyhow::Result<serde_json::Map<String, Value>> {
    let rows =
        sqlx::query("SELECT key,value_encrypted FROM environment_variables WHERE project_id=$1")
            .bind(project)
            .fetch_all(&app.db)
            .await?;
    let mut env = serde_json::Map::new();
    for row in rows {
        let key: String = row.get("key");
        let value = crypto::open(
            app,
            &format!("env:{project}:{key}"),
            row.get("value_encrypted"),
        )?;
        env.insert(key, json!(value));
    }
    if let Some(row)=sqlx::query("SELECT d.id,d.status,d.connection_encrypted FROM databases d JOIN service_database_bindings b ON b.database_id=d.id WHERE b.service_id=$1").bind(service).fetch_optional(&app.db).await?{ensure!(!require_healthy||row.get::<String,_>("status")=="healthy","Attached database is not healthy; restore it before deploying");let id:Uuid=row.get("id");let value=crypto::open(app,&format!("database:{id}"),row.get("connection_encrypted"))?;env.insert("DATABASE_URL".into(),json!(value));}
    Ok(env)
}
#[derive(Deserialize)]
struct MachineUpdate {
    roles: Vec<String>,
    tags: Vec<String>,
    location: String,
}
async fn update_machine(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<MachineUpdate>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    if input.roles.is_empty()
        || input.roles.len() > 3
        || input
            .roles
            .iter()
            .any(|r| !["compute", "builder", "database"].contains(&r.as_str()))
        || !["home", "vps", "dedicated"].contains(&input.location.as_str())
        || input.tags.len() > 10
        || input.tags.iter().any(|t| {
            t.is_empty()
                || t.len() > 30
                || !t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
    {
        return Err(invalid("Invalid roles, tags or location"));
    }
    sqlx::query("UPDATE machines SET roles=$1,tags=$2,location=$3 WHERE id=$4")
        .bind(input.roles)
        .bind(input.tags)
        .bind(input.location)
        .bind(id)
        .execute(&app.db)
        .await?;
    app.events.send(()).ok();
    Ok(Json(json!({"ok":true})))
}
async fn delete_machine(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    if sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM fleet_network_nodes WHERE machine_id=$1 AND is_server) OR EXISTS(SELECT 1 FROM settings WHERE key='runtime' AND value->>'nomad_url'=$2)").bind(id).bind(format!("agent://{id}")).fetch_one(&app.db).await?{return Err(invalid("This machine is the fleet server. Move the control connection and private network hub before removing it"));}
    if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM databases WHERE machine_id=$1)")
        .bind(id)
        .fetch_one(&app.db)
        .await?
    {
        return Err(invalid(
            "This machine owns persistent databases; explicitly move or remove them first",
        ));
    }
    if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM services WHERE machine_id=$1)")
        .bind(id)
        .fetch_one(&app.db)
        .await?
    {
        return Err(invalid("Redeploy or remove services on this machine first"));
    }
    sqlx::query("UPDATE deployments SET machine_id=NULL WHERE machine_id=$1")
        .bind(id)
        .execute(&app.db)
        .await?;
    sqlx::query("DELETE FROM machines WHERE id=$1")
        .bind(id)
        .execute(&app.db)
        .await?;
    app.events.send(()).ok();
    Ok(Json(json!({"ok":true})))
}

pub(crate) fn validate_service(
    root: &str,
    health: &str,
    cpu: i32,
    memory: i32,
    arch: &str,
) -> ApiResult<()> {
    let path = std::path::Path::new(root);
    if root.is_empty()
        || root.contains(char::is_control)
        || path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || root.len() > 200
    {
        return Err(invalid("Root directory must stay inside the repository"));
    }
    if !health.starts_with('/') || health.len() > 200 || health.chars().any(char::is_control) {
        return Err(invalid("Health path must begin with /"));
    }
    if !(100..=128000).contains(&cpu)
        || !(64..=1048576).contains(&memory)
        || !["auto", "amd64", "arm64"].contains(&arch)
    {
        return Err(invalid("Invalid CPU, memory or architecture"));
    }
    Ok(())
}

#[cfg(test)]
mod lifecycle_tests;
