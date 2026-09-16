//! Provider credentials never leave this module except through explicit internal helpers.
//! Provider mutations are recorded incrementally so failed cleanup remains reviewable/retryable.
use crate::{ApiError, ApiResult, App, crypto, invalid, owner};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{delete, get, post, put},
};
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{Client, Method};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::time::Duration;
use uuid::Uuid;

type HmacSha256 = Hmac<Sha256>;
const GH: &str = "https://api.github.com";
const CF: &str = "https://api.cloudflare.com/client/v4";

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/integrations", get(get_status))
        .route("/api/integrations/github", put(connect_github))
        .route(
            "/api/integrations/github/webhook",
            get(webhook_configuration),
        )
        .route("/api/github/repositories", get(repositories))
        .route(
            "/api/github/webhook",
            post(webhook).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        .route("/api/integrations/cloudflare", put(connect_cloudflare))
        .route(
            "/api/integrations/cloudflare/discover",
            post(discover_cloudflare),
        )
        .route("/api/domains", post(create_domain))
        .route("/api/domains/{id}", delete(delete_domain))
}

fn internal(_: impl std::fmt::Display) -> ApiError {
    ApiError(
        StatusCode::BAD_GATEWAY,
        "Provider operation failed; check credentials, permissions and connectivity".into(),
    )
}
fn provider_error(provider: &str, status: reqwest::StatusCode) -> anyhow::Error {
    anyhow::anyhow!(
        "{provider} returned HTTP {}. Check token permissions and selected resources",
        status.as_u16()
    )
}
struct Provider<'a> {
    client: &'a Client,
    base: &'a str,
    token: &'a str,
    cloudflare: bool,
}
impl Provider<'_> {
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(self.token)
            .header("User-Agent", "personal-cloud")
            .timeout(Duration::from_secs(25));
        if !self.cloudflare {
            request = request
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28");
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Provider connection failed"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(provider_error(
                if self.cloudflare {
                    "Cloudflare"
                } else {
                    "GitHub"
                },
                status,
            ));
        }
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let value: Value = response
            .json()
            .await
            .map_err(|_| anyhow::anyhow!("Provider returned invalid JSON"))?;
        if self.cloudflare && value["success"] != true {
            anyhow::bail!("Cloudflare rejected the operation; check token permissions");
        }
        Ok(value)
    }
    async fn get(&self, path: &str) -> anyhow::Result<Value> {
        self.request(Method::GET, path, None).await
    }
    async fn cf(&self, method: Method, path: &str, body: Option<Value>) -> anyhow::Result<Value> {
        Ok(self.request(method, path, body).await?["result"].clone())
    }
    async fn existing_cloudflare_resource(&self, path: &str) -> anyhow::Result<Option<Value>> {
        let response = self
            .client
            .get(format!("{}{path}", self.base))
            .bearer_auth(self.token)
            .header("User-Agent", "personal-cloud")
            .timeout(Duration::from_secs(25))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Provider ownership check connection failed"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(provider_error(
                "Cloudflare ownership check",
                response.status(),
            ));
        }
        let data: Value = response
            .json()
            .await
            .map_err(|_| anyhow::anyhow!("Invalid ownership response"))?;
        anyhow::ensure!(data["success"] == true, "Cloudflare ownership check failed");
        Ok(Some(data["result"].clone()))
    }
    async fn delete_owned_dns(
        &self,
        path: &str,
        hostname: &str,
        marker: &str,
        cname: &str,
    ) -> anyhow::Result<()> {
        if let Some(record) = self.existing_cloudflare_resource(path).await? {
            anyhow::ensure!(
                record["name"] == hostname
                    && record["comment"] == marker
                    && record["type"] == "CNAME"
                    && record["content"] == cname,
                "DNS ownership changed; refusing to delete the modified record"
            );
            self.delete(path).await?;
        }
        Ok(())
    }
    async fn delete(&self, path: &str) -> anyhow::Result<()> {
        // A missing previously owned resource is already cleaned up.
        let response = self
            .client
            .delete(format!("{}{path}", self.base))
            .bearer_auth(self.token)
            .header("User-Agent", "personal-cloud")
            .timeout(Duration::from_secs(25))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Provider cleanup connection failed"))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        if !status.is_success() {
            return Err(provider_error("Cloudflare cleanup", status));
        }
        if self.cloudflare && status != reqwest::StatusCode::NO_CONTENT {
            let value: Value = response
                .json()
                .await
                .map_err(|_| anyhow::anyhow!("Invalid cleanup response"))?;
            anyhow::ensure!(value["success"] == true, "Cloudflare cleanup was rejected");
        }
        Ok(())
    }
}
fn github<'a>(app: &'a App, token: &'a str) -> Provider<'a> {
    Provider {
        client: &app.client,
        base: GH,
        token,
        cloudflare: false,
    }
}
fn cloudflare<'a>(app: &'a App, token: &'a str) -> Provider<'a> {
    Provider {
        client: &app.client,
        base: CF,
        token,
        cloudflare: true,
    }
}
pub(crate) async fn secret(app: &App, key: &str) -> anyhow::Result<Option<String>> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT ciphertext FROM integration_secrets WHERE key=$1")
            .bind(key)
            .fetch_optional(&app.db)
            .await?;
    value
        .map(|v| crypto::open(app, &format!("integration:{key}"), &v))
        .transpose()
}
pub(crate) async fn save_secret(
    app: &App,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    key: &str,
    value: &str,
) -> anyhow::Result<()> {
    let ciphertext = crypto::seal(app, &format!("integration:{key}"), value)?;
    sqlx::query("INSERT INTO integration_secrets(key,ciphertext) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET ciphertext=excluded.ciphertext")
        .bind(key).bind(ciphertext).execute(&mut **tx).await?;
    Ok(())
}
pub async fn github_token(app: &App, repository: &str) -> anyhow::Result<Option<String>> {
    if crate::github_app::active(app).await? {
        return Ok(Some(
            crate::github_app::repository_token(app, repository).await?,
        ));
    }
    secret(app, "github.token").await
}
async fn metadata(app: &App, provider: &str) -> anyhow::Result<Option<Value>> {
    Ok(
        sqlx::query_scalar("SELECT metadata FROM integrations WHERE provider=$1")
            .bind(provider)
            .fetch_optional(&app.db)
            .await?,
    )
}
pub async fn status(app: &App) -> ApiResult<Value> {
    let rows: Vec<(String, Value)> = sqlx::query_as("SELECT provider,metadata FROM integrations")
        .fetch_all(&app.db)
        .await?;
    let mut result =
        json!({"github":{"status":"not_connected"},"cloudflare":{"status":"not_connected"}});
    for (provider, data) in rows {
        result[provider] = data;
    }
    if result["github"]["status"] == "connected" {
        let hooks:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('repository',repository,'status',status,'error',error,'updated_at',updated_at) FROM github_repository_hooks ORDER BY repository").fetch_all(&app.db).await?;
        let pending: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM github_deploy_requests WHERE status='pending'",
        )
        .fetch_one(&app.db)
        .await?;
        let queue_error:Option<String>=sqlx::query_scalar("SELECT error FROM github_deploy_requests WHERE status='pending' AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").fetch_optional(&app.db).await?;
        result["github"]["webhooks"] = json!(hooks);
        result["github"]["pending_deployments"] = json!(pending);
        result["github"]["queue_error"] = json!(queue_error);
    }
    Ok(result)
}
async fn get_status(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(status(&app).await?))
}
#[derive(Deserialize)]
struct TokenInput {
    token: String,
}
fn valid_token(token: &str) -> ApiResult<()> {
    if token.trim().is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
        return Err(invalid("Enter a valid API token"));
    }
    Ok(())
}
async fn connect_github(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<TokenInput>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    if crate::github_app::active(&app).await.map_err(internal)? {
        return Err(invalid(
            "GitHub App access is active; manage repository access through the app",
        ));
    }
    valid_token(&input.token)?;
    let user = github(&app, &input.token)
        .get("/user")
        .await
        .map_err(internal)?;
    let login = user["login"]
        .as_str()
        .ok_or_else(|| internal("Missing GitHub login"))?;
    let data = json!({"status":"connected","login":login,"verified_at":Utc::now(),"mode":"personal_access_token","push_mode":if webhook_url().is_some(){"webhook_and_polling"}else{"polling"}});
    let mut tx = app.db.begin().await?;
    // Serialize connections to preserve the secret already installed on repository hooks.
    sqlx::query("SELECT pg_advisory_xact_lock(74103902)")
        .execute(&mut *tx)
        .await?;
    save_secret(&app, &mut tx, "github.token", &input.token)
        .await
        .map_err(internal)?;
    let has_secret: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM integration_secrets WHERE key='github.webhook')",
    )
    .fetch_one(&mut *tx)
    .await?;
    if !has_secret {
        save_secret(&app, &mut tx, "github.webhook", &crate::token())
            .await
            .map_err(internal)?;
    }
    sqlx::query("INSERT INTO integrations(provider,metadata) VALUES('github',$1) ON CONFLICT(provider) DO UPDATE SET metadata=excluded.metadata,updated_at=now()")
        .bind(&data).execute(&mut *tx).await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok(Json(data))
}
async fn repositories(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    if crate::github_app::active(&app).await.map_err(internal)? {
        return Ok(Json(
            crate::github_app::repositories(&app)
                .await
                .map_err(internal)?,
        ));
    }
    let token = secret(&app, "github.token")
        .await
        .map_err(internal)?
        .ok_or_else(|| invalid("Connect GitHub first"))?;
    let provider = github(&app, &token);
    let mut result = Vec::new();
    for page in 1..=100 {
        let value=provider.get(&format!("/user/repos?per_page=100&page={page}&sort=updated&affiliation=owner,collaborator,organization_member")).await.map_err(internal)?;
        let rows = value
            .as_array()
            .ok_or_else(|| internal("Invalid repositories"))?;
        result.extend(rows.iter().map(|r|json!({"full_name":r["full_name"],"default_branch":r["default_branch"],"private":r["private"]})));
        if rows.len() < 100 {
            return Ok(Json(json!({"repositories":result})));
        }
    }
    Ok(Json(json!({"repositories":result,"truncated":true})))
}
fn webhook_url() -> Option<String> {
    let base = std::env::var("PC_PUBLIC_URL").ok()?;
    let parsed = reqwest::Url::parse(&base).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(format!("{}/api/github/webhook", base.trim_end_matches('/')))
}
async fn webhook_configuration(
    State(app): State<App>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let secret = secret(&app, "github.webhook")
        .await
        .map_err(internal)?
        .ok_or_else(|| invalid("Connect GitHub first"))?;
    Ok(Json(
        json!({"url":webhook_url(),"secret":secret,"events":["push"],"content_type":"json","poll_interval_seconds":60}),
    ))
}
pub(crate) fn signature_valid(secret: &str, signature: &str, body: &[u8]) -> bool {
    let Some(hex) = signature.strip_prefix("sha256=") else {
        return false;
    };
    if hex.len() != 64 || !hex.bytes().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let bytes: Vec<u8> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts arbitrary keys");
    mac.update(body);
    mac.verify_slice(&bytes).is_ok()
}
fn push_target(payload: &Value) -> Option<(&str, &str, &str)> {
    if payload["deleted"] == true {
        return None;
    }
    let repository = payload["repository"]["full_name"].as_str()?;
    let branch = payload["ref"].as_str()?.strip_prefix("refs/heads/")?;
    let sha = payload["after"].as_str()?;
    if !valid_sha(sha) || sha.bytes().all(|c| c == b'0') {
        return None;
    }
    Some((repository, branch, sha))
}
fn valid_sha(sha: &str) -> bool {
    (sha.len() == 40 || sha.len() == 64) && sha.bytes().all(|c| c.is_ascii_hexdigit())
}
async fn webhook(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let secret = secret(&app, "github.webhook")
        .await
        .map_err(internal)?
        .ok_or_else(crate::unauthorized)?;
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !signature_valid(&secret, signature, &body) {
        return Err(crate::unauthorized());
    }
    receive_webhook(&app, &headers, &body).await
}
pub(crate) async fn receive_webhook(
    app: &App,
    headers: &HeaderMap,
    body: &[u8],
) -> ApiResult<(StatusCode, Json<Value>)> {
    let delivery = headers
        .get("x-github-delivery")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| invalid("Missing delivery ID"))?;
    let delivery = crate::text_field(delivery, 200)?;
    let event = headers
        .get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| invalid("Missing event type"))?;
    let event = crate::text_field(event, 80)?;
    let payload: Value =
        serde_json::from_slice(body).map_err(|_| invalid("Invalid webhook JSON"))?;
    let mut tx = app.db.begin().await?;
    let inserted =
        sqlx::query("INSERT INTO github_deliveries(id,event) VALUES($1,$2) ON CONFLICT DO NOTHING")
            .bind(&delivery)
            .bind(&event)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    let mut count = 0;
    if inserted == 1
        && event == "push"
        && let Some((repo, branch, sha)) = push_target(&payload)
    {
        // The outbox and delivery acknowledgement commit atomically; restarts cannot lose pushes.
        count=sqlx::query("INSERT INTO github_deploy_requests(service_id,commit_sha) SELECT s.id,$3 FROM services s JOIN projects p ON p.id=s.project_id WHERE lower(p.repository)=lower($1) AND p.branch=$2 AND s.auto_deploy=true ON CONFLICT DO NOTHING")
            .bind(repo).bind(branch).bind(sha).execute(&mut *tx).await?.rows_affected();
    }
    tx.commit().await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"accepted":true,"duplicate":inserted==0,"queued":count})),
    ))
}

