use super::*;
use std::collections::HashMap;

// Cloudflare currently omits config_version for some connected clients. Keep a
// checkpoint of cloudflared's own acknowledgement, bound to the allocation's
// task start and the connector UUID that Cloudflare reports as active. This
// survives log rotation without treating a successful edge request as an ack.
pub async fn acknowledged_configurations(
    app: &App,
    tunnel: &str,
) -> anyhow::Result<HashMap<String, i64>> {
    let tunnel = Uuid::parse_str(tunnel)?;
    let cfg = config(app).await?;
    let job = format!("pc-tunnel-{tunnel}");
    let allocations = nomad(
        app,
        &cfg,
        reqwest::Method::GET,
        &format!("/v1/job/{job}/allocations"),
        None,
    )
    .await?;
    let mut observed = HashMap::new();
    for allocation in allocations
        .as_array()
        .context("Missing tunnel allocations")?
    {
        if allocation["ClientStatus"] != "running" || allocation["DesiredStatus"] != "run" {
            continue;
        }
        let id = allocation["ID"]
            .as_str()
            .context("Missing tunnel allocation ID")?;
        let task = &allocation["TaskStates"]["cloudflared"];
        if task["State"] != "running" {
            continue;
        }
        let started = task["StartedAt"]
            .as_str()
            .context("Missing tunnel start time")?;
        let start = chrono::DateTime::parse_from_rfc3339(started)?.timestamp();
        let key = format!("tunnel-ack:{tunnel}:{id}");
        let saved: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key=$1")
            .bind(&key)
            .fetch_optional(&app.db)
            .await?;
        let saved =
            saved.filter(|v| v["started_at"] == started && v["restarts"] == task["Restarts"]);
        let mut connector = saved
            .as_ref()
            .and_then(|v| v["connector"].as_str())
            .and_then(|v| Uuid::parse_str(v).ok());
        let mut version = saved.as_ref().and_then(|v| v["version"].as_i64());
        if let Ok(log) =
            super::deploy::allocation_logs(app, &cfg, id, "cloudflared", "stderr").await
        {
            update_ack(&log, start, &mut connector, &mut version);
        }
        if let (Some(connector), Some(version)) = (connector, version) {
            let value = json!({"started_at":started,"restarts":task["Restarts"],"connector":connector,"version":version});
            if saved.as_ref() != Some(&value) {
                sqlx::query("INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(&key).bind(value).execute(&app.db).await?;
            }
            observed.insert(connector.to_string(), version);
        }
    }
    Ok(observed)
}
fn update_ack(log: &str, start: i64, connector: &mut Option<Uuid>, version: &mut Option<i64>) {
    for line in log.lines() {
        let Some(time) = line
            .split_whitespace()
            .next()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        else {
            continue;
        };
        if time.timestamp() < start {
            continue;
        }
        if let Some(id) = line
            .split_once(" INF Generated Connector ID: ")
            .and_then(|(_, s)| Uuid::parse_str(s.trim()).ok())
        {
            if *connector != Some(id) {
                *version = None;
            }
            *connector = Some(id);
        } else if connector.is_some()
            && line.contains(" INF Updated to new configuration config=")
            && let Some(v) = line
                .rsplit_once(" version=")
                .and_then(|(_, s)| s.trim().parse::<i64>().ok())
                .filter(|v| *v >= 0)
        {
            *version = Some(v);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acknowledgements_follow_connector_identity_and_task_start() {
        let id = Uuid::new_v4();
        let other = Uuid::new_v4();
        let mut connector = None;
        let mut version = None;
        let start = chrono::DateTime::parse_from_rfc3339("2026-09-15T17:57:49Z")
            .unwrap()
            .timestamp();
        update_ack(
            &format!(
                "2026-09-15T17:57:48Z INF Generated Connector ID: {other}\n2026-09-15T17:57:48Z INF Updated to new configuration config=old version=99\n2026-09-15T17:57:49Z INF Generated Connector ID: {id}\n2026-09-15T17:57:50Z INF Updated to new configuration config=new version=1"
            ),
            start,
            &mut connector,
            &mut version,
        );
        assert_eq!((connector, version), (Some(id), Some(1)));
        update_ack(
            "2026-09-15T17:58:00Z INF Updated to new configuration config=new version=2",
            start,
            &mut connector,
            &mut version,
        );
        assert_eq!(version, Some(2));
        update_ack(
            &format!("2026-09-15T17:58:01Z INF Generated Connector ID: {other}"),
            start,
            &mut connector,
            &mut version,
        );
        assert_eq!((connector, version), (Some(other), None));
        update_ack(
            "2026-09-15T17:58:02Z ERR Failed to update configuration version=3",
            start,
            &mut connector,
            &mut version,
        );
        assert_eq!(version, None);
    }
}
