//! Regression tests use PostgreSQL transactions and the production lifecycle helpers.
//! The bounded scheduler only supplies deterministic protocol responses; it never runs workloads.
use super::*;
use axum::{body::to_bytes, extract::Request, response::IntoResponse};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::Notify;

const OLD_ADDRESS: &str = "http://10.42.0.2:29000";
const NEW_ADDRESS: &str = "http://10.42.0.2:30000";

struct SchedulerState {
    machine: Uuid,
    node: Uuid,
    allocation: Uuid,
    requests: Mutex<Vec<(String, String)>>,
    pause_delete: AtomicBool,
    fail_delete: AtomicBool,
    delete_reached: Notify,
    release_delete: Notify,
}
struct Fixture {
    app: App,
    admin: sqlx::PgPool,
    schema: String,
    project: Uuid,
    service: Uuid,
    previous: Uuid,
    scheduler: Arc<SchedulerState>,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new() -> anyhow::Result<Self> {
        let url = std::env::var("PC_TEST_DATABASE_URL")
            .context("Set PC_TEST_DATABASE_URL to the disposable PostgreSQL instance")?;
        let admin = sqlx::PgPool::connect(&url).await?;
        let schema = format!("pc_lifecycle_{}", Uuid::new_v4().simple());
        sqlx::raw_sql(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await?;
        let isolated = schema.clone();
        let db=sqlx::postgres::PgPoolOptions::new().max_connections(8).after_connect(move |connection,_| {
            let schema=isolated.clone();
            Box::pin(async move {
                sqlx::query("SELECT set_config('search_path',$1,false),set_config('application_name',$1,false),set_config('statement_timeout','10000',false)").bind(schema).execute(connection).await?;
                Ok(())
            })
        }).connect(&url).await?;
        for migration in [
            include_str!("../../../../migrations/0001_control_plane.sql"),
            include_str!("../../../../migrations/0002_owner_sessions.sql"),
            include_str!("../../../../migrations/0003_runtime.sql"),
            include_str!("../../../../migrations/0004_integrations.sql"),
            include_str!("../../../../migrations/0005_networking.sql"),
            include_str!("../../../../migrations/0006_health.sql"),
            include_str!("../../../../migrations/0007_deployment_recovery.sql"),
            include_str!("../../../../migrations/0008_atomic_promotion.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&db).await?;
        }
        let scheduler = Arc::new(SchedulerState {
            machine: Uuid::new_v4(),
            node: Uuid::new_v4(),
            allocation: Uuid::new_v4(),
            requests: Mutex::new(Vec::new()),
            pause_delete: AtomicBool::new(false),
            fail_delete: AtomicBool::new(false),
            delete_reached: Notify::new(),
            release_delete: Notify::new(),
        });
        let handler = scheduler.clone();
        let router = Router::new()
            .fallback(move |request: Request| scheduler_response(handler.clone(), request));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let app = App {
            db,
            admin_hash: Arc::new("test-owner-hash".into()),
            origin: Arc::new("http://127.0.0.1".into()),
            events: tokio::sync::broadcast::channel(32).0,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            secret_key: Arc::new([91; 32]),
        };
        sqlx::query("INSERT INTO settings(key,value) VALUES('runtime',$1)").bind(json!({"nomad_url":format!("http://{address}"),"registry_url":"http://127.0.0.1:5000","require_cloudflare":false})).execute(&app.db).await?;
        let project = Uuid::new_v4();
        let service = Uuid::new_v4();
        let previous = Uuid::new_v4();
        sqlx::query("INSERT INTO machines(id,credential_hash,location,roles,tags,report) VALUES($1,$2,'home',ARRAY['compute','database'],ARRAY[]::text[],'{}')").bind(scheduler.machine).bind(format!("test-{}",scheduler.machine)).execute(&app.db).await?;
        sqlx::query("INSERT INTO projects(id,name,repository) VALUES($1,'Lifecycle test','test/repository')").bind(project).execute(&app.db).await?;
        sqlx::query("INSERT INTO services(id,project_id,name,port,status,address,machine_id) VALUES($1,$2,'web',3000,'healthy',$3,$4)").bind(service).bind(project).bind(OLD_ADDRESS).bind(scheduler.machine).execute(&app.db).await?;
        sqlx::query("INSERT INTO deployments(id,service_id,status,image_digest,job_id) VALUES($1,$2,'healthy',$3,$4)").bind(previous).bind(service).bind(image('a')).bind(format!("pc-deploy-{previous}")).execute(&app.db).await?;
        sqlx::query("UPDATE services SET current_deployment_id=$2,image_digest=$3 WHERE id=$1")
            .bind(service)
            .bind(previous)
            .bind(image('a'))
            .execute(&app.db)
            .await?;
        Ok(Self {
            app,
            admin,
            schema,
            project,
            service,
            previous,
            scheduler,
            server,
        })
    }
    async fn queue(&self) -> anyhow::Result<Uuid> {
        let row = queue_deployment(&self.app, self.service, None, Some(image('b'))).await?;
        Ok(Uuid::parse_str(
            row["id"].as_str().context("Queue omitted deployment ID")?,
        )?)
    }
    async fn state(
        &self,
        new: Uuid,
    ) -> anyhow::Result<(Uuid, String, String, Option<Uuid>, Option<String>)> {
        Ok(sqlx::query_as("SELECT s.current_deployment_id,s.status,d.status,s.promotion_deployment_id,s.promotion_address FROM services s JOIN deployments d ON d.id=$2 WHERE s.id=$1").bind(self.service).bind(new).fetch_one(&self.app.db).await?)
    }
    async fn finish(self, result: anyhow::Result<()>) -> anyhow::Result<()> {
        self.scheduler.release_delete.notify_waiters();
        self.server.abort();
        self.app.db.close().await;
        sqlx::raw_sql(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await?;
        self.admin.close().await;
        result
    }
}
fn image(character: char) -> String {
    format!(
        "test.invalid/app@sha256:{}",
        character.to_string().repeat(64)
    )
}
async fn scheduler_response(
    state: Arc<SchedulerState>,
    request: Request,
) -> axum::response::Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    state
        .requests
        .lock()
        .unwrap()
        .push((method.clone(), path.clone()));
    let response = if method == "DELETE" {
        state.delete_reached.notify_one();
        if state.pause_delete.load(Ordering::SeqCst) {
            state.release_delete.notified().await;
        }
        if state.fail_delete.load(Ordering::SeqCst) {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"injected cleanup failure"})),
            )
                .into_response();
        }
        json!({"EvalID":"test-evaluation"})
    } else if method == "GET" && path == "/v1/nodes" {
        json!([{"ID":state.node}])
    } else if method == "GET" && path == format!("/v1/node/{}", state.node) {
        json!({"ID":state.node,"Status":"ready","SchedulingEligibility":"eligible","Attributes":{"cpu.arch":"amd64"},"Meta":{"pc_machine_id":state.machine.to_string(),"pc_compute":"true","pc_database":"true","pc_location":"home"},"Drivers":{"docker":{"Healthy":true}}})
    } else if method == "POST" && path == "/v1/jobs" {
        let bytes = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
        let job: Value = serde_json::from_slice(&bytes).unwrap();
        if job["Job"]["ID"]
            .as_str()
            .is_none_or(|id| !id.starts_with("pc-deploy-"))
        {
            return StatusCode::BAD_REQUEST.into_response();
        }
        json!({"EvalID":"test-evaluation"})
    } else if method == "GET"
        && path.starts_with("/v1/job/pc-deploy-")
        && path.ends_with("/allocations")
    {
        json!([{"ID":state.allocation,"NodeID":state.node,"ClientStatus":"running","DesiredStatus":"run"}])
    } else if method == "GET" && path == format!("/v1/allocation/{}", state.allocation) {
        json!({"ID":state.allocation,"NodeID":state.node,"TaskStates":{"app":{"State":"running"}}})
    } else if method == "GET"
        && path == format!("/v1/client/allocation/{}/checks", state.allocation)
    {
        json!({"ready":{"Status":"success"}})
    } else if method == "GET"
        && path.starts_with("/v1/job/pc-deploy-")
        && path.ends_with("/services")
    {
        json!([{"AllocID":state.allocation,"Address":"10.42.0.2","Port":30000}])
    } else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"unexpected scheduler request"})),
        )
            .into_response();
    };
    Json(response).into_response()
}