/// Called only by an owner-initiated deploy. Polling covers missing inbound HTTPS/admin scope.
pub async fn ensure_repository_webhook(app: &App, repository: &str) -> anyhow::Result<Value> {
    let repository =
        personal_cloud_core::github_repository(repository).map_err(|e| anyhow::anyhow!(e))?;
    let Some(url) = webhook_url() else {
        return Ok(
            json!({"status":"polling","reason":"Set PC_PUBLIC_URL to enable inbound GitHub webhooks"}),
        );
    };
    if crate::github_app::active(app).await? {
        return Ok(json!({"status":"configured","mode":"github_app"}));
    }
    let token = secret(app, "github.token")
        .await?
        .ok_or_else(|| anyhow::anyhow!("GitHub is not connected"))?;
    let secret = secret(app, "github.webhook")
        .await?
        .ok_or_else(|| anyhow::anyhow!("Webhook secret is unavailable"))?;
    let provider = github(app, &token);
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("github-hook:{repository}"))
        .execute(&mut *tx)
        .await?;
    let result: anyhow::Result<Value>=async {
        let hooks=provider.get(&format!("/repos/{repository}/hooks?per_page=100")).await?;
        let existing=hooks.as_array().and_then(|rows|rows.iter().find(|h|h["config"]["url"].as_str()==Some(&url))).and_then(|h|h["id"].as_i64());
        let body=json!({"name":"web","active":true,"events":["push"],"config":{"url":url,"content_type":"json","insecure_ssl":"0","secret":secret}});
        let hook=if let Some(id)=existing {provider.request(Method::PATCH,&format!("/repos/{repository}/hooks/{id}"),Some(body)).await?}
            else {provider.request(Method::POST,&format!("/repos/{repository}/hooks"),Some(body)).await?};
        anyhow::ensure!(hook["id"].as_i64().is_some(),"GitHub omitted webhook ID");
        Ok(hook)
    }.await;
    let (hook_id, status, error) = match result {
        Ok(hook) => (hook["id"].as_i64(), "configured", None),
        Err(_) => (
            None,
            "polling",
            Some("Webhook setup unavailable; polling checks the branch every 60 seconds"),
        ),
    };
    sqlx::query("INSERT INTO github_repository_hooks(repository,hook_id,url,status,error) VALUES($1,$2,$3,$4,$5) ON CONFLICT(repository) DO UPDATE SET hook_id=COALESCE(excluded.hook_id,github_repository_hooks.hook_id),url=excluded.url,status=excluded.status,error=excluded.error,updated_at=now()")
        .bind(&repository).bind(hook_id).bind(&url).bind(status).bind(error).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"status":status,"error":error}))
}

