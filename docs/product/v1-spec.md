## dinghy Platform — V1 Spec

### 1. Product

An open-source, highly opinionated deployment platform that combines **Cloudflare + commodity VPSs + home hardware** into one Railway-like cloud.

> Connect Cloudflare. Connect GitHub. Add machines. Deploy.

The user should not need to understand Nomad, Docker, WireGuard, BuildKit, registries, tunnels, or Cloudflare's product taxonomy.

---

## 2. Blessed Stack

| Layer            | Choice                                   |
| ---------------- | ---------------------------------------- |
| Control plane    | **Rust**                                 |
| Control DB       | **PostgreSQL**                           |
| Web              | **TanStack Start + React + TypeScript**  |
| Scheduler        | **Nomad**                                |
| Runtime          | **Docker Engine**                        |
| Build detection  | **Railpack**                             |
| Builder          | **BuildKit**                             |
| Images           | **OCI registry backed by Cloudflare R2** |
| Edge/network     | **Cloudflare**                           |
| Fleet networking | **WireGuard**                            |
| Public ingress   | **Cloudflare Tunnel**                    |
| Source           | **GitHub**                               |
| Realtime UI      | **WebSockets**                           |
| Secrets          | **Encrypted internally**                 |

No Kubernetes, Swarm, Podman, Vault, etc.

---

## 3. Architecture

```text
                    CONTROL PLANE
             ┌──────────────────────┐
             │ Rust API             │
             │ Postgres             │
             │ WebSocket Gateway    │
             │ Scheduler Controller │
             │ Cloudflare Controller│
             │ GitHub Controller    │
             └──────────┬───────────┘
                        │
                     Nomad
                        │
       ┌────────────────┼────────────────┐
       │                │                │
       ▼                ▼                ▼
   HOME FLEET        CHEAP VPS       DEDICATED
   Mac mini          Hetzner         Servers
   Workstation       OVH             etc.
   Linux boxes

                        ↕

                   CLOUDFLARE
       DNS / Tunnel / CDN / WAF / R2
```

---

# 4. Core Objects

Everything in the UI revolves around six objects:

**Project** → GitHub repository/application.

**Service** → Running component of a project.

**Machine** → Physical computer or VPS.

**Deployment** → Version of a service running on the fleet.

**Database** → Managed persistent Postgres instance.

**Domain** → Public route into a service.

Example:

```text
Project: Intake

Services
├── web
├── api
└── worker

Database
└── postgres

Domains
├── intake.app → web
└── api.intake.app → api
```

---

# 5. Adding a Machine

Installation should be one command:

```bash
curl -fsSL https://platform.dev/install.sh | sh
```

The agent automatically reports:

```text
Hostname
OS
Architecture
CPU
RAM
Disk
GPU
IP/network
Docker status
Nomad status
Health
```

Machine appears immediately:

```text
workstation-01

● Online

CPU       4 / 16 cores
RAM       12 / 64 GB
Disk      420 / 2000 GB

Roles
[x] Compute
[x] Builder
[ ] Database
```

Machines can receive tags:

```text
home
vps
database
builder
gpu
high-memory
```

---

# 6. Deploying

User selects:

**New Project → GitHub → repository**

We detect the application automatically.

```text
GitHub
 ↓
Railpack
 ↓
BuildKit
 ↓
OCI image
 ↓
R2-backed registry
 ↓
Nomad
 ↓
Docker
```

The user sees:

```text
Deploying api

✓ Repository cloned
✓ Node detected
✓ Dependencies installed
✓ Application built
✓ Image created
✓ Image uploaded
✓ Scheduled → vps-02
✓ Health check passed

Deployment successful
```

---

# 7. Placement

Default:

**Automatic**

Scheduler considers:

* available CPU
* available RAM
* architecture
* machine health
* roles
* tags
* persistent storage requirements

Advanced UI:

```text
Placement

● Automatic
○ Home fleet
○ Cloud VPS
○ Specific machine
```

Examples:

```text
frontend → automatic
API      → VPS
scraper  → home-workstation
postgres → db-01
```

Nomad implements the actual scheduling constraints.

---

# 8. Cloudflare

Cloudflare is a **required integration for V1**.

Connect through API/OAuth.

Our UI abstracts its complexity.

Instead of configuring Tunnel + DNS manually:

```text
Expose Service

Domain
api.example.com

Service
api : 3000

[Expose]
```

Platform automatically creates/configures:

```text
Cloudflare DNS
Cloudflare Tunnel
TLS
routing
health checks
```

Future options:

```text
[x] CDN
[x] WAF
[x] Rate limiting
[x] Access authentication
```

---

# 9. Private Fleet Network

Every machine joins our WireGuard mesh.

Example:

```text
10.42.0.1   control
10.42.0.10  mac-mini
10.42.0.11  workstation
10.42.0.20  vps-01
```

Internal services communicate through private addresses.

Nothing requires exposed SSH/database ports.

---

# 10. Databases

V1 supports **PostgreSQL only**.

User:

**New → Database → PostgreSQL**

Select:

```text
Placement
● Automatic
○ db-01
○ workstation
```

Platform provisions:

```text
Postgres container
persistent volume
credentials
private network
health monitoring
```

Application gets:

```text
DATABASE_URL
```

automatically.

Critical rule:

**Databases never automatically migrate between machines.**

Persistent workloads must be explicitly moved.

---

# 11. Builds

Machines can have role:

```text
Builder
```

Nomad schedules BuildKit jobs there.

Example fleet:

```text
Mac Mini
compute

Workstation
compute + builder

VPS-01
compute

DB-01
database
```

The workstation handles builds without affecting production machines.

---

# 12. Image Storage

Images live in an **OCI registry backed by Cloudflare R2**.

Conceptually:

```text
app:v183
api:v94
worker:v27
```

Users don't configure this.

Deployments simply reference immutable image versions.

Rollback becomes:

```text
Deployment #184
Deployment #183
Deployment #182

[Rollback to #183]
```

No rebuild required.

---

# 13. Secrets

Project UI:

```text
Environment

DATABASE_URL       •••••••••
OPENAI_API_KEY     •••••••••
STRIPE_SECRET      •••••••••

+ Add Variable
```

Encrypted by control plane.

Injected at runtime.

No HashiCorp Vault dependency.

---

# 14. Observability

Keep V1 deliberately simple.

Per service:

```text
CPU
RAM
Network
Restarts
Health
```

Plus live logs:

```text
api / production

01:43:21 server listening :3000
01:43:24 GET /users 200 12ms
01:43:27 POST /login 200 31ms
```

Everything streams to UI over WebSockets.

No attempt to recreate Grafana.

---

# 15. Dashboard

The primary screen should answer:

**What do I own and what is running where?**

```text
MY CLOUD

6 Machines
46 Cores
144 GB RAM
7.2 TB Storage

$43/mo external compute
──────────────────────────────

MACHINES

workstation    HOME     ●   22%
mac-mini       HOME     ●   11%
vps-us-east    VPS      ●   47%
vps-eu         VPS      ●   18%

──────────────────────────────

PROJECTS

Intake              ● Healthy
  web       vps-us-east
  api       vps-us-east
  postgres  workstation

Scraper             ● Healthy
  api       vps-us-east
  workers   workstation
```

UI/UX is a **first-class product feature**, not decoration.

---

# 16. GitHub Workflow

Push:

```text
git push
```

GitHub webhook fires.

Platform determines affected service → builds → uploads → deploys.

PRs can eventually create preview deployments, but I'd leave that for V1.1.

---

# 17. Failure Handling

Nomad handles:

```text
container crash
→ restart

machine failure
→ reschedule stateless service

failed deployment
→ keep previous deployment

health check failure
→ rollback
```

Stateful services do **not** automatically relocate.

Dashboard prominently shows degraded nodes/services.

---

# 18. OSS / Commercial Structure

### Open Source

Entire usable platform:

* control plane
* UI
* agent
* Nomad integration
* Docker
* Cloudflare integration
* deployments
* Postgres provisioning
* monitoring

I'd use **Apache 2.0**.

### Commercial

Hosted control plane:

```text
platform.dev
```

User doesn't operate the management infrastructure.

Eventually:

* teams
* SSO
* RBAC
* audit logs
* automated backups
* advanced scheduling
* fleet policies
* support

We sell **management**, not compute.

---

# 19. Explicitly NOT V1

This is important.

No:

```text
Kubernetes
Podman
Docker Swarm
AWS abstraction
GCP abstraction
Azure abstraction
GitLab
Bitbucket
MySQL
Redis provisioning
ClickHouse provisioning
GPU orchestration
multi-region HA databases
autoscaling
marketplace
billing
Terraform
Vault
```

Don't turn the first release into an infrastructure science project.

---

# 20. V1 Success Criterion

A new user with:

* GitHub account
* Cloudflare account
* $5 VPS
* random Linux PC at home

should go from **zero → personal cloud → deployed application** in under **10 minutes**.

And afterward they should never need to open the Cloudflare, Nomad, or Docker dashboards.

That's the product.

## Hosted edition: project organization (September 2026)

For the hosted edition, a **Project** is now the home for an application, rather than
requiring a GitHub repository. It may contain linked Cloudflare Workers/Pages, fleet
services, or both. A repository is optional until the user wants to build machine
services. Existing fleet deployment and stateful workload contracts remain unchanged.

Connecting a Cloudflare inventory account offers a resumable organization flow:
review suggested project/environment groups, edit them, and save in one batch.
Unassigned and ignored resources remain accessible. Name-based suggestions are guesses
until accepted. Project views combine saved associations with observed provider data;
missing or unavailable data never implies serving health.

Use existing resources first. Organization does not provision anything, adopt a deployment
pipeline, change provider billing, or require a paid plan. Additional infrastructure is
optional and belongs to the project that needs it. Paid provisioning, verified quota
budgets, and shared database/bucket relationships are future capabilities, not controls
implemented by this organization flow.

## Native macOS fleet extension

Nomad remains the sole fleet workload scheduler, including native macOS development services and Apple build/test tasks. macOS uses an explicitly enabled raw_exec client and a non-root user; Linux container workloads retain their existing drivers. Dinghy may store job history and reconcile provider state, but must not introduce a separate machine work-claiming queue. Native readiness requires observed Nomad node eligibility and driver capability, not inventory alone.