#[tokio::test]
#[ignore = "requires PC_TEST_DATABASE_URL; creates and drops an isolated schema"]
async fn deletion_claim_blocks_queue_while_scheduler_shutdown_is_in_flight() -> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let result = async {
        fixture.scheduler.pause_delete.store(true, Ordering::SeqCst);
        let app = fixture.app.clone();
        let id = fixture.service;
        let removing = tokio::spawn(async move { remove_service(&app, id).await });
        let checks: anyhow::Result<()> = async {
            tokio::time::timeout(
                Duration::from_secs(2),
                fixture.scheduler.delete_reached.notified(),
            )
            .await?;
            let state: String = sqlx::query_scalar("SELECT status FROM services WHERE id=$1")
                .bind(id)
                .fetch_one(&fixture.app.db)
                .await?;
            ensure!(
                state == "deleting",
                "Deletion must claim the service before scheduler I/O"
            );
            let queued = fixture.queue().await;
            ensure!(
                queued.is_err(),
                "A new deployment slipped in after deletion claimed the service"
            );
            ensure!(
                queued.unwrap_err().to_string().contains("being removed"),
                "Queue rejection lost the deletion reason"
            );
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM deployments WHERE service_id=$1")
                    .bind(id)
                    .fetch_one(&fixture.app.db)
                    .await?;
            ensure!(count == 1, "Rejected queue inserted a deployment");
            Ok(())
        }
        .await;
        fixture.scheduler.release_delete.notify_one();
        tokio::time::timeout(Duration::from_secs(5), removing).await???;
        checks?;
        ensure!(
            !sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM services WHERE id=$1)")
                .bind(id)
                .fetch_one(&fixture.app.db)
                .await?,
            "Service deletion did not finish"
        );
        Ok(())
    }
    .await;
    fixture.finish(result).await
}