#[derive(Deserialize)]
struct CloudflareInput {
    token: String,
    account_id: String,
    zone_id: String,
    #[serde(default)]
    r2_access_key_id: String,
    #[serde(default)]
    r2_secret_access_key: String,
    #[serde(default)]
    bucket: String,
}
fn cf_id(value: &str) -> ApiResult<()> {
    if value.len() != 32 || !value.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(invalid("Select a valid Cloudflare account and zone"));
    }
    Ok(())
}
async fn cf_list(provider: &Provider<'_>, path: &str) -> anyhow::Result<Vec<Value>> {
    let mut results = Vec::new();
    for page in 1..=100 {
        let value = provider
            .get(&format!("{path}?per_page=50&page={page}"))
            .await?;
        let rows = value["result"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Cloudflare returned an invalid list"))?;
        results.extend(rows.iter().cloned());
        if rows.len() < 50
            || value["result_info"]["total_pages"]
                .as_u64()
                .is_some_and(|total| page >= total)
        {
            return Ok(results);
        }
    }
    anyhow::bail!("Cloudflare resource discovery exceeded 5000 resources; use scoped credentials")
}
async fn discover_cloudflare(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<TokenInput>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    valid_token(&input.token)?;
    let provider = cloudflare(&app, &input.token);
    let (accounts, zones) = tokio::try_join!(
        cf_list(&provider, "/accounts"),
        cf_list(&provider, "/zones")
    )
    .map_err(internal)?;
    Ok(Json(
        json!({"accounts":accounts.iter().map(|a|json!({"id":a["id"],"name":a["name"]})).collect::<Vec<_>>(),"zones":zones.iter().map(|z|json!({"id":z["id"],"name":z["name"],"account_id":z["account"]["id"],"status":z["status"]})).collect::<Vec<_>>()}),
    ))
}
fn valid_bucket(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 63
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && value.as_bytes()[0] != b'-'
        && value.as_bytes()[value.len() - 1] != b'-'
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts arbitrary keys");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}
/// AWS Signature V4 is the R2 S3 authentication protocol; HEAD proves these credentials access this bucket.
fn r2_authorization(
    host: &str,
    bucket: &str,
    key: &str,
    secret: &str,
    date: &str,
) -> (String, String) {
    let payload_hash = hex(&Sha256::digest([]));
    let day = &date[..8];
    let scope = format!("{day}/auto/s3/aws4_request");
    let canonical = format!(
        "HEAD\n/{bucket}\n\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{date}\n\nhost;x-amz-content-sha256;x-amz-date\n{payload_hash}"
    );
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{date}\n{scope}\n{}",
        hex(&Sha256::digest(canonical.as_bytes()))
    );
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), day);
    let k_region = hmac(&k_date, "auto");
    let k_service = hmac(&k_region, "s3");
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex(&hmac(&k_signing, &to_sign));
    (
        format!(
            "AWS4-HMAC-SHA256 Credential={key}/{scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature={signature}"
        ),
        payload_hash,
    )
}
async fn validate_r2(app: &App, input: &CloudflareInput) -> anyhow::Result<()> {
    let host = format!("{}.r2.cloudflarestorage.com", input.account_id);
    let date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let (authorization, payload_hash) = r2_authorization(
        &host,
        &input.bucket,
        &input.r2_access_key_id,
        &input.r2_secret_access_key,
        &date,
    );
    let response = app
        .client
        .head(format!("https://{host}/{}", input.bucket))
        .header("Authorization", authorization)
        .header("x-amz-date", date)
        .header("x-amz-content-sha256", payload_hash)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("R2 connection failed"))?;
    anyhow::ensure!(
        response.status().is_success(),
        "R2 credentials could not access the selected bucket"
    );
    Ok(())
}
async fn connect_cloudflare(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<CloudflareInput>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    valid_token(&input.token)?;
    cf_id(&input.account_id)?;
    cf_id(&input.zone_id)?;
    let has_r2 = !input.r2_access_key_id.is_empty()
        || !input.r2_secret_access_key.is_empty()
        || !input.bucket.is_empty();
    if has_r2
        && (!valid_bucket(&input.bucket)
            || input.r2_access_key_id.is_empty()
            || input.r2_secret_access_key.is_empty())
    {
        return Err(invalid(
            "Supply the R2 bucket, access key ID and secret together, or leave all three empty",
        ));
    }
    if has_r2 {
        valid_token(&input.r2_access_key_id)?;
        valid_token(&input.r2_secret_access_key)?;
    }
    let provider = cloudflare(&app, &input.token);
    let account_path = format!("/accounts/{}", input.account_id);
    let zone_path = format!("/zones/{}", input.zone_id);
    let (account, zone) = tokio::try_join!(
        provider.cf(Method::GET, &account_path, None),
        provider.cf(Method::GET, &zone_path, None)
    )
    .map_err(internal)?;
    if zone["account"]["id"].as_str() != Some(input.account_id.as_str()) {
        return Err(invalid(
            "The zone belongs to a different Cloudflare account",
        ));
    }
    if zone["status"] != "active" {
        return Err(invalid(
            "Activate the zone in Cloudflare before connecting it",
        ));
    }
    let zone_name = zone["name"]
        .as_str()
        .ok_or_else(|| internal("Missing zone name"))?;
    // Exercise the exact resource families we need; do not require a user-level token introspection API.
    let tunnel_path = format!("{account_path}/cfd_tunnel?per_page=1&is_deleted=false");
    let dns_path = format!("{zone_path}/dns_records?per_page=1");
    tokio::try_join!(provider.get(&tunnel_path), provider.get(&dns_path)).map_err(internal)?;
    if has_r2 {
        provider
            .get(&format!("{account_path}/r2/buckets/{}", input.bucket))
            .await
            .map_err(internal)?;
        validate_r2(&app, &input).await.map_err(internal)?;
    }
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(74103903)")
        .execute(&mut *tx)
        .await?;
    let old: Option<Value> =
        sqlx::query_scalar("SELECT metadata FROM integrations WHERE provider='cloudflare'")
            .fetch_optional(&mut *tx)
            .await?;
    let incompatible = old.as_ref().is_some_and(|old| {
        old["account_id"] != input.account_id || old["zone_id"] != input.zone_id
    });
    if incompatible {
        let domains: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM domains)")
            .fetch_one(&mut *tx)
            .await?;
        if domains {
            return Err(invalid(
                "Remove existing domains before switching the Cloudflare account or zone",
            ));
        }
    }
    let preserve_r2 = !has_r2
        && old.as_ref().is_some_and(|old| {
            old["account_id"] == input.account_id && old["r2_status"] == "verified"
        });
    let bucket = if has_r2 {
        json!(input.bucket)
    } else if preserve_r2 {
        old.as_ref().unwrap()["bucket"].clone()
    } else {
        Value::Null
    };
    let data = json!({"status":"connected","account_id":input.account_id,"account_name":account["name"],"zone_id":input.zone_id,"zone_name":zone_name,"bucket":bucket,"r2_status":if has_r2 || preserve_r2 {"verified"}else{"not_configured"},"verified_at":Utc::now()});
    save_secret(&app, &mut tx, "cloudflare.token", &input.token)
        .await
        .map_err(internal)?;
    if has_r2 {
        save_secret(
            &app,
            &mut tx,
            "cloudflare.r2_access_key_id",
            &input.r2_access_key_id,
        )
        .await
        .map_err(internal)?;
        save_secret(
            &app,
            &mut tx,
            "cloudflare.r2_secret_access_key",
            &input.r2_secret_access_key,
        )
        .await
        .map_err(internal)?;
    } else if !preserve_r2 {
        sqlx::query("DELETE FROM integration_secrets WHERE key IN ('cloudflare.r2_access_key_id','cloudflare.r2_secret_access_key')").execute(&mut *tx).await?;
    }
    sqlx::query("INSERT INTO integrations(provider,metadata) VALUES('cloudflare',$1) ON CONFLICT(provider) DO UPDATE SET metadata=excluded.metadata,updated_at=now()")
        .bind(&data).execute(&mut *tx).await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok(Json(data))
}
pub async fn registry_configuration(app: &App) -> anyhow::Result<Option<Value>> {
    let Some(data) = metadata(app, "cloudflare").await? else {
        return Ok(None);
    };
    if data["r2_status"] != "verified" {
        return Ok(None);
    }
    let access = secret(app, "cloudflare.r2_access_key_id")
        .await?
        .ok_or_else(|| anyhow::anyhow!("R2 access key unavailable"))?;
    let secret = secret(app, "cloudflare.r2_secret_access_key")
        .await?
        .ok_or_else(|| anyhow::anyhow!("R2 secret unavailable"))?;
    Ok(Some(
        json!({"account_id":data["account_id"],"bucket":data["bucket"],"access_key_id":access,"secret_access_key":secret}),
    ))
}

