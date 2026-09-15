use super::*;
use axum::{
    extract::{
        Path, State,
        ws::{Message, WebSocketUpgrade},
    },
    response::Response,
};
pub async fn events(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    owner(&app, &headers).await?;
    if headers.get(axum::http::header::ORIGIN).is_none() && crate::bearer(&headers).is_none() {
        return Err(crate::unauthorized());
    }
    Ok(ws.on_upgrade(move|mut socket|async move{
  let mut tick=tokio::time::interval(Duration::from_secs(3));
  loop{
   tokio::select!{_=tick.tick()=>{},msg=socket.recv()=>{match msg{Some(Ok(Message::Close(_)))|None|Some(Err(_))=>break,_=>continue}}}
   if owner(&app,&headers).await.is_err(){let _=socket.send(Message::Close(None)).await;break;}
   let payload=match observe(&app,id).await{Ok(v)=>v,Err(e)=>json!({"type":"unavailable","error":e.to_string()})};
   if socket.send(Message::Text(payload.to_string().into())).await.is_err(){break;}
  }
 }))
}
async fn observe(app: &App, id: Uuid) -> anyhow::Result<Value> {
    let row=sqlx::query("SELECT s.project_id,d.allocation_id,d.machine_id FROM services s JOIN deployments d ON d.id=s.current_deployment_id WHERE s.id=$1 AND d.allocation_id IS NOT NULL").bind(id).fetch_optional(&app.db).await?.context("No running deployment")?;
    let allocation: String = row.get("allocation_id");
    let cfg = config(app).await?;
    let env = read_environment(app, row.get("project_id"), id, false).await?;
    let mut lines = Vec::new();
    for kind in ["stdout", "stderr"] {
        if let Ok(log) = deploy::allocation_logs(app, &cfg, &allocation, "app", kind).await {
            for line in log.lines() {
                lines.push(json!({"stream":kind,"message":redact(line,&env)}));
            }
        }
    }
    let mut metrics = nomad(
        app,
        &cfg,
        reqwest::Method::GET,
        &format!("/v1/client/allocation/{allocation}/stats"),
        None,
    )
    .await?;
    if cfg.nomad_url.starts_with("agent://")
        && let Some(machine) = row.get::<Option<Uuid>, _>("machine_id")
        && let Ok(Ok((200, body))) = tokio::time::timeout(
            Duration::from_secs(5),
            crate::networking::nomad_request(
                app,
                machine,
                "GET",
                &format!("/v1/personal-cloud/allocation/{allocation}/network"),
                None,
            ),
        )
        .await
        && let Ok(network) = serde_json::from_str::<Value>(&body)
    {
        metrics["Network"] = network;
    }
    let detail = nomad(
        app,
        &cfg,
        reqwest::Method::GET,
        &format!("/v1/allocation/{allocation}"),
        None,
    )
    .await?;
    Ok(
        json!({"type":"observability","allocation_id":allocation,"lines":lines,"metrics":metrics,"restarts":detail["TaskStates"]["app"]["Restarts"],"at":chrono::Utc::now()}),
    )
}
pub(super) fn redact(line: &str, env: &serde_json::Map<String, Value>) -> String {
    let mut values: Vec<&str> = env
        .values()
        .filter_map(Value::as_str)
        .filter(|v| !v.is_empty())
        .collect();
    values.sort_by_key(|v| std::cmp::Reverse(v.len()));
    let mut result = line.to_owned();
    for value in values {
        result = result.replace(value, "[redacted]");
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_longest_credentials_first() {
        let env = json!({"URL":"postgres://secret@db/app","PASS":"secret"});
        assert_eq!(
            redact(
                "connect postgres://secret@db/app secret",
                env.as_object().unwrap()
            ),
            "connect [redacted] [redacted]"
        );
    }
}