#[tokio::test]
#[ignore = "requires PC_TEST_DATABASE_URL; creates and drops an isolated schema"]
async fn queued_deployment_prevents_removal_and_keeps_previous_version() -> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let result = async {
        let id = fixture.queue().await?;
        let previous: Uuid =
            sqlx::query_scalar("SELECT previous_deployment_id FROM deployments WHERE id=$1")
                .bind(id)
                .fetch_one(&fixture.app.db)
                .await?;
        ensure!(
            previous == fixture.previous,
            "Queued deployment lost its previous-version recovery pointer"
        );
        ensure!(
            remove_service(&fixture.app, fixture.service).await.is_err(),
            "Removal accepted a service with active work"
        );
        let state = fixture.state(id).await?;
        ensure!(
            state.0 == fixture.previous && state.1 == "healthy" && state.2 == "queued",
            "Rejected removal changed serving state"
        );
        ensure!(
            fixture.scheduler.requests.lock().unwrap().is_empty(),
            "Rejected removal touched scheduler resources"
        );
        Ok(())
    }
    .await;
    fixture.finish(result).await
}

#[tokio::test]
#[ignore = "requires PC_TEST_DATABASE_URL; creates and drops an isolated schema"]
async fn pending_promotion_keeps_previous_current_until_service_and_deployment_commit_together()
-> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let result=async {
        let id=fixture.queue().await?;
        let barrier=i64::from_be_bytes(Uuid::new_v4().as_bytes()[..8].try_into()?);
        let mut gate=fixture.app.db.acquire().await?;
        sqlx::query("SELECT pg_advisory_lock($1)").bind(barrier).execute(&mut *gate).await?;
        sqlx::raw_sql(&format!("CREATE FUNCTION pause_healthy_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='healthy' AND OLD.status<>'healthy' THEN PERFORM pg_advisory_xact_lock({barrier}); END IF; RETURN NEW; END $$; CREATE TRIGGER pause_healthy BEFORE UPDATE ON deployments FOR EACH ROW EXECUTE FUNCTION pause_healthy_commit();")).execute(&fixture.app.db).await?;
        let app=fixture.app.clone();let processing=tokio::spawn(async move {deploy::process(&app,id).await});
        let observed: anyhow::Result<()>=async {
            tokio::time::timeout(Duration::from_secs(5),async {
                loop {
                    let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory')").bind(&fixture.schema).fetch_one(&fixture.app.db).await?;
                    if blocked {return Ok::<_,anyhow::Error>(());}
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }).await??;
            let state=fixture.state(id).await?;
            ensure!(state.0==fixture.previous,"Uncommitted promotion replaced the current deployment");
            ensure!(state.1=="healthy"&&state.2=="deploying","Observers saw an inconsistent partial healthy commit");
            ensure!(state.3==Some(id)&&state.4.as_deref()==Some(NEW_ADDRESS),"Checked target was not staged separately from current state");
            ensure!(service_address(&fixture.app,fixture.service).await?==NEW_ADDRESS,"Routing did not resolve the staged healthy target");
            let address:String=sqlx::query_scalar("SELECT address FROM services WHERE id=$1").bind(fixture.service).fetch_one(&fixture.app.db).await?;
            ensure!(address==OLD_ADDRESS,"Staging overwrote the durable current address");
            Ok(())
        }.await;
        sqlx::query("SELECT pg_advisory_unlock($1)").bind(barrier).execute(&mut *gate).await?;
        drop(gate);
        tokio::time::timeout(Duration::from_secs(5),processing).await???;
        observed?;
        let state=fixture.state(id).await?;
        ensure!(state.0==id&&state.1=="healthy"&&state.2=="healthy"&&state.3.is_none()&&state.4.is_none(),"Promotion did not atomically publish current/healthy and clear staging");
        Ok(())
    }.await;
    fixture.finish(result).await
}