#[derive(Deserialize)]
struct NewDomain {
    service_id: Uuid,
    hostname: String,
}
fn hostname_in_zone(host: &str, zone: &str) -> bool {
    host.len() <= 253
        && !host.is_empty()
        && (host == zone || host.ends_with(&format!(".{zone}")))
        && host.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}
async fn create_domain(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<NewDomain>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    owner(&app, &headers).await?;
    let data = metadata(&app, "cloudflare")
        .await
        .map_err(internal)?
        .ok_or_else(|| invalid("Connect Cloudflare first"))?;
    let hostname = input
        .hostname
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if !hostname_in_zone(&hostname, data["zone_name"].as_str().unwrap_or("")) {
        return Err(invalid(
            "Use a hostname within your connected Cloudflare zone",
        ));
    }
    let upstream = crate::runtime::service_address(&app, input.service_id)
        .await
        .map_err(|_| {
            invalid("Deploy the service and wait for healthy status before exposing it")
        })?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO domains(id,service_id,hostname,status,account_id,zone_id,upstream) VALUES($1,$2,$3,'provisioning',$4,$5,$6)")
        .bind(id).bind(input.service_id).bind(&hostname).bind(data["account_id"].as_str()).bind(data["zone_id"].as_str()).bind(upstream).execute(&app.db).await?;
    // Persist first; crashes leave a recoverable operation rather than losing resource ownership.
    if provision_domain(&app, id).await.is_err() {
        let cleaned = cleanup_domain(&app, id).await.is_ok();
        sqlx::query("UPDATE domains SET status=$2,error=$3,updated_at=now() WHERE id=$1").bind(id)
            .bind(if cleaned {"failed"}else{"cleanup_failed"})
            .bind(if cleaned {"Domain setup failed; provider resources were cleaned up. Remove this entry and retry."}else{"Domain setup failed and cleanup is incomplete. Remove this domain to retry cleanup; its owned resources are retained."})
            .execute(&app.db).await?;
    }
    app.events.send(()).ok();
    let domain: Value = sqlx::query_scalar("SELECT to_jsonb(d) FROM domains d WHERE id=$1")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    Ok((StatusCode::CREATED, Json(domain)))
}
fn required<'a>(value: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Provider omitted {key}"))
}
fn tunnel_configuration(hostname: &str, upstream: &str) -> Value {
    json!({"config":{"ingress":[{"hostname":hostname,"service":upstream},{"service":"http_status:404"}]}})
}
async fn provision_domain(app: &App, id: Uuid) -> anyhow::Result<()> {
    let mut lock = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("domain:{id}"))
        .execute(&mut *lock)
        .await?;
    let row = sqlx::query("SELECT * FROM domains WHERE id=$1")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    let status: String = row.get("status");
    if status != "provisioning" {
        return Ok(());
    }
    let token = secret(app, "cloudflare.token")
        .await?
        .ok_or_else(|| anyhow::anyhow!("Cloudflare is disconnected"))?;
    let provider = cloudflare(app, &token);
    let account: String = row.get("account_id");
    let zone: String = row.get("zone_id");
    let hostname: String = row.get("hostname");
    let service: Uuid = row.get("service_id");
    let upstream = crate::runtime::service_address(app, service).await?;
    let tunnel_base = format!("/accounts/{account}/cfd_tunnel");
    let name = format!("personal-cloud-{id}");
    let tunnel = if let Some(id) = row.get::<Option<String>, _>("tunnel_id") {
        id
    } else {
        // Deterministic name recovers a provider create that succeeded before process termination.
        let existing = provider
            .cf(
                Method::GET,
                &format!("{tunnel_base}?name={name}&is_deleted=false"),
                None,
            )
            .await?;
        let found = existing
            .as_array()
            .and_then(|rows| rows.iter().find(|v| v["name"] == name));
        let tunnel = if let Some(found) = found {
            found.clone()
        } else {
            provider
                .cf(
                    Method::POST,
                    &tunnel_base,
                    Some(json!({"name":name,"config_src":"cloudflare"})),
                )
                .await?
        };
        let tunnel_id = required(&tunnel, "id")?.to_string();
        sqlx::query("UPDATE domains SET tunnel_id=$2,updated_at=now() WHERE id=$1")
            .bind(id)
            .bind(&tunnel_id)
            .execute(&app.db)
            .await?;
        tunnel_id
    };
    let configuration = provider
        .cf(
            Method::PUT,
            &format!("{tunnel_base}/{tunnel}/configurations"),
            Some(tunnel_configuration(&hostname, &upstream)),
        )
        .await?;
    let version = configuration["version"]
        .as_i64()
        .ok_or_else(|| anyhow::anyhow!("Cloudflare omitted configuration version"))?;
    sqlx::query(
        "UPDATE domains SET configuration_version=$2,configuration_applied=false WHERE id=$1",
    )
    .bind(id)
    .bind(version)
    .execute(&app.db)
    .await?;
    let connector_token = provider
        .cf(Method::GET, &format!("{tunnel_base}/{tunnel}/token"), None)
        .await?;
    let connector_token = connector_token
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Cloudflare omitted tunnel token"))?;
    crate::runtime::run_tunnel(app, &tunnel, connector_token).await?;
    if row.get::<Option<String>, _>("dns_record_id").is_none() {
        let dns_base = format!("/zones/{zone}/dns_records");
        let cname = format!("{tunnel}.cfargotunnel.com");
        let marker = format!("personal-cloud:{id}");
        let records = provider
            .cf(Method::GET, &format!("{dns_base}?name={hostname}"), None)
            .await?;
        let records = records
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Invalid DNS listing"))?;
        let owned = records
            .iter()
            .find(|r| r["type"] == "CNAME" && r["content"] == cname && r["comment"] == marker);
        let record = if let Some(record) = owned {
            record.clone()
        } else {
            anyhow::ensure!(
                records.is_empty(),
                "Hostname already has a DNS record; no existing records were replaced"
            );
            provider.cf(Method::POST,&dns_base,Some(json!({"type":"CNAME","name":hostname,"content":cname,"proxied":true,"ttl":1,"comment":marker}))).await?
        };
        let dns_id = required(&record, "id")?;
        sqlx::query("UPDATE domains SET dns_record_id=$2,updated_at=now() WHERE id=$1")
            .bind(id)
            .bind(dns_id)
            .execute(&app.db)
            .await?;
    }
    sqlx::query(
        "UPDATE domains SET status='pending',upstream=$2,error=NULL,updated_at=now() WHERE id=$1",
    )
    .bind(id)
    .bind(upstream)
    .execute(&app.db)
    .await?;
    lock.commit().await?;
    Ok(())
}
async fn cleanup_domain(app: &App, id: Uuid) -> anyhow::Result<()> {
    let mut lock = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("domain:{id}"))
        .execute(&mut *lock)
        .await?;
    let row = sqlx::query("SELECT * FROM domains WHERE id=$1")
        .bind(id)
        .fetch_one(&app.db)
        .await?;
    let token = secret(app, "cloudflare.token")
        .await?
        .ok_or_else(|| anyhow::anyhow!("Cloudflare is disconnected"))?;
    let provider = cloudflare(app, &token);
    let account: String = row.get("account_id");
    let zone: String = row.get("zone_id");
    let hostname: String = row.get("hostname");
    let mut tunnel: Option<String> = row.get("tunnel_id");
    if tunnel.is_none() {
        let name = format!("personal-cloud-{id}");
        let existing = provider
            .cf(
                Method::GET,
                &format!("/accounts/{account}/cfd_tunnel?name={name}&is_deleted=false"),
                None,
            )
            .await?;
        tunnel = existing
            .as_array()
            .and_then(|rows| rows.iter().find(|v| v["name"] == name))
            .and_then(|v| v["id"].as_str())
            .map(str::to_string);
        if let Some(ref tunnel) = tunnel {
            sqlx::query("UPDATE domains SET tunnel_id=$2 WHERE id=$1")
                .bind(id)
                .bind(tunnel)
                .execute(&app.db)
                .await?;
        }
    }
    let mut dns: Option<String> = row.get("dns_record_id");
    if dns.is_none() {
        let records = provider
            .cf(
                Method::GET,
                &format!("/zones/{zone}/dns_records?name={hostname}"),
                None,
            )
            .await?;
        let marker = format!("personal-cloud:{id}");
        dns = records
            .as_array()
            .and_then(|rows| rows.iter().find(|v| v["comment"] == marker))
            .and_then(|v| v["id"].as_str())
            .map(str::to_string);
        if let Some(ref dns) = dns {
            sqlx::query("UPDATE domains SET dns_record_id=$2 WHERE id=$1")
                .bind(id)
                .bind(dns)
                .execute(&app.db)
                .await?;
        }
    }
    if let Some(dns) = dns {
        provider
            .delete_owned_dns(
                &format!("/zones/{zone}/dns_records/{dns}"),
                &hostname,
                &format!("personal-cloud:{id}"),
                &tunnel
                    .as_ref()
                    .map(|t| format!("{t}.cfargotunnel.com"))
                    .unwrap_or_default(),
            )
            .await?;
        sqlx::query("UPDATE domains SET dns_record_id=NULL,updated_at=now() WHERE id=$1")
            .bind(id)
            .execute(&app.db)
            .await?;
    }
    if let Some(tunnel) = tunnel {
        let path = format!("/accounts/{account}/cfd_tunnel/{tunnel}");
        if let Some(resource) = provider.existing_cloudflare_resource(&path).await? {
            anyhow::ensure!(
                resource["name"] == format!("personal-cloud-{id}"),
                "Tunnel ownership changed; refusing to delete the modified tunnel"
            );
            crate::runtime::stop_tunnel(app, &tunnel).await?;
            // Cloudflare refuses deletion while connections remain; retry retains the owned ID.
            provider.delete(&path).await?;
        } else {
            crate::runtime::stop_tunnel(app, &tunnel).await?;
        }
        sqlx::query("UPDATE domains SET tunnel_id=NULL,updated_at=now() WHERE id=$1")
            .bind(id)
            .execute(&app.db)
            .await?;
    }
    lock.commit().await?;
    Ok(())
}
async fn delete_domain(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let changed =
        sqlx::query("UPDATE domains SET status='deleting',error=NULL,updated_at=now() WHERE id=$1")
            .bind(id)
            .execute(&app.db)
            .await?
            .rows_affected();
    if changed == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "Domain not found".into()));
    }
    if cleanup_domain(&app, id).await.is_err() {
        sqlx::query("UPDATE domains SET status='cleanup_failed',error='Provider cleanup failed; owned resource IDs were retained. Retry removal.',updated_at=now() WHERE id=$1").bind(id).execute(&app.db).await?;
        app.events.send(()).ok();
        return Err(ApiError(StatusCode::BAD_GATEWAY,"Cleanup is incomplete. The domain record and remaining owned resource IDs are retained; retry removal.".into()));
    }
    sqlx::query("DELETE FROM domains WHERE id=$1")
        .bind(id)
        .execute(&app.db)
        .await?;
    app.events.send(()).ok();
    Ok(Json(json!({"ok":true})))
}

