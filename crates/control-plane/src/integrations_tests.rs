use super::*;
use axum::{extract::Request, response::IntoResponse};
use std::sync::{Arc, Mutex};

#[test]
fn github_documented_signature_and_tampering() {
    // Official GitHub webhook verification vector.
    let signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    assert!(signature_valid(
        "It's a Secret to Everybody",
        signature,
        b"Hello, World!"
    ));
    assert!(!signature_valid(
        "It's a Secret to Everybody",
        signature,
        b"Hello, World?"
    ));
    assert!(!signature_valid("wrong", signature, b"Hello, World!"));
    for bad in ["", "sha1=757107", "sha256=zzzz", "sha256=🔒"] {
        assert!(!signature_valid("secret", bad, b"payload"));
    }
}
#[test]
fn only_non_deleted_branch_pushes_produce_targets() {
    let sha = "a".repeat(40);
    let mut payload = json!({"repository":{"full_name":"owner/repo"},"ref":"refs/heads/feature/name","after":sha});
    assert_eq!(
        push_target(&payload),
        Some(("owner/repo", "feature/name", sha.as_str()))
    );
    payload["ref"] = json!("refs/tags/v1");
    assert!(push_target(&payload).is_none());
    payload["ref"] = json!("refs/heads/main");
    payload["deleted"] = json!(true);
    assert!(push_target(&payload).is_none());
    payload["deleted"] = json!(false);
    payload["after"] = json!("0".repeat(40));
    assert!(push_target(&payload).is_none());
    payload["after"] = json!("; untrusted shell text");
    assert!(push_target(&payload).is_none());
}
#[test]
fn domain_boundary_rejects_confusables_and_suffix_attacks() {
    for host in ["example.com", "api.example.com", "a-b.example.com"] {
        assert!(hostname_in_zone(host, "example.com"));
    }
    for host in [
        "evilexample.com",
        "example.com.evil.com",
        "*.example.com",
        "a..example.com",
        "-a.example.com",
        "a-.example.com",
        "é.example.com",
        "api.example.com/path",
        "api.example.com:443",
    ] {
        assert!(!hostname_in_zone(host, "example.com"), "accepted {host}");
    }
}
#[test]
fn tunnel_config_has_safe_catchall() {
    let config = tunnel_configuration("app.example.com", "http://10.42.0.2:32100");
    assert_eq!(
        config["config"]["ingress"][0]["service"],
        "http://10.42.0.2:32100"
    );
    assert_eq!(
        config["config"]["ingress"][1],
        json!({"service":"http_status:404"})
    );
}
#[test]
fn r2_signature_is_scoped_and_bucket_is_path_safe() {
    let (auth, hash) = r2_authorization(
        "test.r2.cloudflarestorage.com",
        "pc-registry",
        "access",
        "secret",
        "20260915T120000Z",
    );
    assert_eq!(
        hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert!(auth.starts_with("AWS4-HMAC-SHA256 Credential=access/20260915/auto/s3/aws4_request,"));
    assert!(!auth.contains("secret"));
    assert_ne!(
        auth,
        r2_authorization(
            "test.r2.cloudflarestorage.com",
            "other-bucket",
            "access",
            "secret",
            "20260915T120000Z"
        )
        .0
    );
    for invalid in [
        "a",
        "a/b",
        "../bucket",
        "UPPER",
        "bucket?x=1",
        "-bucket",
        "bucket-",
    ] {
        assert!(!valid_bucket(invalid));
    }
}

type Captured = Arc<Mutex<Vec<(String, String, HeaderMap, Value)>>>;
async fn server(
    status: StatusCode,
    response: Value,
) -> (String, Captured, tokio::task::JoinHandle<()>) {
    let captured: Captured = Arc::new(Mutex::new(Vec::new()));
    let observations = captured.clone();
    let router = Router::new().fallback(move |request: Request| {
        let captured = observations.clone();
        let response = response.clone();
        async move {
            let (parts, body) = request.into_parts();
            let body = axum::body::to_bytes(body, 1024 * 1024).await.unwrap();
            let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
            captured.lock().unwrap().push((
                parts.method.to_string(),
                parts.uri.to_string(),
                parts.headers,
                json,
            ));
            (status, Json(response)).into_response()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (format!("http://{address}"), captured, task)
}
#[tokio::test]
async fn provider_uses_real_http_auth_and_expected_tunnel_request() {
    let (base, seen, task) = server(
        StatusCode::OK,
        json!({"success":true,"result":{"id":"tunnel-id"}}),
    )
    .await;
    let client = Client::new();
    let provider = Provider {
        client: &client,
        base: &base,
        token: "test-provider-token",
        cloudflare: true,
    };
    let data = provider
        .cf(
            Method::POST,
            "/accounts/account/cfd_tunnel",
            Some(json!({"name":"personal-cloud-test","config_src":"cloudflare"})),
        )
        .await
        .unwrap();
    assert_eq!(data["id"], "tunnel-id");
    let requests = seen.lock().unwrap();
    assert_eq!(requests[0].0, "POST");
    assert_eq!(requests[0].1, "/accounts/account/cfd_tunnel");
    assert_eq!(requests[0].2["authorization"], "Bearer test-provider-token");
    assert_eq!(requests[0].3["config_src"], "cloudflare");
    task.abort();
}
#[tokio::test]
async fn github_headers_and_provider_errors_never_echo_secret_bodies() {
    let (base, seen, task) = server(
        StatusCode::FORBIDDEN,
        json!({"message":"sensitive-test-provider-token"}),
    )
    .await;
    let client = Client::new();
    let provider = Provider {
        client: &client,
        base: &base,
        token: "test-provider-token",
        cloudflare: false,
    };
    let error = provider.get("/user").await.unwrap_err().to_string();
    assert!(error.contains("403"));
    assert!(!error.contains("test-provider-token"));
    let requests = seen.lock().unwrap();
    assert_eq!(requests[0].2["accept"], "application/vnd.github+json");
    assert_eq!(requests[0].2["x-github-api-version"], "2022-11-28");
    task.abort();
}
#[tokio::test]
async fn cleanup_tolerates_missing_owned_resource_but_not_denied_deletion() {
    let client = Client::new();
    for (status, expected) in [
        (StatusCode::NOT_FOUND, true),
        (StatusCode::FORBIDDEN, false),
        (StatusCode::OK, true),
    ] {
        let (base, seen, task) =
            server(status, json!({"success":true,"result":{"id":"owned-id"}})).await;
        let provider = Provider {
            client: &client,
            base: &base,
            token: "test-token",
            cloudflare: true,
        };
        assert_eq!(
            provider
                .delete("/zones/zone/dns_records/owned-id")
                .await
                .is_ok(),
            expected
        );
        assert_eq!(seen.lock().unwrap()[0].0, "DELETE");
        task.abort();
    }
    let (base, _, task) = server(
        StatusCode::OK,
        json!({"success":false,"errors":[{"message":"private detail"}]}),
    )
    .await;
    let provider = Provider {
        client: &client,
        base: &base,
        token: "test-token",
        cloudflare: true,
    };
    assert!(provider.delete("/owned").await.is_err());
    assert!(provider.cf(Method::GET, "/owned", None).await.is_err());
    task.abort();
}

#[tokio::test]
#[ignore = "requires PC_TEST_DATABASE_URL for a disposable PostgreSQL schema"]
async fn postgres_webhook_atomic_deduplication_and_secret_isolation() -> anyhow::Result<()> {
    let url = std::env::var("PC_TEST_DATABASE_URL")?;
    let admin = sqlx::PgPool::connect(&url).await?;
    let schema = format!("pc_integration_test_{}", Uuid::new_v4().simple());
    sqlx::raw_sql(&format!("CREATE SCHEMA {schema}"))
        .execute(&admin)
        .await?;
    let search_path = schema.clone();
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .after_connect(move |connection, _| {
            let schema = search_path.clone();
            Box::pin(async move {
                sqlx::query(&format!("SET search_path TO {schema}"))
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await?;
    let result: anyhow::Result<()>=async {
        for migration in [include_str!("../../../migrations/0001_control_plane.sql"),include_str!("../../../migrations/0003_runtime.sql"),include_str!("../../../migrations/0004_integrations.sql")] {
            sqlx::raw_sql(migration).execute(&db).await?;
        }
        let app=App{db:db.clone(),admin_hash:Arc::new("test".into()),origin:Arc::new("http://127.0.0.1".into()),client:Client::builder().redirect(reqwest::redirect::Policy::none()).build()?,secret_key:Arc::new([42;32]),events:tokio::sync::broadcast::channel(16).0};
        let mut tx=db.begin().await?;
        save_secret(&app,&mut tx,"github.webhook","test-webhook-secret").await?;
        save_secret(&app,&mut tx,"github.token","test-private-token").await?;
        tx.commit().await?;
        assert_eq!(github_token(&app,"Owner/Repo").await?,Some("test-private-token".into()));
        let ciphertext:String=sqlx::query_scalar("SELECT ciphertext FROM integration_secrets WHERE key='github.token'").fetch_one(&db).await?;
        assert!(!ciphertext.contains("test-private-token"));
        assert!(crypto::open(&app,"integration:cloudflare.token",&ciphertext).is_err());
        let project=Uuid::new_v4(); let service=Uuid::new_v4();let disabled=Uuid::new_v4();
        sqlx::query("INSERT INTO projects(id,name,repository,branch) VALUES($1,'Test','Owner/Repo','main')").bind(project).execute(&db).await?;
        sqlx::query("INSERT INTO services(id,project_id,name,port) VALUES($1,$2,'web',3000)").bind(service).bind(project).execute(&db).await?;
        sqlx::query("INSERT INTO services(id,project_id,name,port,auto_deploy) VALUES($1,$2,'disabled',3001,false)").bind(disabled).bind(project).execute(&db).await?;
        let sha="a".repeat(40);
        let body=Bytes::from(json!({"ref":"refs/heads/main","repository":{"full_name":"owner/repo"},"after":sha}).to_string());
        let signature=format!("sha256={}",hex(&hmac(b"test-webhook-secret",std::str::from_utf8(&body)?)));
        let mut headers=HeaderMap::new();headers.insert("x-hub-signature-256",signature.parse()?);headers.insert("x-github-event","push".parse()?);headers.insert("x-github-delivery","delivery-one".parse()?);
        let (first,second)=tokio::join!(webhook(State(app.clone()),headers.clone(),body.clone()),webhook(State(app.clone()),headers.clone(),body.clone()));
        let first=first.map_err(|e|anyhow::anyhow!(e.1))?;let second=second.map_err(|e|anyhow::anyhow!(e.1))?;
        assert_eq!(first.0,StatusCode::ACCEPTED);assert_ne!(first.1.0["duplicate"],second.1.0["duplicate"]);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM github_deliveries").fetch_one(&db).await?,1);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM github_deploy_requests").fetch_one(&db).await?,1);
        assert_eq!(sqlx::query_scalar::<_,Uuid>("SELECT service_id FROM github_deploy_requests").fetch_one(&db).await?,service);
        // Another signed delivery of the same commit also deduplicates service work.
        headers.insert("x-github-delivery","delivery-two".parse()?);
        let _ = webhook(State(app.clone()),headers.clone(),body.clone()).await.map_err(|e|anyhow::anyhow!(e.1))?;
        headers.insert("x-github-delivery","invalid-signature".parse()?);
        assert!(webhook(State(app.clone()),headers.clone(),Bytes::from_static(b"tampered")).await.is_err());
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM github_deliveries").fetch_one(&db).await?,2);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM github_deploy_requests").fetch_one(&db).await?,1);
        // Simulate restart after deployment insertion, before outbox acknowledgement.
        sqlx::query("INSERT INTO deployments(id,service_id,status,commit_sha) VALUES($1,$2,'queued',$3)").bind(Uuid::new_v4()).bind(service).bind(&sha).execute(&db).await?;
        let older_sha="b".repeat(40);
        sqlx::query("INSERT INTO github_deploy_requests(service_id,commit_sha,attempts,created_at) VALUES($1,$2,50,now()-interval '1 hour')").bind(service).bind(&older_sha).execute(&db).await?;
        process_pushes(&app).await?;process_pushes(&app).await?;
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM deployments").fetch_one(&db).await?,1);
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT status FROM github_deploy_requests WHERE commit_sha=$1").bind(&sha).fetch_one(&db).await?,"queued");
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT status FROM github_deploy_requests WHERE commit_sha=$1").bind(&older_sha).fetch_one(&db).await?,"superseded");
        Ok(())
    }.await;
    db.close().await;
    sqlx::raw_sql(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&admin)
        .await?;
    result
}

#[tokio::test]
async fn cleanup_refuses_dns_record_that_was_repurposed() {
    let client = Client::new();
    let (base,seen,task)=server(StatusCode::OK,json!({"success":true,"result":{"id":"owned-id","name":"app.example.com","type":"CNAME","comment":"some-other-owner"}})).await;
    let provider = Provider {
        client: &client,
        base: &base,
        token: "test-token",
        cloudflare: true,
    };
    assert!(
        provider
            .delete_owned_dns(
                "/zones/zone/dns_records/owned-id",
                "app.example.com",
                "personal-cloud:domain-id",
                "owned-tunnel.cfargotunnel.com"
            )
            .await
            .is_err()
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(seen.lock().unwrap()[0].0, "GET");
    task.abort();
    let (base, seen, task) = server(StatusCode::NOT_FOUND, json!({"success":false})).await;
    let provider = Provider {
        client: &client,
        base: &base,
        token: "test-token",
        cloudflare: true,
    };
    assert!(
        provider
            .delete_owned_dns(
                "/zones/zone/dns_records/owned-id",
                "app.example.com",
                "personal-cloud:domain-id",
                "owned-tunnel.cfargotunnel.com"
            )
            .await
            .is_ok()
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    task.abort();
}

#[test]
fn routing_requires_every_active_connector_to_acknowledge_version() {
    assert!(!connectors_applied(&json!([]), 2));
    assert!(!connectors_applied(
        &json!([{"config_version":2,"conns":[]}]),
        2
    ));
    assert!(!connectors_applied(
        &json!([{"config_version":1,"conns":[{}]}]),
        2
    ));
    assert!(!connectors_applied(
        &json!([{"config_version":2,"conns":[{}]},{"config_version":1,"conns":[{}]}]),
        2
    ));
    assert!(connectors_applied(
        &json!([{"config_version":2,"conns":[{}]},{"config_version":1,"conns":[]}]),
        2
    ));
}
