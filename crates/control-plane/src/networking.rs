//! The controller sends bounded, encrypted commands over authenticated outbound polls.
//! WireGuard private keys and Nomad management credentials never leave the node.
use crate::{ApiError, ApiResult, App, bearer, hash, invalid, owner, unauthorized};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    net::{Ipv4Addr, SocketAddr},
    time::Duration,
};
use uuid::Uuid;
#[derive(Default, Deserialize, Serialize)]
struct NetworkSettings {
    #[serde(default)]
    nomad_servers: Vec<String>,
    #[serde(default)]
    peers: Vec<Peer>,
}
#[derive(Deserialize, Serialize)]
struct Peer {
    public_key: String,
    private_ip: String,
    endpoint: Option<String>,
}
fn private_ip(slot: i32) -> String {
    format!("10.77.{}.{}", slot / 256, slot % 256)
}
fn valid_key(key: &str) -> bool {
    use base64::{Engine, engine::general_purpose::STANDARD};
    STANDARD
        .decode(key)
        .is_ok_and(|bytes| bytes.len() == 32 && STANDARD.encode(bytes) == key)
}
fn valid_endpoint(value: &str) -> bool {
    let Some((host, port)) = value.rsplit_once(':') else {
        return false;
    };
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:[]".contains(&b))
        && port.parse::<u16>().is_ok_and(|p| p > 0)
}
pub fn router() -> Router<App> {
    Router::new()
        .route("/api/networking", get(get_network).put(set_network))
        .route("/api/networking/{id}/check", get(check_connection))
        .route("/api/agent/{id}/config", get(config))
        .route("/api/agent/{id}/commands", get(commands))
        .route(
            "/api/agent/{id}/commands/{command_id}",
            post(command_result).layer(DefaultBodyLimit::max(2 * 1024 * 1024 + 1024)),
        )
        .route("/api/agent/{id}/runtime-ready", post(runtime_ready))
}
#[derive(Deserialize)]
struct CheckQuery {
    allocation_id: Option<Uuid>,
}
async fn check_connection(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    Query(query): Query<CheckQuery>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fleet_network_nodes WHERE machine_id=$1)")
            .bind(id)
            .fetch_one(&app.db)
            .await?;
    if !exists {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Provisioned machine not found".into(),
        ));
    }
    let path = query
        .allocation_id
        .map(|alloc| format!("/v1/personal-cloud/allocation/{alloc}/network"))
        .unwrap_or_else(|| "/v1/agent/health".to_owned());
    let (status, body) = nomad_request(&app, id, "GET", &path, None)
        .await
        .map_err(invalid)?;
    let health: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    Ok(Json(
        json!({"machine_id":id,"connected":(200..300).contains(&status),"status":status,"health":if query.allocation_id.is_none(){health.clone()}else{Value::Null},"network":if query.allocation_id.is_some(){health}else{Value::Null}}),
    ))
}
async fn authenticate(app: &App, id: Uuid, headers: &HeaderMap) -> ApiResult<()> {
    let token = bearer(headers).ok_or_else(unauthorized)?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM machines WHERE id=$1 AND credential_hash=$2)",
    )
    .bind(id)
    .bind(hash(token))
    .fetch_one(&app.db)
    .await?;
    if exists { Ok(()) } else { Err(unauthorized()) }
}
async fn get_network(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let settings: Option<Value> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='networking'")
            .fetch_optional(&app.db)
            .await?;
    let nodes:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('machine_id',machine_id,'private_ip','10.77.'||(address_slot/256)||'.'||(address_slot%256),'is_server',is_server,'public_key',public_key,'endpoint',endpoint) FROM fleet_network_nodes ORDER BY address_slot").fetch_all(&app.db).await?;
    Ok(Json(
        json!({"settings":settings.unwrap_or(json!({"nomad_servers":[],"peers":[]})),"subnet":"10.77.0.0/16","nodes":nodes}),
    ))
}
async fn set_network(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<NetworkSettings>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    if input.nomad_servers.len() > 7 || input.peers.len() > 256 {
        return Err(invalid("Too many fleet servers or peers"));
    }
    for server in &input.nomad_servers {
        let address: SocketAddr = server
            .parse()
            .map_err(|_| invalid("Use a private WireGuard IPv4 address and port"))?;
        if !matches!(address.ip(),std::net::IpAddr::V4(ip) if ip.octets()[0..2]==[10,77])
            || address.port() != 4647
        {
            return Err(invalid("Nomad servers must use 10.77.0.0/16:4647"));
        }
    }
    for peer in &input.peers {
        let ip: Ipv4Addr = peer
            .private_ip
            .parse()
            .map_err(|_| invalid("Invalid peer address"))?;
        if ip.octets()[0..2] != [10, 77]
            || !valid_key(&peer.public_key)
            || peer.endpoint.as_deref().is_some_and(|e| !valid_endpoint(e))
        {
            return Err(invalid("Invalid WireGuard peer"));
        }
    }
    sqlx::query("INSERT INTO settings(key,value) VALUES('networking',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(json!(input)).execute(&app.db).await?;
    let _ = app.events.send(());
    Ok(Json(json!({"ok":true})))
}
async fn config(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        agent_config(&app, id, bearer(&headers).ok_or_else(unauthorized)?).await?,
    ))
}
pub async fn agent_config(app: &App, id: Uuid, credential: &str) -> ApiResult<Value> {
    let machine = sqlx::query(
        "SELECT location,roles,tags,report FROM machines WHERE id=$1 AND credential_hash=$2",
    )
    .bind(id)
    .bind(hash(credential))
    .fetch_optional(&app.db)
    .await?
    .ok_or_else(unauthorized)?;
    let report: Value = machine.get("report");
    let key = report["wireguard_public_key"]
        .as_str()
        .filter(|key| valid_key(key))
        .ok_or_else(|| {
            ApiError(
                StatusCode::CONFLICT,
                "Provision this Linux machine to generate its node-local WireGuard key".into(),
            )
        })?;
    let endpoint = report["wireguard_endpoint"].as_str();
    if endpoint.is_some_and(|e| !valid_endpoint(e)) {
        return Err(invalid("Invalid WireGuard endpoint"));
    }
    let settings: Option<Value> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='networking'")
            .fetch_optional(&app.db)
            .await?;
    let settings: NetworkSettings = serde_json::from_value(settings.unwrap_or(json!({})))
        .map_err(|_| invalid("Invalid network settings"))?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(77151464)")
        .execute(&mut *tx)
        .await?;
    let bootstrap = settings.nomad_servers.is_empty()
        && !sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM fleet_network_nodes WHERE is_server)",
        )
        .fetch_one(&mut *tx)
        .await?;
    let node = refresh_network_node(&mut tx, id, bootstrap, key, endpoint).await?;
    let address = private_ip(node.get("address_slot"));
    let is_server: bool = node.get("is_server");
    tx.commit().await?;
    let others=sqlx::query("SELECT address_slot,public_key,endpoint,is_server FROM fleet_network_nodes WHERE machine_id<>$1 AND public_key IS NOT NULL").bind(id).fetch_all(&app.db).await?;
    let mut peers: Vec<Value> = settings
        .peers
        .iter()
        .map(|p| {
            let mut peer = json!(p);
            let gateway = !is_server
                && settings
                    .nomad_servers
                    .first()
                    .is_some_and(|s| s == &format!("{}:4647", p.private_ip));
            peer["allowed_ips"] = json!(if gateway {
                "10.77.0.0/16".to_owned()
            } else {
                format!("{}/32", p.private_ip)
            });
            peer
        })
        .collect();
    let mut servers = settings.nomad_servers;
    if is_server && servers.is_empty() {
        servers.push(format!("{address}:4647"));
    }
    for peer in others {
        let ip = private_ip(peer.get("address_slot"));
        if peer.get::<bool, _>("is_server") && servers.is_empty() {
            servers.push(format!("{ip}:4647"));
        }
        // Spokes route through the reachable hub; NATed home nodes need no inbound ports.
        let gateway = peer.get::<bool, _>("is_server");
        if is_server || gateway {
            let allowed = if is_server {
                format!("{ip}/32")
            } else {
                "10.77.0.0/16".to_owned()
            };
            peers.push(json!({"public_key":peer.get::<String,_>("public_key"),"private_ip":ip,"allowed_ips":allowed,"endpoint":peer.get::<Option<String>,_>("endpoint")}));
        }
    }
    Ok(
        json!({"machine_id":id,"private_ip":address,"prefix_length":16,"listen_port":51820,"peers":peers,"nomad":{"server":is_server,"servers":servers},"location":machine.get::<String,_>("location"),"roles":machine.get::<Vec<String>,_>("roles"),"tags":machine.get::<Vec<String>,_>("tags")}),
    )
}
// Caller holds the fleet advisory transaction lock. An upsert would evaluate
// nextval even for existing machines and exhaust the bounded subnet over time.
async fn refresh_network_node(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
    bootstrap: bool,
    key: &str,
    endpoint: Option<&str>,
) -> Result<sqlx::postgres::PgRow, sqlx::Error> {
    if let Some(node) = sqlx::query("UPDATE fleet_network_nodes SET public_key=$2,endpoint=$3,updated_at=now() WHERE machine_id=$1 RETURNING address_slot,is_server")
        .bind(id).bind(key).bind(endpoint).fetch_optional(&mut **tx).await? {
        return Ok(node);
    }
    sqlx::query("INSERT INTO fleet_network_nodes(machine_id,is_server,public_key,endpoint) VALUES($1,$2,$3,$4) RETURNING address_slot,is_server")
        .bind(id).bind(bootstrap).bind(key).bind(endpoint).fetch_one(&mut **tx).await
}
async fn runtime_ready(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    authenticate(&app, id, &headers).await?;
    let slot: Option<i32> = sqlx::query_scalar(
        "SELECT address_slot FROM fleet_network_nodes WHERE machine_id=$1 AND is_server",
    )
    .bind(id)
    .fetch_optional(&app.db)
    .await?;
    let slot = slot.ok_or_else(|| {
        ApiError(
            StatusCode::FORBIDDEN,
            "Only the fleet server can initialize the runtime".into(),
        )
    })?;
    let config = json!({"nomad_url":format!("agent://{id}"),"registry_url":format!("http://{}:5000",private_ip(slot)),"buildkit_address":"tcp://127.0.0.1:1234","builder_image":"ghcr.io/nooesc/personal-cloud-builder:latest","allow_insecure_registry":true,"require_cloudflare":true});
    let inserted = sqlx::query(
        "INSERT INTO settings(key,value) VALUES('runtime',$1) ON CONFLICT(key) DO NOTHING",
    )
    .bind(config)
    .execute(&app.db)
    .await?;
    if inserted.rows_affected() > 0 {
        let _ = app.events.send(());
    }
    Ok(Json(json!({"ok":true})))
}
fn relay_error(_: anyhow::Error) -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Fleet command encryption failed".into(),
    )
}
/// Only internal owner-authorized controllers call this; machines cannot enqueue commands.
pub async fn nomad_request(
    app: &App,
    machine_id: Uuid,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(u16, String)> {
    anyhow::ensure!(
        matches!(method, "GET" | "POST" | "PUT" | "DELETE")
            && path.starts_with("/v1/")
            && !path.contains(".."),
        "Invalid Nomad request"
    );
    let id = Uuid::new_v4();
    let payload = json!({"method":method,"path":path,"body":body}).to_string();
    anyhow::ensure!(payload.len() <= 1024 * 1024, "Nomad request exceeds 1 MiB");
    let encrypted = crate::crypto::seal(app, &format!("fleet-command:{id}"), &payload)?;
    sqlx::query("DELETE FROM fleet_commands WHERE created_at<now()-interval '1 hour'")
        .execute(&app.db)
        .await?;
    sqlx::query("INSERT INTO fleet_commands(id,machine_id,request) VALUES($1,$2,$3)")
        .bind(id)
        .bind(machine_id)
        .bind(encrypted)
        .execute(&app.db)
        .await?;
    for _ in 0..240 {
        let result: Option<String> =
            sqlx::query_scalar("SELECT result FROM fleet_commands WHERE id=$1")
                .bind(id)
                .fetch_one(&app.db)
                .await?;
        if let Some(result) = result {
            let decoded: Value = serde_json::from_str(&crate::crypto::open(
                app,
                &format!("fleet-result:{id}"),
                &result,
            )?)?;
            sqlx::query("DELETE FROM fleet_commands WHERE id=$1")
                .bind(id)
                .execute(&app.db)
                .await?;
            return Ok((
                decoded["status"].as_u64().unwrap_or(502) as u16,
                decoded["body"].as_str().unwrap_or("").to_owned(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    sqlx::query("DELETE FROM fleet_commands WHERE id=$1")
        .bind(id)
        .execute(&app.db)
        .await?;
    anyhow::bail!("Fleet server did not answer within 60 seconds; check agent connectivity")
}
async fn commands(
    State(app): State<App>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    authenticate(&app, id, &headers).await?;
    let rows=sqlx::query("UPDATE fleet_commands SET claimed_at=now() WHERE id IN (SELECT id FROM fleet_commands WHERE machine_id=$1 AND completed_at IS NULL AND claimed_at IS NULL AND created_at>now()-interval '60 seconds' ORDER BY created_at LIMIT 8 FOR UPDATE SKIP LOCKED) RETURNING id,request").bind(id).fetch_all(&app.db).await?;
    let mut commands = vec![];
    for row in rows {
        let cid: Uuid = row.get("id");
        let text = crate::crypto::open(
            &app,
            &format!("fleet-command:{cid}"),
            &row.get::<String, _>("request"),
        )
        .map_err(relay_error)?;
        let request: Value =
            serde_json::from_str(&text).map_err(|_| invalid("Invalid fleet command"))?;
        commands.push(json!({"id":cid,"request":request}));
    }
    Ok(Json(json!({"commands":commands})))
}
#[derive(Deserialize)]
struct CommandResult {
    status: u16,
    body: String,
}
async fn command_result(
    State(app): State<App>,
    Path((id, cid)): Path<(Uuid, Uuid)>,
    headers: HeaderMap,
    Json(input): Json<CommandResult>,
) -> ApiResult<Json<Value>> {
    authenticate(&app, id, &headers).await?;
    if !(100..600).contains(&input.status) || input.body.len() > 2 * 1024 * 1024 {
        return Err(invalid("Invalid or oversized command result"));
    }
    let encrypted = crate::crypto::seal(
        &app,
        &format!("fleet-result:{cid}"),
        &json!({"status":input.status,"body":input.body}).to_string(),
    )
    .map_err(relay_error)?;
    let result=sqlx::query("UPDATE fleet_commands SET result=$1,completed_at=now() WHERE id=$2 AND machine_id=$3 AND claimed_at IS NOT NULL AND completed_at IS NULL").bind(encrypted).bind(cid).bind(id).execute(&app.db).await?;
    if result.rows_affected() != 1 {
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            "Command unavailable".into(),
        ));
    }
    Ok(Json(json!({"ok":true})))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn address_and_input_boundaries() {
        assert_eq!(private_ip(257), "10.77.1.1");
        assert!(valid_endpoint("hub.example.com:51820"));
        assert!(!valid_endpoint("host\nPostUp=bad:51820"));
        assert!(!valid_endpoint("host:0"));
        assert!(valid_key(&format!("{}=", "A".repeat(43))));
        assert!(!valid_key("malformed"));
        assert!(!valid_key(&format!("{}é=", "a".repeat(41))));
    }
    #[tokio::test]
    #[ignore = "requires a disposable PostgreSQL database in PC_TEST_DATABASE_URL"]
    async fn configuration_refresh_does_not_consume_addresses() -> anyhow::Result<()> {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&std::env::var("PC_TEST_DATABASE_URL")?)
            .await?;
        let mut tx = pool.begin().await?;
        // Temporary objects shadow production names and disappear on rollback.
        sqlx::query("CREATE TEMP SEQUENCE fleet_private_address_seq MINVALUE 2 MAXVALUE 65534")
            .execute(&mut *tx)
            .await?;
        sqlx::query("CREATE TEMP TABLE fleet_network_nodes(machine_id UUID PRIMARY KEY,address_slot INTEGER UNIQUE DEFAULT nextval('pg_temp.fleet_private_address_seq'),is_server BOOLEAN,public_key TEXT,endpoint TEXT,updated_at TIMESTAMPTZ DEFAULT now())").execute(&mut *tx).await?;
        let id = Uuid::new_v4();
        let first = refresh_network_node(&mut tx, id, true, "public-key-a", None).await?;
        assert_eq!(first.get::<i32, _>("address_slot"), 2);
        for _ in 0..1000 {
            let node = refresh_network_node(
                &mut tx,
                id,
                false,
                "public-key-rotated",
                Some("hub.example:51820"),
            )
            .await?;
            assert_eq!(node.get::<i32, _>("address_slot"), 2);
            assert!(node.get::<bool, _>("is_server"));
        }
        let sequence: i64 =
            sqlx::query_scalar("SELECT last_value FROM pg_temp.fleet_private_address_seq")
                .fetch_one(&mut *tx)
                .await?;
        assert_eq!(
            sequence, 2,
            "refresh must not advance the private-address sequence"
        );
        let second =
            refresh_network_node(&mut tx, Uuid::new_v4(), false, "public-key-b", None).await?;
        assert_eq!(second.get::<i32, _>("address_slot"), 3);
        tx.rollback().await?;
        Ok(())
    }
}