/// Called after promotion and before the previous allocation is stopped.
pub async fn refresh_service_domains(app: &App, service_id: Uuid) -> anyhow::Result<()> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM domains WHERE service_id=$1 AND status IN ('pending','healthy','degraded')",
    )
    .bind(service_id)
    .fetch_all(&app.db)
    .await?;
    if ids.is_empty() {
        return Ok(());
    }
    let token = secret(app, "cloudflare.token")
        .await?
        .ok_or_else(|| anyhow::anyhow!("Cloudflare is disconnected"))?;
    let provider = cloudflare(app, &token);
    for id in ids {
        let mut lock = app.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("domain:{id}"))
            .execute(&mut *lock)
            .await?;
        let row=sqlx::query("SELECT account_id,tunnel_id,hostname,upstream,configuration_version,configuration_applied FROM domains WHERE id=$1 AND status IN ('pending','healthy','degraded')").bind(id).fetch_optional(&app.db).await?;
        if let Some(row) = row {
            // Re-read after taking the routing lock; an earlier observation may predate a promotion.
            let upstream = crate::runtime::service_address(app, service_id).await?;
            let old: Option<String> = row.get("upstream");
            let account: String = row.get("account_id");
            let tunnel: String = row.get("tunnel_id");
            let hostname: String = row.get("hostname");
            let base = format!("/accounts/{account}/cfd_tunnel/{tunnel}");
            let mut version: Option<i64> = row.get("configuration_version");
            let mut applied: bool = row.get("configuration_applied");
            if old.as_deref() != Some(&upstream) || version.is_none() {
                let configuration = provider
                    .cf(
                        Method::PUT,
                        &format!("{base}/configurations"),
                        Some(tunnel_configuration(&hostname, &upstream)),
                    )
                    .await?;
                version = configuration["version"].as_i64();
                // Persist intent immediately: a failed acknowledgement must still be reverted on rollback.
                sqlx::query("UPDATE domains SET upstream=$2,configuration_version=$3,configuration_applied=false,status='pending',error=NULL,updated_at=now() WHERE id=$1")
                    .bind(id).bind(&upstream).bind(version).execute(&app.db).await?;
                applied = false;
            }
            if !applied {
                let version = version
                    .ok_or_else(|| anyhow::anyhow!("Cloudflare omitted configuration version"))?;
                wait_for_tunnel_configuration(app, &provider, &base, &tunnel, version).await?;
                sqlx::query(
                    "UPDATE domains SET configuration_applied=true,updated_at=now() WHERE id=$1",
                )
                .bind(id)
                .execute(&app.db)
                .await?;
            }
        }
        lock.commit().await?;
    }
    Ok(())
}