#[tokio::test]
#[ignore = "requires PC_TEST_DATABASE_URL; creates and drops an isolated schema"]
async fn failed_postcommit_housekeeping_never_reclassifies_or_stops_current_deployment()
-> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let result=async {
        fixture.scheduler.fail_delete.store(true,Ordering::SeqCst);
        sqlx::raw_sql("CREATE FUNCTION reject_healthy_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.step='healthy' THEN RAISE EXCEPTION 'injected postcommit log failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_healthy_log BEFORE INSERT ON deployment_steps FOR EACH ROW EXECUTE FUNCTION reject_healthy_log();").execute(&fixture.app.db).await?;
        let id=fixture.queue().await?;
        deploy::process(&fixture.app,id).await?;
        let state=fixture.state(id).await?;
        ensure!(state.0==id&&state.1=="healthy"&&state.2=="healthy","Postcommit cleanup/log failure corrupted the serving deployment");
        let requests=fixture.scheduler.requests.lock().unwrap().clone();
        ensure!(requests.iter().any(|(method,path)|method=="DELETE"&&path==&format!("/v1/job/pc-deploy-{}",fixture.previous)),"Cleanup failure was not exercised");
        fixture.scheduler.requests.lock().unwrap().clear();
        deploy::cleanup_failed(&fixture.app,id).await?;
        ensure!(fixture.scheduler.requests.lock().unwrap().is_empty(),"Failure cleanup tried to stop the serving deployment");
        ensure!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM events WHERE kind='deployment.healthy'").fetch_one(&fixture.app.db).await?==1,"Healthy commit event was lost");
        Ok(())
    }.await;
    fixture.finish(result).await
}

