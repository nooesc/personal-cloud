# PC-01 API

The Rust API defaults to `127.0.0.1:4311`. Frontend requests use same-origin `/api` through Vite. JSON requests are limited to 32 KiB. Owner requests accept `Authorization: Bearer <PC_ADMIN_TOKEN>` or an HttpOnly `pc_session` cookie. Machine credentials cannot access owner endpoints.

| Method | Path | Authorization | Behavior |
|---|---|---|---|
| GET | /api/health | Public | Process health and version |
| POST | /api/session | Owner token in `{token}` | Issues a distinct random 12-hour cookie; only hash stored |
| DELETE | /api/session | Cookie, if present | Revokes session in PostgreSQL and clears cookie |
| GET | /api/snapshot | Owner | Fleet, projects, services, latest 30 durable events |
| GET/WS | /api/events | Owner; exact Origin for browser | Sends full snapshot immediately, on mutation/heartbeat, and every ten seconds |
| POST | /api/projects | Owner | `{name,repository,branch}`; GitHub owner/repository only |
| POST | /api/projects/:id/services | Owner | `{name,port,placement}`; desired configuration only |
| POST | /api/enrollment-tokens | Owner | `{location,roles,tags}`; returns one-use token and expiration |
| POST | /api/agent/enroll | Enrollment token in body | `{token,report}`; atomically claims token and creates identity |
| POST | /api/agent/:id/heartbeat | Machine bearer | Validates report, updates last_seen, notifies browsers |

`placement` is `{kind:"automatic"}`, `{kind:"home"}`, `{kind:"vps"}`, or `{kind:"machine",machine_id:"UUID"}`. Locations are `home`, `vps`, `dedicated`. Roles are `compute`, `builder`, `database`.

Machine report:

```json
{
  "hostname": "home-01",
  "os": "Ubuntu 24.04",
  "architecture": "amd64",
  "cpu_cores": 8,
  "cpu_percent": 12.5,
  "memory_total": 17179869184,
  "memory_used": 4294967296,
  "disk_total": 1073741824000,
  "disk_used": 214748364800,
  "docker": true,
  "nomad": true
}
```

Byte counts are integers; CPU percentage must be finite and 0–100. Used resources cannot exceed totals. The server owns machine ID, roles, tags, location and last-seen time. Agent reports cannot change them.

WebSocket snapshots repair missed notifications on reconnect. Events are durable but this milestone has no paginated event replay or log streaming. Expired, revoked, or admin-key-rotated sessions also lose WebSocket access on the next notification/tick. Enrollment retries after a lost successful response need a new token; resumable enrollment remains future work.