fn connectors_applied(clients: &Value, version: i64) -> bool {
    let Some(clients) = clients.as_array() else {
        return false;
    };
    let active: Vec<_> = clients
        .iter()
        .filter(|client| {
            client["conns"]
                .as_array()
                .is_some_and(|connections| !connections.is_empty())
        })
        .collect();
    !active.is_empty()
        && active.iter().all(|client| {
            client["config_version"]
                .as_i64()
                .is_some_and(|observed| observed >= version)
        })
}
async fn wait_for_tunnel_configuration(
    app: &App,
    provider: &Provider<'_>,
    base: &str,
    tunnel: &str,
    version: i64,
) -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(45), async {
        loop {
            let mut clients = provider
                .cf(Method::GET, &format!("{base}/connections"), None)
                .await?;
            if connectors_applied(&clients, version) {
                return Ok(());
            }
            if let Ok(observed) = crate::runtime::acknowledged_configurations(app, tunnel).await
                && let Some(clients) = clients.as_array_mut()
            {
                for client in clients {
                    // An explicit provider version remains authoritative, including a stale one.
                    if client["config_version"].is_null()
                        && let Some(version) = client["id"].as_str().and_then(|id| observed.get(id))
                    {
                        client["config_version"] = json!(version);
                    }
                }
            }
            if connectors_applied(&clients, version) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "Tunnel connectors have not applied the new route; keeping the prior deployment"
        )
    })?
}