#[tokio::test]
#[ignore = "requires PC_TEST_DATABASE_URL; creates and drops an isolated schema"]
async fn failed_staged_routing_restores_previous_without_promoting_candidate() -> anyhow::Result<()>
{
    let fixture = Fixture::new().await?;
    let result = async {
        let id = fixture.queue().await?;
        sqlx::query(
            "UPDATE services SET promotion_deployment_id=$2,promotion_address=$3 WHERE id=$1",
        )
        .bind(fixture.service)
        .bind(id)
        .bind(NEW_ADDRESS)
        .execute(&fixture.app.db)
        .await?;
        deploy::restore_routing(&fixture.app, id).await?;
        let state = fixture.state(id).await?;
        ensure!(
            state.0 == fixture.previous
                && state.1 == "healthy"
                && state.2 == "queued"
                && state.3.is_none()
                && state.4.is_none(),
            "Routing rollback changed durable serving state"
        );
        ensure!(
            service_address(&fixture.app, fixture.service).await? == OLD_ADDRESS,
            "Routing rollback did not restore the previous address"
        );
        Ok(())
    }
    .await;
    fixture.finish(result).await
}

#[tokio::test]
#[ignore = "requires PC_TEST_DATABASE_URL; creates and drops an isolated schema"]
async fn degraded_database_secrets_remain_available_for_redaction_but_block_deployment()
-> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let result=async {
        let database=Uuid::new_v4();
        let connection="postgresql://test_user:private-test-password@10.42.0.3:25432/test";
        let encrypted=crypto::seal(&fixture.app,&format!("database:{database}"),connection)?;
        let variable=crypto::seal(&fixture.app,&format!("env:{}:API_KEY",fixture.project),"test-api-secret")?;
        sqlx::query("INSERT INTO environment_variables(project_id,key,value_encrypted) VALUES($1,'API_KEY',$2)").bind(fixture.project).bind(variable).execute(&fixture.app.db).await?;
        sqlx::query("INSERT INTO databases(id,project_id,name,machine_id,volume_name,status,connection_encrypted) VALUES($1,$2,'database',$3,$4,'degraded',$5)").bind(database).bind(fixture.project).bind(fixture.scheduler.machine).bind(format!("test-volume-{database}")).bind(encrypted).execute(&fixture.app.db).await?;
        sqlx::query("INSERT INTO service_database_bindings(service_id,database_id) VALUES($1,$2)").bind(fixture.service).bind(database).execute(&fixture.app.db).await?;
        let redaction=read_environment(&fixture.app,fixture.project,fixture.service,false).await?;
        ensure!(redaction.get("DATABASE_URL")==Some(&json!(connection)),"Degraded database credential disappeared from log-redaction inputs");
        ensure!(redaction.get("API_KEY")==Some(&json!("test-api-secret")),"Project secret was not decrypted for redaction");
        let deploy_environment=environment(&fixture.app,fixture.project,fixture.service).await;
        ensure!(deploy_environment.is_err(),"Deployment accepted an unhealthy bound database");
        ensure!(deploy_environment.unwrap_err().to_string().contains("Attached database is not healthy"),"Deployment lost the database health explanation");
        sqlx::query("UPDATE databases SET status='healthy' WHERE id=$1").bind(database).execute(&fixture.app.db).await?;
        ensure!(environment(&fixture.app,fixture.project,fixture.service).await?.get("DATABASE_URL")==Some(&json!(connection)),"Healthy database binding was not restored");
        Ok(())
    }.await;
    fixture.finish(result).await
}

