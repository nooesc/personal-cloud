use super::*;
use axum::{body::to_bytes, extract::Request};
use rsa::pkcs8::EncodePrivateKey;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicI64, Ordering},
};

#[test]
fn rfc7636_pkce_vector_and_cookie_boundary() {
    assert_eq!(
        pkce("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let mut h = HeaderMap::new();
    h.insert(
        header::COOKIE,
        "other=a; pc_github_flow=browser; pc_session=owner"
            .parse()
            .unwrap(),
    );
    assert_eq!(browser_cookie(&h), Some("browser"));
}
struct Mock {
    user: AtomicI64,
    bodies: Mutex<Vec<Value>>,
}
async fn provider(mock: Arc<Mock>, req: Request) -> Response {
    let path = req.uri().path().to_string();
    let body = to_bytes(req.into_body(), 1024 * 1024).await.unwrap();
    if !body.is_empty() {
        mock.bodies
            .lock()
            .unwrap()
            .push(serde_json::from_slice(&body).unwrap());
    }
    let value = match path.as_str() {
        "/oauth" => {
            json!({"access_token":"test-user-token","refresh_token":"test-refresh-token","expires_in":28800})
        }
        "/user/installations" => {
            json!({"installations":[{"id":123,"app_id":77,"account":{"login":"Owner","type":"Organization"},"repository_selection":"selected","suspended_at":null},{"id":999,"app_id":88,"suspended_at":null},{"id":456,"app_id":77,"suspended_at":"2026-01-01"}]})
        }
        "/user" => json!({"id":mock.user.load(Ordering::SeqCst),"login":"owner-renamed"}),
        "/repos/Owner/Repo/installation" => json!({"id":123,"app_id":77,"suspended_at":null}),
        "/app/installations/123/access_tokens" => json!({"token":"repo-only-installation-token"}),
        _ => return (StatusCode::NOT_FOUND, Json(json!({"message":"Not found"}))).into_response(),
    };
    Json(value).into_response()
}
fn callback(state: String) -> Callback {
    Callback {
        state,
        code: Some("testcode".into()),
        error: None,
        installation_id: None,
        setup_action: None,
    }
}
async fn flow(app: &App, purpose: &str) -> (Callback, HeaderMap, String) {
    let (state, verifier, cookie) = new_flow(app, &HeaderMap::new(), purpose).await.unwrap();
    assert!(cookie.contains("HttpOnly; SameSite=Lax; Path=/api/github"));
    assert!(cookie.contains("Secure"));
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        cookie.split(';').next().unwrap().parse().unwrap(),
    );
    (callback(state), headers, verifier)
}
#[tokio::test]
#[ignore = "requires PC_TEST_DATABASE_URL; creates an isolated schema"]
async fn postgres_browser_identity_repository_and_revocation_boundaries() -> anyhow::Result<()> {
    let url = std::env::var("PC_TEST_DATABASE_URL")?;
    let admin = sqlx::PgPool::connect(&url).await?;
    let schema = format!("pc_github_test_{}", uuid::Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await?;
    let isolated = schema.clone();
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |conn, _| {
            let schema = isolated.clone();
            Box::pin(async move {
                sqlx::query("SELECT set_config('search_path',$1,false)")
                    .bind(schema)
                    .execute(conn)
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await?;
    let app = App {
        db: db.clone(),
        admin_hash: Arc::new(hash("recovery-test-token")),
        origin: Arc::new("https://cloud.example.test".into()),
        secret_key: Arc::new([42; 32]),
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        events: tokio::sync::broadcast::channel(16).0,
    };
    let mock = Arc::new(Mock {
        user: AtomicI64::new(42),
        bodies: Mutex::new(Vec::new()),
    });
    let handler = mock.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().fallback(move |r: Request| provider(handler.clone(), r)),
        )
        .await
        .unwrap();
    });
    let outcome:anyhow::Result<()>=async {
        sqlx::migrate!("../../migrations").run(&db).await?;
        assert_eq!(auth_start(State(app.clone()),HeaderMap::new(),Json(AuthInput{purpose:"login".into()})).await.unwrap_err().0,StatusCode::BAD_REQUEST);
        assert_eq!(auth_start(State(app.clone()),HeaderMap::new(),Json(AuthInput{purpose:"link".into()})).await.unwrap_err().0,StatusCode::UNAUTHORIZED);
        assert_eq!(manifest_start(State(app.clone()),HeaderMap::new(),Json(ManifestInput{organization:String::new()})).await.unwrap_err().0,StatusCode::UNAUTHORIZED);
        let pem=rsa::RsaPrivateKey::new(&mut rand::thread_rng(),2048)?.to_pkcs8_pem(Default::default())?;
        let cfg=json!({"id":77,"client_id":"Iv.test","client_secret":"test-client-secret","pem":pem.as_str(),"slug":"test-app","name":"Test App","webhook_secret":"test-hook"});
        let mut tx=db.begin().await?;integrations::save_secret(&app,&mut tx,"github.app",&cfg.to_string()).await?;tx.commit().await?;
        // Browser binding is checked before consuming the valid flow.
        let (q,h,verifier)=flow(&app,"link").await;
        assert!(consume_flow(&app,&HeaderMap::new(),&q.state,&["link"]).await.is_err());
        assert!(consume_flow(&app,&h,&q.state,&["manifest"]).await.is_err());
        let encrypted:String=sqlx::query_scalar("SELECT verifier_encrypted FROM github_flows WHERE state_hash=$1").bind(hash(&q.state)).fetch_one(&db).await?;
        assert!(!encrypted.contains(&verifier));
        assert_eq!(complete_auth(&app,&h,&q,&base,&format!("{base}/oauth")).await.unwrap(),42);
        assert_eq!(mock.bodies.lock().unwrap()[0]["code_verifier"],verifier);
        assert!(consume_flow(&app,&h,&q.state,&["link"]).await.is_err());
        let ciphertext:String=sqlx::query_scalar("SELECT ciphertext FROM integration_secrets WHERE key='github.user'").fetch_one(&db).await?;
        assert!(!ciphertext.contains("test-user-token"));
        assert!(active(&app).await?);
        // A different numeric account cannot log in OR replace the linked owner.
        mock.user.store(99,Ordering::SeqCst);
        for purpose in ["login","link"] {let(q,h,_)=flow(&app,purpose).await;assert_eq!(complete_auth(&app,&h,&q,&base,&format!("{base}/oauth")).await.unwrap_err().0,StatusCode::FORBIDDEN);}
        mock.user.store(42,Ordering::SeqCst);
        let(q,h,_)=flow(&app,"login").await; assert_eq!(complete_auth(&app,&h,&q,&base,&format!("{base}/oauth")).await.unwrap(),42);
        // Expiration, cancellation and owner credential changes invalidate a flow.
        let(q,h,_)=flow(&app,"login").await;sqlx::query("UPDATE github_flows SET expires_at=now()-interval '1 second'").execute(&db).await?;assert!(consume_flow(&app,&h,&q.state,&["login"]).await.is_err());
        let(mut q,h,_)=flow(&app,"login").await;q.error=Some("access_denied".into());assert!(complete_auth(&app,&h,&q,&base,&format!("{base}/oauth")).await.is_err());assert!(consume_flow(&app,&h,&q.state,&["login"]).await.is_err());
        let(q,h,_)=flow(&app,"link").await;let mut changed=app.clone();changed.admin_hash=Arc::new(hash("rotated"));assert!(consume_flow(&changed,&h,&q.state,&["link"]).await.is_err());
        // An App installation alone does not authorize workspace source access.
        assert!(repository_token_at(&app,"Owner/Repo",&base).await.is_err());
        assert!(synchronize_at(&app,Some(999),&base).await.is_err());
        assert!(synchronize_at(&app,Some(456),&base).await.is_err());
        assert_eq!(synchronize_at(&app,Some(123),&base).await?["accounts"],1);
        assert_eq!(repository_token_at(&app,"Owner/Repo",&base).await?,"repo-only-installation-token");
        let last=mock.bodies.lock().unwrap().last().unwrap().clone();assert_eq!(last,json!({"repositories":["Repo"],"permissions":{"contents":"read","metadata":"read"}}));
        // App-level push delivery shares the durable outbox but requires a verified installation.
        let project=uuid::Uuid::new_v4(); let service=uuid::Uuid::new_v4();
        sqlx::query("INSERT INTO projects(id,name,repository,branch) VALUES($1,'GitHub test','Owner/Repo','main')").bind(project).execute(&db).await?;
        sqlx::query("INSERT INTO services(id,project_id,name,port) VALUES($1,$2,'web',3000)").bind(service).bind(project).execute(&db).await?;
        for (installation,expected) in [(999,0),(123,1),(123,0)] {
            let body=Bytes::from(json!({"installation":{"id":installation},"repository":{"full_name":"Owner/Repo"},"ref":"refs/heads/main","after":"a".repeat(40)}).to_string());
            use hmac::Mac;let mut mac=hmac::Hmac::<Sha256>::new_from_slice(b"test-hook")?;mac.update(&body);
            let mut h=HeaderMap::new();h.insert("x-github-event","push".parse()?);h.insert("x-github-delivery",format!("push-{installation}").parse()?);h.insert("x-hub-signature-256",format!("sha256={:x}",mac.finalize().into_bytes()).parse()?);
            assert_eq!(webhook(State(app.clone()),h,body).await.unwrap().1.0["queued"],expected);
        }
        // Signed uninstall removes access; forged events cannot revoke it.
        let body=Bytes::from(json!({"action":"deleted","installation":{"id":123}}).to_string());
        let mut headers=HeaderMap::new();headers.insert("x-github-event","installation".parse()?);headers.insert("x-github-delivery","delete-test".parse()?);
        assert_eq!(webhook(State(app.clone()),headers.clone(),body.clone()).await.unwrap_err().0,StatusCode::UNAUTHORIZED);
        use hmac::Mac;let mut mac=hmac::Hmac::<Sha256>::new_from_slice(b"test-hook")?;mac.update(&body);let signature=format!("sha256={:x}",mac.finalize().into_bytes());headers.insert("x-hub-signature-256",signature.parse()?);
        assert_eq!(webhook(State(app.clone()),headers,body).await.unwrap().0,StatusCode::ACCEPTED);
        assert!(repository_token_at(&app,"Owner/Repo",&base).await.is_err());
        // Owner recovery survives unlink; GitHub sessions do not.
        let recovery=crate::issue_session(&app,None).await.unwrap();let oauth=crate::issue_session(&app,Some(42)).await.unwrap();
        let mut rh=HeaderMap::new();rh.insert(header::COOKIE,recovery.headers()[header::SET_COOKIE].to_str()?.split(';').next().unwrap().parse()?);
        let mut oh=HeaderMap::new();oh.insert(header::COOKIE,oauth.headers()[header::SET_COOKIE].to_str()?.split(';').next().unwrap().parse()?);
        assert!(owner(&app,&oh).await.is_ok());assert!(unlink(State(app.clone()),oh.clone()).await.is_err());
        let mut recovery_auth=HeaderMap::new();recovery_auth.insert(header::AUTHORIZATION,"Bearer recovery-test-token".parse()?);
        let _ = unlink(State(app.clone()),recovery_auth).await.unwrap();assert!(owner(&app,&oh).await.is_err());assert!(owner(&app,&rh).await.is_ok());
        assert!(active(&app).await?);assert!(integrations::github_token(&app,"Owner/Repo").await.is_err());
        // A callback that finished its provider request after unlink cannot mint usable access.
        let stale=crate::issue_session(&app,Some(42)).await.unwrap();let mut h=HeaderMap::new();h.insert(header::COOKIE,stale.headers()[header::SET_COOKIE].to_str()?.split(';').next().unwrap().parse()?);assert!(owner(&app,&h).await.is_err());
        Ok(())
    }.await;
    server.abort();
    db.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await?;
    outcome
}