pub fn spawn_controller(app: App) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut cycle = 0u64;
        loop {
            interval.tick().await;
            if cycle.is_multiple_of(4) && poll_github(&app).await.is_err() {
                tracing::warn!(
                    "GitHub branch polling is unavailable; queued deliveries are retained"
                );
            }
            if process_pushes(&app).await.is_err() {
                tracing::warn!(
                    "GitHub deployment queue processing failed; pending requests will retry"
                );
            }
            if observe_domains(&app).await.is_err() {
                tracing::warn!(
                    "Cloudflare reconciliation is unavailable; existing domain ownership is retained"
                );
            }
            cycle = cycle.wrapping_add(1);
        }
    });
}
async fn poll_github(app: &App) -> anyhow::Result<()> {
    let projects = sqlx::query("SELECT id,repository,branch FROM projects ORDER BY created_at")
        .fetch_all(&app.db)
        .await?;
    for project in projects {
        let id: Uuid = project.get("id");
        let repository: String = project.get("repository");
        let branch: String = project.get("branch");
        let token = match github_token(app, &repository).await {
            Ok(Some(t)) => t,
            _ => continue,
        };
        let provider = github(app, &token);
        let mut url = reqwest::Url::parse(&format!("{GH}/repos/{repository}/commits/"))?;
        url.path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid branch URL"))?
            .pop_if_empty()
            .push(&branch);
        let commit = match provider.get(url.path()).await {
            Ok(value) => value,
            Err(_) => continue,
        };
        let sha = required(&commit, "sha")?;
        if !valid_sha(sha) {
            continue;
        }
        let mut tx = app.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("github-poll:{id}"))
            .execute(&mut *tx)
            .await?;
        let previous: Option<String> =
            sqlx::query_scalar("SELECT commit_sha FROM github_branch_heads WHERE project_id=$1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        // First observation is a baseline; manual deploy remains the initial explicit action.
        if previous.as_deref().is_some_and(|old| old != sha) {
            sqlx::query("INSERT INTO github_deploy_requests(service_id,commit_sha) SELECT id,$2 FROM services WHERE project_id=$1 AND auto_deploy=true ON CONFLICT DO NOTHING")
                .bind(id).bind(sha).execute(&mut *tx).await?;
        }
        sqlx::query("INSERT INTO github_branch_heads(project_id,commit_sha) VALUES($1,$2) ON CONFLICT(project_id) DO UPDATE SET commit_sha=excluded.commit_sha,checked_at=now()")
            .bind(id).bind(sha).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    Ok(())
}
async fn process_pushes(app: &App) -> anyhow::Result<()> {
    let rows=sqlx::query("SELECT service_id,commit_sha FROM (SELECT DISTINCT ON(service_id) * FROM github_deploy_requests WHERE status='pending' ORDER BY service_id,created_at DESC) latest WHERE attempts=0 OR updated_at<now()-make_interval(secs=>LEAST(attempts*15,600)) ORDER BY updated_at LIMIT 20").fetch_all(&app.db).await?;
    for row in rows {
        let id: Uuid = row.get("service_id");
        let sha: String = row.get("commit_sha");
        let mut lock = app.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
            .bind(format!("github-deploy:{id}:{sha}"))
            .execute(&mut *lock)
            .await?;
        let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM github_deploy_requests WHERE service_id=$1 AND commit_sha=$2 AND status='pending')").bind(id).bind(&sha).fetch_one(&app.db).await?;
        if !pending {
            continue;
        }
        // A crash after queue_deployment commits but before marking this outbox row cannot enqueue twice.
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM deployments WHERE service_id=$1 AND commit_sha=$2)",
        )
        .bind(id)
        .bind(&sha)
        .fetch_one(&app.db)
        .await?;
        let queued = exists
            || crate::runtime::queue_deployment(app, id, Some(sha.clone()), None)
                .await
                .is_ok();
        if queued {
            // Once a newer push is queued, an older request must never deploy later after its backoff.
            sqlx::query("UPDATE github_deploy_requests SET status='superseded',error=NULL,updated_at=now() WHERE service_id=$1 AND status='pending' AND created_at<(SELECT created_at FROM github_deploy_requests WHERE service_id=$1 AND commit_sha=$2)")
                .bind(id).bind(&sha).execute(&app.db).await?;
        }

        sqlx::query("UPDATE github_deploy_requests SET status=$3,attempts=attempts+1,error=$4,updated_at=now() WHERE service_id=$1 AND commit_sha=$2")
            .bind(id).bind(&sha).bind(if queued {"queued"} else {"pending"}).bind(if queued {None} else {Some("Deployment could not be queued; check runtime setup. Retrying automatically.")}).execute(&app.db).await?;
        lock.commit().await?;
    }
    Ok(())
}
async fn observe_domains(app: &App) -> anyhow::Result<()> {
    let rows=sqlx::query("SELECT id,service_id,status FROM domains WHERE status IN ('provisioning','pending','healthy','degraded','deleting') ORDER BY updated_at LIMIT 100").fetch_all(&app.db).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let token = secret(app, "cloudflare.token")
        .await?
        .ok_or_else(|| anyhow::anyhow!("Cloudflare is disconnected"))?;
    let provider = cloudflare(app, &token);
    for row in rows {
        let id: Uuid = row.get("id");
        let service: Uuid = row.get("service_id");
        let state: String = row.get("status");
        if state == "deleting" {
            if cleanup_domain(app, id).await.is_ok() {
                sqlx::query("DELETE FROM domains WHERE id=$1 AND status='deleting'")
                    .bind(id)
                    .execute(&app.db)
                    .await?;
            }
            continue;
        }
        if state == "provisioning" {
            if provision_domain(app, id).await.is_err() {
                sqlx::query("UPDATE domains SET error='Domain provisioning is retrying; check Cloudflare and runtime connectivity',updated_at=now() WHERE id=$1 AND status='provisioning'").bind(id).execute(&app.db).await?;
            }
            continue;
        }
        let routing_ok = refresh_service_domains(app, service).await.is_ok();
        let row=sqlx::query("SELECT d.*,s.health_path FROM domains d JOIN services s ON s.id=d.service_id WHERE d.id=$1").bind(id).fetch_optional(&app.db).await?;
        let Some(row) = row else {
            continue;
        };
        let account: String = row.get("account_id");
        let tunnel: String = row.get("tunnel_id");
        let hostname: String = row.get("hostname");
        let health_path: String = row.get("health_path");
        let tunnel_healthy = provider
            .cf(
                Method::GET,
                &format!("/accounts/{account}/cfd_tunnel/{tunnel}"),
                None,
            )
            .await
            .is_ok_and(|data| data["status"] == "healthy");
        let public_healthy = if routing_ok && tunnel_healthy {
            app.client
                .get(format!("https://{hostname}{health_path}"))
                .timeout(Duration::from_secs(10))
                .send()
                .await
                .is_ok_and(|r| r.status().is_success())
        } else {
            false
        };
        let (status, error) = if public_healthy {
            ("healthy", None)
        } else if !routing_ok {
            (
                "degraded",
                Some(
                    "Service routing could not be refreshed; check deployment and Cloudflare connectivity",
                ),
            )
        } else if !tunnel_healthy {
            (
                "pending",
                Some("Waiting for Cloudflare to observe an active tunnel connector"),
            )
        } else {
            (
                "degraded",
                Some("Tunnel is connected; waiting for the public HTTPS health check to succeed"),
            )
        };
        sqlx::query("UPDATE domains SET status=$2,error=$3,updated_at=now() WHERE id=$1 AND status IN ('pending','healthy','degraded')").bind(id).bind(status).bind(error).execute(&app.db).await?;
    }
    app.events.send(()).ok();
    Ok(())
}

#[cfg(test)]
#[path = "integrations_tests.rs"]
mod tests;