#[tokio::test]
#[ignore = "requires PC_TEST_DATABASE_URL; creates and drops an isolated schema"]
async fn acknowledged_candidate_route_is_retained_until_rollback_and_delayed_ack_agree()
-> anyhow::Result<()> {
    let fixture = Fixture::new().await?;
    let result=async {
        let id=fixture.queue().await?;let domain=Uuid::new_v4();
        sqlx::query("UPDATE services SET promotion_deployment_id=$2,promotion_address=$3 WHERE id=$1").bind(fixture.service).bind(id).bind(NEW_ADDRESS).execute(&fixture.app.db).await?;
        sqlx::query("INSERT INTO domains(id,service_id,hostname,status,upstream,configuration_applied,tunnel_id,account_id,zone_id) VALUES($1,$2,'test.example.com','healthy',$3,true,$4,$5,$5)")
            .bind(domain).bind(fixture.service).bind(NEW_ADDRESS).bind(Uuid::new_v4().to_string()).bind("a".repeat(32)).execute(&fixture.app.db).await?;
        // The edge already acknowledges the candidate; promotion's durable commit then fails.
        // Missing provider credentials deterministically fail the revert without an external call.
        ensure!(deploy::restore_routing(&fixture.app,id).await.is_err(),"Injected provider revert failure was not exercised");
        let state=fixture.state(id).await?;
        ensure!(state.0==fixture.previous&&state.3.is_none(),"Failed revert changed the committed current deployment");
        let applied:bool=sqlx::query_scalar("SELECT configuration_applied FROM domains WHERE id=$1").bind(domain).fetch_one(&fixture.app.db).await?;
        ensure!(!applied,"Rollback failed to invalidate the previous edge acknowledgement");
        deploy::cleanup_failed(&fixture.app,id).await?;
        let deployment_path=format!("/v1/job/pc-deploy-{id}");
        ensure!(!fixture.scheduler.requests.lock().unwrap().iter().any(|(method,path)|method=="DELETE"&&path==&deployment_path),"Cleanup stopped the candidate while the edge might still route to it");
        // A delayed observer acknowledgement can race after staging is cleared, but refers to NEW_ADDRESS.
        sqlx::query("UPDATE domains SET configuration_applied=true WHERE id=$1").bind(domain).execute(&fixture.app.db).await?;
        fixture.scheduler.requests.lock().unwrap().clear();
        deploy::cleanup_failed(&fixture.app,id).await?;
        ensure!(!fixture.scheduler.requests.lock().unwrap().iter().any(|(method,path)|method=="DELETE"&&path==&deployment_path),"Delayed acknowledgement bypassed the upstream/current-address guard");
        ensure!(sqlx::query_scalar::<_,bool>("SELECT stopped_at IS NULL FROM deployments WHERE id=$1").bind(id).fetch_one(&fixture.app.db).await?,"Protected deployment was falsely recorded as stopped");
        // Once the edge is actually back on the old current address, cleanup is safe.
        sqlx::query("UPDATE domains SET upstream=$2,configuration_applied=true WHERE id=$1").bind(domain).bind(OLD_ADDRESS).execute(&fixture.app.db).await?;
        fixture.scheduler.fail_delete.store(true,Ordering::SeqCst);
        fixture.scheduler.requests.lock().unwrap().clear();
        deploy::cleanup_failed(&fixture.app,id).await?;
        ensure!(fixture.scheduler.requests.lock().unwrap().iter().any(|(method,path)|method=="DELETE"&&path==&deployment_path),"Confirmed rollback did not permit cleanup");
        ensure!(sqlx::query_scalar::<_,bool>("SELECT stopped_at IS NULL FROM deployments WHERE id=$1").bind(id).fetch_one(&fixture.app.db).await?,"Failed scheduler deletion was falsely recorded as stopped");
        fixture.scheduler.fail_delete.store(false,Ordering::SeqCst);
        deploy::cleanup_failed(&fixture.app,id).await?;
        ensure!(sqlx::query_scalar::<_,bool>("SELECT stopped_at IS NOT NULL FROM deployments WHERE id=$1").bind(id).fetch_one(&fixture.app.db).await?,"Successful safe cleanup did not record completion");
        Ok(())
    }.await;
    fixture.finish(result).await
}
