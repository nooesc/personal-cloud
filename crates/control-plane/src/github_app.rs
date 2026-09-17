//! GitHub identity is an owner binding; installation grants are separate source access.
//! No first-visitor signup, callback-supplied installation trust, or browser-held tokens.
use crate::{
    ApiError, ApiResult, App, crypto, hash, integrations, invalid, owner, token, unauthorized,
};
use anyhow::Context;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;

const API: &str = "https://api.github.com";
const OAUTH: &str = "https://github.com/login/oauth/access_token";
const COOKIE: &str = "pc_github_flow";

pub fn router() -> Router<App> {
    Router::new()
        .route("/api/github/auth", get(auth_status))
        .route("/api/github/auth/start", post(auth_start))
        .route("/api/github/auth/callback", get(auth_callback))
        .route("/api/github/app", get(app_status))
        .route("/api/github/app/manifest", post(manifest_start))
        .route("/api/github/app/callback", get(manifest_callback))
        .route("/api/github/app/install", post(install_start))
        .route("/api/github/app/installed", get(install_callback))
        .route("/api/github/app/sync", post(sync_installations))
        .route("/api/github/app/identity", delete(unlink))
        .route(
            "/api/github/app/webhook",
            post(webhook).layer(DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
}
fn upstream(_: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, "GitHub connection failed. Reconnect your account and check the app's repository permissions.".into())
}
async fn config(app: &App) -> anyhow::Result<Value> {
    let raw = integrations::secret(app, "github.app")
        .await?
        .context("Register a GitHub App first")?;
    Ok(serde_json::from_str(&raw)?)
}
pub async fn active(app: &App) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM integrations WHERE provider='github' AND metadata->>'mode'='github_app')").fetch_one(&app.db).await?)
}
fn field<'a>(v: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    v[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .context("GitHub omitted a required field")
}
async fn request(
    app: &App,
    auth: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<Value> {
    provider_request(app, API, auth, method, path, body).await
}
async fn provider_request(
    app: &App,
    base: &str,
    auth: &str,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<Value> {
    let mut r = app
        .client
        .request(method, format!("{base}{path}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if !auth.is_empty() {
        r = r.bearer_auth(auth);
    }
    if let Some(body) = body {
        r = r.json(&body);
    }
    let response = r.send().await.context("GitHub unavailable")?;
    anyhow::ensure!(
        response.status().is_success(),
        "GitHub rejected access (HTTP {})",
        response.status().as_u16()
    );
    response.json().await.context("Invalid GitHub response")
}
fn flow_cookie(app: &App, value: &str, age: u32) -> String {
    format!(
        "{COOKIE}={value}; HttpOnly; SameSite=Lax; Path=/api/github; Max-Age={age}{}",
        if app.origin.starts_with("https://") {
            "; Secure"
        } else {
            ""
        }
    )
}
fn browser_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|v| v.strip_prefix("pc_github_flow="))
}
fn pkce(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
async fn new_flow(
    app: &App,
    headers: &HeaderMap,
    purpose: &str,
) -> ApiResult<(String, String, String)> {
    let state = token();
    let browser = token();
    let verifier = token();
    let encrypted = crypto::seal(app, "github:flow", &verifier).map_err(upstream)?;
    sqlx::query("DELETE FROM github_flows WHERE expires_at<=now()")
        .execute(&app.db)
        .await?;
    sqlx::query("INSERT INTO github_flows(state_hash,browser_hash,purpose,verifier_encrypted,admin_hash,owner_session_hash) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(hash(&state)).bind(hash(&browser)).bind(purpose).bind(encrypted).bind(app.admin_hash.as_str())
        .bind(if purpose == "login" { None } else { crate::session_cookie(headers).map(hash) }).execute(&app.db).await?;
    Ok((state, verifier, flow_cookie(app, &browser, 600)))
}
async fn consume_flow(
    app: &App,
    headers: &HeaderMap,
    state: &str,
    purposes: &[&str],
) -> ApiResult<(String, String)> {
    if state.len() != 64 {
        return Err(unauthorized());
    }
    let browser = browser_cookie(headers).ok_or_else(unauthorized)?;
    let row = sqlx::query("UPDATE github_flows SET used_at=now() WHERE used_at IS NULL AND state_hash=$1 AND browser_hash=$2 AND expires_at>now() AND admin_hash=$3 AND purpose=ANY($4) AND (owner_session_hash IS NULL OR EXISTS(SELECT 1 FROM owner_sessions s WHERE s.token_hash=owner_session_hash AND s.admin_hash=$3 AND s.expires_at>now())) RETURNING purpose,verifier_encrypted")
        .bind(hash(state)).bind(hash(browser)).bind(app.admin_hash.as_str()).bind(purposes).fetch_optional(&app.db).await?.ok_or_else(unauthorized)?;
    Ok((
        row.get("purpose"),
        crypto::open(
            app,
            "github:flow",
            &row.get::<String, _>("verifier_encrypted"),
        )
        .map_err(upstream)?,
    ))
}
fn finish(app: &App, result: &str) -> Response {
    let mut response = Redirect::to(&format!("/{result}")).into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, flow_cookie(app, "", 0).parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    response
}
async fn auth_status(State(app): State<App>) -> ApiResult<Json<Value>> {
    let configured: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM integration_secrets WHERE key='github.app')",
    )
    .fetch_one(&app.db)
    .await?;
    let linked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM github_owner)")
        .fetch_one(&app.db)
        .await?;
    Ok(Json(
        json!({"configured":configured,"enabled":configured && linked}),
    ))
}
async fn app_status(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    let cfg = config(&app).await.ok();
    let identity: Option<Value> = sqlx::query_scalar(
        "SELECT jsonb_build_object('login',login,'user_id',user_id) FROM github_owner",
    )
    .fetch_optional(&app.db)
    .await?;
    let installations: Vec<Value> =
        sqlx::query_scalar("SELECT to_jsonb(i) FROM github_installations i ORDER BY account_login")
            .fetch_all(&app.db)
            .await?;
    let connected: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM integration_secrets WHERE key='github.user')",
    )
    .fetch_one(&app.db)
    .await?;
    Ok(Json(
        json!({"configured":cfg.is_some(),"name":cfg.as_ref().map(|c| &c["name"]),"identity":identity,"user_connected":connected,"installations":installations}),
    ))
}
#[derive(Deserialize)]
struct ManifestInput {
    #[serde(default)]
    organization: String,
}
async fn manifest_start(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<ManifestInput>,
) -> ApiResult<Response> {
    owner(&app, &headers).await?;
    if !input.organization.is_empty()
        && !input
            .organization
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(invalid("Enter a GitHub organization name"));
    }
    if config(&app).await.is_ok() {
        return Err(invalid("A GitHub App is already configured"));
    }
    if !app.origin.starts_with("https://") {
        return Err(invalid(
            "Use a public HTTPS workspace address before registering your GitHub App",
        ));
    }
    let (state, _, cookie) = new_flow(&app, &headers, "manifest").await?;
    let action = if input.organization.is_empty() {
        format!("https://github.com/settings/apps/new?state={state}")
    } else {
        format!(
            "https://github.com/organizations/{}/settings/apps/new?state={state}",
            input.organization
        )
    };
    let origin = app.origin.as_str();
    let manifest = json!({"name":"dinghy", "url":origin,"description":"Deploy selected GitHub repositories to your own dinghy fleet.","public":true,"redirect_url":format!("{origin}/api/github/app/callback"),"callback_urls":[format!("{origin}/api/github/auth/callback")],"setup_url":format!("{origin}/api/github/app/installed"),"setup_on_update":true,"request_oauth_on_install":false,"hook_attributes":{"url":format!("{origin}/api/github/app/webhook"),"active":true},"default_permissions":{"contents":"read","metadata":"read"},"default_events":["push"]});
    Ok((
        [
            (header::SET_COOKIE, cookie),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        Json(json!({"action":action,"manifest":manifest})),
    )
        .into_response())
}
#[derive(Deserialize)]
struct Callback {
    #[serde(default)]
    state: String,
    code: Option<String>,
    error: Option<String>,
    installation_id: Option<i64>,
    setup_action: Option<String>,
}
async fn manifest_callback(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Response {
    let result: ApiResult<()> = async {
        consume_flow(&app, &headers, &q.state, &["manifest"]).await?;
        let code = q
            .code
            .as_deref()
            .filter(|c| c.len() <= 256 && c.bytes().all(|b| b.is_ascii_alphanumeric()))
            .ok_or_else(|| invalid("Missing registration code"))?;
        let cfg = request(
            &app,
            "",
            Method::POST,
            &format!("/app-manifests/{code}/conversions"),
            None,
        )
        .await
        .map_err(upstream)?;
        for key in [
            "pem",
            "client_id",
            "client_secret",
            "webhook_secret",
            "slug",
        ] {
            field(&cfg, key).map_err(upstream)?;
        }
        if cfg["id"].as_i64().is_none() {
            return Err(upstream("Missing app ID"));
        }
        let mut tx = app.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(74103903)")
            .execute(&mut *tx)
            .await?;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM integration_secrets WHERE key='github.app')",
        )
        .fetch_one(&mut *tx)
        .await?;
        if exists {
            return Err(invalid("App already configured"));
        }
        integrations::save_secret(&app, &mut tx, "github.app", &cfg.to_string())
            .await
            .map_err(upstream)?;
        tx.commit().await?;
        Ok(())
    }
    .await;
    finish(
        &app,
        if result.is_ok() {
            "#page=Settings&github=registered"
        } else {
            "#page=Settings&github_error=registration"
        },
    )
}
#[derive(Deserialize)]
struct AuthInput {
    purpose: String,
}
async fn auth_start(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<AuthInput>,
) -> ApiResult<Response> {
    crate::check_origin(&app, &headers)?;
    if !["link", "login"].contains(&input.purpose.as_str()) {
        return Err(invalid("Invalid sign-in action"));
    }
    if input.purpose == "link" {
        owner(&app, &headers).await?;
    } else {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM github_owner)")
            .fetch_one(&app.db)
            .await?;
        if !exists {
            return Err(invalid(
                "The workspace owner must link GitHub in Settings first",
            ));
        }
    }
    let cfg = config(&app).await.map_err(upstream)?;
    let (state, verifier, cookie) = new_flow(&app, &headers, &input.purpose).await?;
    let mut url = reqwest::Url::parse("https://github.com/login/oauth/authorize").unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", field(&cfg, "client_id").map_err(upstream)?)
        .append_pair(
            "redirect_uri",
            &format!("{}/api/github/auth/callback", app.origin),
        )
        .append_pair("state", &state)
        .append_pair("code_challenge", &pkce(&verifier))
        .append_pair("code_challenge_method", "S256");
    Ok((
        [
            (header::SET_COOKIE, cookie),
            (header::CACHE_CONTROL, "no-store".into()),
        ],
        Json(json!({"url":url.as_str()})),
    )
        .into_response())
}
async fn exchange(app: &App, url: &str, body: &Value) -> anyhow::Result<Value> {
    let response = app
        .client
        .post(url)
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await?;
    anyhow::ensure!(
        response.status().is_success(),
        "GitHub authorization failed"
    );
    let mut data: Value = response.json().await?;
    field(&data, "access_token")?;
    anyhow::ensure!(data["error"].is_null(), "GitHub authorization denied");
    data["expires_at"] =
        json!(Utc::now().timestamp() + data["expires_in"].as_i64().unwrap_or(28_800));
    Ok(data)
}
async fn accept_identity(
    app: &App,
    purpose: &str,
    user: &Value,
    tokens: &Value,
    state: &str,
) -> ApiResult<()> {
    let id = user["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(|| upstream("Invalid identity"))?;
    let login = field(user, "login").map_err(upstream)?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(74103903)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(74103904)")
        .execute(&mut *tx)
        .await?;
    let still_authorized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM github_flows WHERE state_hash=$1 AND admin_hash=$2 AND used_at IS NOT NULL AND expires_at>now())").bind(hash(state)).bind(app.admin_hash.as_str()).fetch_one(&mut *tx).await?;
    if !still_authorized {
        return Err(unauthorized());
    }
    let existing: Option<i64> = sqlx::query_scalar("SELECT user_id FROM github_owner")
        .fetch_optional(&mut *tx)
        .await?;
    if existing.is_some_and(|owner| owner != id) || (purpose == "login" && existing != Some(id)) {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "This GitHub account is not the workspace owner".into(),
        ));
    }
    sqlx::query("INSERT INTO github_owner(user_id,login) VALUES($1,$2) ON CONFLICT(singleton) DO UPDATE SET login=excluded.login").bind(id).bind(login).execute(&mut *tx).await?;
    integrations::save_secret(app, &mut tx, "github.user", &tokens.to_string())
        .await
        .map_err(upstream)?;
    sqlx::query("INSERT INTO integrations(provider,metadata) VALUES('github',$1) ON CONFLICT(provider) DO UPDATE SET metadata=excluded.metadata,updated_at=now()")
        .bind(json!({"status":"connected","mode":"github_app","login":login,"push_mode":"app_webhook_and_polling","verified_at":Utc::now()})).execute(&mut *tx).await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok(())
}
async fn auth_callback(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Response {
    let result = complete_auth(&app, &headers, &q, API, OAUTH).await;
    match result {
        Ok(id) => match crate::issue_session(&app, Some(id)).await {
            Ok(session) => {
                let mut response = finish(&app, "#page=Settings&github=connected");
                for cookie in session.headers().get_all(header::SET_COOKIE) {
                    response
                        .headers_mut()
                        .append(header::SET_COOKIE, cookie.clone());
                }
                response
            }
            Err(_) => finish(&app, "#github_error=signin"),
        },
        Err(e) => finish(
            &app,
            if e.0 == StatusCode::FORBIDDEN {
                "#github_error=wrong_account"
            } else if q.error.is_some() {
                "#github_error=cancelled"
            } else {
                "#github_error=signin"
            },
        ),
    }
}
async fn complete_auth(
    app: &App,
    headers: &HeaderMap,
    q: &Callback,
    api_base: &str,
    oauth_url: &str,
) -> ApiResult<i64> {
    let (purpose, verifier) = consume_flow(app, headers, &q.state, &["link", "login"]).await?;
    if q.error.is_some() {
        return Err(invalid("Authorization cancelled"));
    }
    let code = q
        .code
        .as_deref()
        .filter(|c| c.len() < 1024)
        .ok_or_else(|| invalid("Missing code"))?;
    let cfg = config(app).await.map_err(upstream)?;
    let tokens=exchange(app,oauth_url,&json!({"client_id":cfg["client_id"],"client_secret":cfg["client_secret"],"code":code,"code_verifier":verifier,"redirect_uri":format!("{}/api/github/auth/callback",app.origin)})).await.map_err(upstream)?;
    let user = provider_request(
        app,
        api_base,
        field(&tokens, "access_token").map_err(upstream)?,
        Method::GET,
        "/user",
        None,
    )
    .await
    .map_err(upstream)?;
    accept_identity(app, &purpose, &user, &tokens, &q.state).await?;
    Ok(user["id"].as_i64().unwrap())
}
async fn user_token(app: &App) -> anyhow::Result<String> {
    let cfg = config(app).await?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(74103904)")
        .execute(&mut *tx)
        .await?;
    let encrypted: Option<String> =
        sqlx::query_scalar("SELECT ciphertext FROM integration_secrets WHERE key='github.user'")
            .fetch_optional(&mut *tx)
            .await?;
    let mut tokens: Value = serde_json::from_str(&crypto::open(
        app,
        "integration:github.user",
        &encrypted.context("Reconnect GitHub")?,
    )?)?;
    if tokens["expires_at"].as_i64().unwrap_or(0) < Utc::now().timestamp() + 60 {
        let refresh = field(&tokens, "refresh_token")?;
        tokens=exchange(app,OAUTH,&json!({"client_id":cfg["client_id"],"client_secret":cfg["client_secret"],"grant_type":"refresh_token","refresh_token":refresh})).await?;
        integrations::save_secret(app, &mut tx, "github.user", &tokens.to_string()).await?;
    }
    tx.commit().await?;
    Ok(field(&tokens, "access_token")?.to_owned())
}
fn jwt(cfg: &Value) -> anyhow::Result<String> {
    let now = Utc::now().timestamp();
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(field(cfg, "pem")?.as_bytes())?;
    Ok(jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &json!({"iat":now-60,"exp":now+540,"iss":cfg["client_id"]}),
        &key,
    )?)
}
async fn accessible_installations(
    app: &App,
    user: &str,
    cfg: &Value,
    base: &str,
) -> anyhow::Result<Vec<Value>> {
    let mut result = Vec::new();
    for page in 1..=100 {
        let value = provider_request(
            app,
            base,
            user,
            Method::GET,
            &format!("/user/installations?per_page=100&page={page}"),
            None,
        )
        .await?;
        let rows = value["installations"]
            .as_array()
            .context("Invalid installations")?;
        result.extend(
            rows.iter()
                .filter(|v| v["app_id"] == cfg["id"] && v["suspended_at"].is_null())
                .cloned(),
        );
        if rows.len() < 100 {
            return Ok(result);
        }
    }
    anyhow::bail!("Too many installations")
}
async fn synchronize(app: &App, required: Option<i64>) -> anyhow::Result<Value> {
    synchronize_at(app, required, API).await
}
async fn synchronize_at(app: &App, required: Option<i64>, base: &str) -> anyhow::Result<Value> {
    let cfg = config(app).await?;
    let user = user_token(app).await?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(74103904)")
        .execute(&mut *tx)
        .await?;
    let list = accessible_installations(app, &user, &cfg, base).await?;
    if let Some(id) = required {
        anyhow::ensure!(
            list.iter().any(|v| v["id"].as_i64() == Some(id)),
            "Installation not authorized; organization approval may still be pending"
        );
    }
    // Serialize against disconnect/revocation and do not resurrect an unlinked identity.
    let linked: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM integration_secrets WHERE key='github.user')",
    )
    .fetch_one(&mut *tx)
    .await?;
    anyhow::ensure!(linked, "Reconnect GitHub");
    sqlx::query("DELETE FROM github_installations")
        .execute(&mut *tx)
        .await?;
    for i in &list {
        sqlx::query("INSERT INTO github_installations(id,account_login,account_type,repository_selection) VALUES($1,$2,$3,$4)").bind(i["id"].as_i64().context("Missing installation ID")?).bind(field(&i["account"],"login")?).bind(field(&i["account"],"type")?).bind(field(i,"repository_selection")?).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    app.events.send(()).ok();
    Ok(json!({"accounts":list.len()}))
}
async fn sync_installations(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    owner(&app, &headers).await?;
    Ok(Json(synchronize(&app, None).await.map_err(upstream)?))
}
async fn install_start(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    owner(&app, &headers).await?;
    let cfg = config(&app).await.map_err(upstream)?;
    user_token(&app).await.map_err(upstream)?;
    let (state, _, cookie) = new_flow(&app, &headers, "install").await?;
    let slug = field(&cfg, "slug").map_err(upstream)?;
    if !slug.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err(upstream("Invalid app slug"));
    }
    Ok(([(header::SET_COOKIE,cookie)],Json(json!({"url":format!("https://github.com/apps/{slug}/installations/new?state={state}")}))).into_response())
}
async fn install_callback(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Response {
    // Returning from GitHub's own settings may have no flow. It never changes local access.
    let result: ApiResult<()> = async {
        consume_flow(&app, &headers, &q.state, &["install"]).await?;
        if q.setup_action.as_deref() == Some("request") {
            return Err(invalid("Approval pending"));
        }
        let id = q
            .installation_id
            .filter(|id| *id > 0)
            .ok_or_else(|| invalid("No installation"))?;
        synchronize(&app, Some(id)).await.map_err(upstream)?;
        Ok(())
    }
    .await;
    finish(
        &app,
        if result.is_ok() {
            "#page=Settings&github=installed"
        } else {
            "#page=Settings&github_error=installation"
        },
    )
}
pub async fn repositories(app: &App) -> anyhow::Result<Value> {
    let user = user_token(app).await?;
    let ids: Vec<i64> =
        sqlx::query_scalar("SELECT id FROM github_installations ORDER BY account_login")
            .fetch_all(&app.db)
            .await?;
    let mut result = Vec::new();
    for id in ids {
        for page in 1..=100 {
            let value = request(
                app,
                &user,
                Method::GET,
                &format!("/user/installations/{id}/repositories?per_page=100&page={page}"),
                None,
            )
            .await?;
            let rows = value["repositories"]
                .as_array()
                .context("Invalid repositories")?;
            result.extend(rows.iter().map(|r| json!({"full_name":r["full_name"],"default_branch":r["default_branch"],"private":r["private"],"installation_id":id,"owner":r["owner"]["login"]})));
            if rows.len() < 100 {
                break;
            }
            anyhow::ensure!(page < 100, "Repository list is too large");
        }
    }
    result.sort_by(|a, b| a["full_name"].as_str().cmp(&b["full_name"].as_str()));
    Ok(json!({"repositories":result}))
}
pub async fn repository_token(app: &App, repository: &str) -> anyhow::Result<String> {
    repository_token_at(app, repository, API).await
}
async fn repository_token_at(app: &App, repository: &str, base: &str) -> anyhow::Result<String> {
    let repo = personal_cloud_core::github_repository(repository)?;
    let cfg = config(app).await?;
    let auth = jwt(&cfg)?;
    let installation = provider_request(
        app,
        base,
        &auth,
        Method::GET,
        &format!("/repos/{repo}/installation"),
        None,
    )
    .await?;
    let id = installation["id"]
        .as_i64()
        .context("Missing installation")?;
    anyhow::ensure!(
        installation["app_id"] == cfg["id"] && installation["suspended_at"].is_null(),
        "Installation unavailable"
    );
    let granted: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM github_installations WHERE id=$1)")
            .bind(id)
            .fetch_one(&app.db)
            .await?;
    anyhow::ensure!(
        granted,
        "Connect this repository's account in GitHub settings"
    );
    // Jobs get only a short-lived token for their source repo, not an org-wide credential.
    let result=provider_request(app,base,&auth,Method::POST,&format!("/app/installations/{id}/access_tokens"),Some(json!({"repositories":[repo.split('/').nth(1).unwrap()],"permissions":{"contents":"read","metadata":"read"}}))).await?;
    Ok(field(&result, "token")?.to_owned())
}
async fn unlink(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    // Require recovery credential, so a compromised OAuth session cannot replace the owner.
    crate::check_origin(&app, &headers)?;
    if crate::bearer(&headers).is_none() {
        return Err(invalid("Use the owner recovery token to unlink GitHub"));
    }
    owner(&app, &headers).await?;
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(74103903)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(74103904)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM owner_sessions WHERE github_user_id IS NOT NULL")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM github_flows")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM github_installations")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM github_owner")
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM integration_secrets WHERE key='github.user'")
        .execute(&mut *tx)
        .await?;
    // Keep App mode to avoid silently reactivating a previously saved PAT.
    sqlx::query("UPDATE integrations SET metadata=metadata || '{\"status\":\"not_connected\"}'::jsonb WHERE provider='github' AND metadata->>'mode'='github_app'").execute(&mut *tx).await?;
    tx.commit().await?;
    app.events.send(()).ok();
    Ok(Json(json!({"ok":true})))
}
async fn webhook(
    State(app): State<App>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let cfg = config(&app).await.map_err(upstream)?;
    let signature = headers
        .get("x-hub-signature-256")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !integrations::signature_valid(
        field(&cfg, "webhook_secret").map_err(upstream)?,
        signature,
        &body,
    ) {
        return Err(unauthorized());
    }
    let payload: Value = serde_json::from_slice(&body).map_err(|_| invalid("Invalid webhook"))?;
    let event = headers
        .get("x-github-event")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if event == "installation"
        && ["deleted", "suspend"].contains(&payload["action"].as_str().unwrap_or(""))
        && let Some(id) = payload["installation"]["id"].as_i64()
    {
        let mut tx = app.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(74103904)")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM github_installations WHERE id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    if event == "github_app_authorization" && payload["action"] == "revoked" {
        let id = payload["sender"]["id"]
            .as_i64()
            .ok_or_else(|| invalid("Missing user ID"))?;
        let mut tx = app.db.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(74103904)")
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM owner_sessions WHERE github_user_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM integration_secrets WHERE key='github.user' AND EXISTS(SELECT 1 FROM github_owner WHERE user_id=$1)").bind(id).execute(&mut *tx).await?;
        tx.commit().await?;
    }
    if event == "push" {
        let id = payload["installation"]["id"]
            .as_i64()
            .ok_or_else(|| invalid("Missing installation"))?;
        let granted: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM github_installations WHERE id=$1)")
                .bind(id)
                .fetch_one(&app.db)
                .await?;
        if !granted {
            return Ok((
                StatusCode::ACCEPTED,
                Json(json!({"accepted":true,"queued":0})),
            ));
        }
    }
    integrations::receive_webhook(&app, &headers, &body).await
}

#[cfg(test)]
mod tests;
