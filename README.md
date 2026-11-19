# Asset Management

A generic system for everything an organisation buys and has to keep track of — software licenses, SIM lines, hardware, certificates, contracts — with templates, tracked dates, reminders, documents and fine-grained access. Built for OpenShift, backed by PostgreSQL and S3.

- **Templates, not hard-coded types.** An asset type is a template of fields (text, number, currency, date, select, person, secret, linked asset, …). "Software license" and "SIM line" are just starter templates.
- **Dates have meaning.** Any date field can be tagged with a *date kind* — Renewal, Notice deadline, Expiry, Payment due, Warranty end, or one you define. The kind decides behaviour (one-off, recurring, informational), default reminders and the action verb ("Renew", "Pay"). Dates can be *derived* ("cancellation deadline = renewal date − notice period") and *recur* by a fixed interval or by another field ("term in months").
- **Reminders that people act on.** One digest email per person, Outlook calendar invites that move or cancel when the date changes, and a personal calendar feed. "Renew" rolls the date forward and closes the occurrence, including derived dates.
- **Built for a whole company.** An organization tree (company → divisions → departments → teams → squads) drives everything. Membership comes from LDAP/ADFS groups or attributes like `department`. Members see their team's assets, managers manage everything beneath their unit, and division heads get rolled-up spend and renewals per sub-unit. Restricted fields (license keys, PINs) are visible to managers only and never searchable.
- **Requests.** Anyone can ask for something for their team, or for any unit above it ("my department needs…", "the whole company needs…"). Procurement triages, approves, orders and fulfils; fulfilling creates the asset and links it back. Everyone involved is emailed at each step.
- **Search that forgives.** One box searches every non-restricted field of every asset you can see, plus requests, teams and people. Words can match partially, anywhere in the text, or with small typos. Results show which field matched. Filters work on any field in plain language ("Renewal date is in the next 90 days", "Seats is at least 40"). Any search can be saved as a pinned view.
- **Documents in S3** with presigned upload/download URLs and in-app preview (PDF, images, text, video, audio).
- **Sign-in** with LDAP / Active Directory, ADFS (OpenID Connect), and a break-glass local admin.

## Architecture

```
                 ┌──────────── OpenShift Route (TLS) ────────────┐
                 │                                               │
Browser ───────► web (nginx: SPA + /api/* reverse proxy, CSP)
                 │        │            │             │
                 ▼        ▼            ▼             ▼
             identity  registry      files       scheduler
             │  LDAP    asset types   S3 presign   obligations, reminders,
             │  ADFS    assets        previews     Outlook invites, ICS
             │  grants  date kinds        │
             ▼          ▼                 ▼             ▼
        ┌────────────── PostgreSQL (one schema per service) ──────────────┐
        │ identity.*      registry.*        files.*         scheduler.*    │
        │            pgboss.* (job queue / event bus)                      │
        └──────────────────────────────────────────────────────────────────┘
                                         │
                                         └──► S3 (documents)     SMTP relay ──► Exchange / O365
```

| Service | Owns | Talks to |
|---|---|---|
| **identity** | People, groups, the organization tree and who belongs to each unit, grants, sessions; issues ES256 access tokens (JWKS) | LDAP/AD, ADFS |
| **registry** | Asset types (versioned templates), date kinds, assets, activity log, requests, search index, saved views | — |
| **files** | Document metadata; presigned S3 POST/GET | S3, registry (access check) |
| **scheduler** | Obligations (occurrences of tracked dates), reminders, Outlook invites, calendar feeds, request emails, per-unit rollups | SMTP |
| **web** | React SPA served by nginx, which proxies `/api/<service>/` | all |

**Boundaries.** Each service owns one Postgres schema; its connection's `search_path` is pinned to it, so it cannot read another service's tables. Services integrate through events written to a **transactional outbox** and relayed via **pg-boss** (`asset.changed`, `asset.deleted`, `user.changed`, `unit.changed`, `request.changed`); consumers keep small local projections and are idempotent (at-least-once delivery). The only synchronous call is files → registry to authorise document access, because the registry owns asset authorisation. Every service verifies the caller's token locally against identity's JWKS.

**Layers** (every service):

```
src/
  domain/          pure rules and entities (no I/O)
  application/     use cases + ports (interfaces for persistence, mail, storage, directories)
  infrastructure/  adapters: Postgres (Kysely), S3, SMTP, LDAP, OIDC, migrations
  http/            Fastify routes: parse → call use case → return
  main.ts          composition root (wires adapters into use cases)
```

**Shared code, written once.**

- `packages/core` — the pure domain shared by services *and* the web app: field kinds, date semantics (derivation, recurrence, reminders), attribute validation, permissions, API and event contracts, starter templates. The form preview in the browser computes derived dates with the same code the registry uses.
- `packages/platform` — the server kernel: config, database and migrations, HTTP bootstrap with error mapping and CSRF guard, token verification, outbox and event bus, scope-to-SQL filter, graceful shutdown.
- `apps/web/src/components/ui` — UI primitives (buttons, form controls, dialogs and sheets, menus, data table). Domain components (`AttributeInput`, `AttributeValue`, `ObligationList`, `DurationListEditor`, pickers) are reused across the table, forms, template preview, detail pages and settings.
- One `Dockerfile` (targets `service` and `web`) and one Helm template that renders every component.

## The generic model

| Concept | Example | Notes |
|---|---|---|
| **Asset type** (template) | Software license | Fields, sections, statuses. Versioned; optimistic concurrency on edit. |
| **Field** | Seats (number), License key (secret), Assignee (person) | 13 kinds; `required`, `restricted`, `showInTable`, kind-specific config. |
| **Date kind** | Renewal (recurring, 90/60/30/7 days, "Renew") | Admin-managed catalogue. Behaviour: `milestone` · `recurring` · `informational`. |
| **Tracked date** | Renewal date → Renewal, repeats every `term_months` | Per field: kind, optional derivation, recurrence, reminders, recipients (owner, person fields, extra emails). Per asset: reminder overrides. |
| **Status** | Active / Trial / Cancelled | Inactive statuses pause all reminders. |
| **Organization unit** | Wix › R&D › Editor › Platform | A tree with free level names. Every asset and request belongs to one unit. Units link to directory groups or attributes. |
| **Membership** | Platform members (from `CN=platform`); R&D managers | Members get the unit's member access (view by default). Managers get manage on the whole subtree, and receive reminders when an owner is missing. |
| **Grant** | Dana → manage the whole company; Finance → view it | For roles that cut across the tree. Grants go to users or directory groups and apply to a unit's subtree; the highest matching level wins. |
| **Request** | REQ-1042 "10 Miro seats" for Platform | Submitted → In review → Approved → Ordered → Fulfilled (or Declined/Cancelled). Handlers are people with edit on the unit. |
| **Obligation** | "Renew GitHub Enterprise by Dec 30" | One active occurrence per asset × date field; done / snoozed / dismissed. |

## Local development

Requirements: Node 22, pnpm 10, Docker.

```bash
pnpm install
docker compose up -d                  # Postgres, MinIO, Mailpit, OpenLDAP
cp .env.example .env
pnpm dev                              # services on :4001-4004, web on http://localhost:5173
node scripts/seed-demo.mjs            # optional demo data
```

Sign in as `admin` / `admin-change-me` (local break-glass account from `.env`). The seed builds a company of about 150 units, 60 people and 400 assets. Try it as different people (password `password-1234`):

| Account | Persona | What to look at |
|---|---|---|
| `dana.cohen` | Procurement lead (manages the whole company) | Requests → To handle; approve, order and fulfil a request |
| `tom.levi` | Platform team member | Request something; My requests; the team's assets |
| `rachel.amar` | R&D division head | My teams → R&D: rollups by department, renewals |
| `noa.mizrahi` | Finance (views company-wide) | Spend on the home screen; saved views |
 Emails and Outlook invites are captured by Mailpit at http://localhost:8025. To try LDAP sign-in, set `LDAP_ENABLED=true` and the `LDAP_*` values shown in `docker-compose.yml` (users `alice`/`bob`, password `password`).

```bash
pnpm typecheck && pnpm test           # strict TypeScript across all packages + unit tests
docker compose --profile app up -d    # the production images, on http://localhost:8080
```

## Deploying to OpenShift

1. **Build and push images** (one Dockerfile, five images):

   ```bash
   REG=default-route-openshift-image-registry.apps.<cluster>/asset-management TAG=0.1.0
   for s in identity registry files scheduler; do
     docker build --target service --build-arg SERVICE=$s -t $REG/asset-management-$s:$TAG . && docker push $REG/asset-management-$s:$TAG
   done
   docker build --target web -t $REG/asset-management-web:$TAG . && docker push $REG/asset-management-web:$TAG
   ```

2. **Provision with Terraform** (`deploy/terraform/environments/production`). This creates the S3 bucket (private, versioned, encrypted, TLS-only, CORS for the app origin, least-privilege IAM), generates the JWT signing key and cookie secret, writes the `asset-management` Secret, and installs the Helm chart:

   ```bash
   oc login ...
   cd deploy/terraform/environments/production
   cp terraform.tfvars.example terraform.tfvars    # fill in; prefer TF_VAR_* for secrets
   terraform init && terraform apply
   terraform output -raw local_admin_password
   ```

   PostgreSQL is supplied as `database_url` (for example Crunchy Postgres for Kubernetes, or a managed instance). Each service creates and migrates its own schema in an init container.

3. **Or use Helm directly** with your own Secret (keys: `DATABASE_URL`, `AUTH_SIGNING_KEY`, `COOKIE_SECRET`, `SMTP_URL`, and `S3_*` / `LDAP_*` / `OIDC_*` secrets as enabled):

   ```bash
   helm upgrade --install assets deploy/helm/asset-management -f my-values.yaml
   ```

The chart works with OpenShift's `restricted-v2` SCC (no fixed UIDs, read-only root filesystem, all capabilities dropped). It ships a TLS edge Route, NetworkPolicies (only the router reaches web, only release pods reach the backends), PodDisruptionBudgets, optional HPAs, and startup/readiness/liveness probes. Each service receives only the secret keys it needs.

## Organization and access at scale

- **Import the org chart** (Organization → Import): paste one line per unit, `Wix / R&D / Editor / Platform | member links | manager links`. Missing parents are created; re-imports update links and never duplicate units.
- **Link units to the directory.** A unit's member and manager links are LDAP group DNs, ADFS group names, or attribute values such as `department=Platform` (set `LDAP_UNIT_ATTRIBUTES` / `OIDC_UNIT_CLAIMS`). People are placed at every sign-in. Team leads can add people outside the directory by hand.
- **Reorganise freely.** Moving a unit moves its subtree: access, rollups, search and reminders follow immediately.
- **Nobody falls through the cracks.** If an asset's owner leaves, its reminders go to the nearest unit managers up the tree. Per date, a template can send them *never*, *only as a fallback*, or *always*.

## Identity providers

**LDAP / Active Directory** — `LDAP_ENABLED=true`, a bind account, `LDAP_USER_BASE_DN`, and `ldaps://` or `LDAP_STARTTLS=true` with `LDAP_CA_CERT`. Users are provisioned at first sign-in; `memberOf` (or a group search via `LDAP_GROUP_BASE_DN`) syncs their groups each time. Members of `LDAP_ADMIN_GROUPS` become administrators.

**ADFS (OpenID Connect)** — in ADFS, create an Application Group → *Server application accessing a web API*:

- Redirect URI: `https://<public-url>/api/identity/auth/oidc/callback`
- Scopes: `openid`, `profile`, `email`, `allatclaims` (puts the issued claims into the ID token)
- Issuance transform rules: send `UPN` → `upn`, `E-Mail-Address` → `email`, `Display-Name` → `unique_name`, and *Token-Groups – Unqualified Names* → `group`
- Configure `OIDC_ISSUER=https://<adfs>/adfs`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ADMIN_GROUPS`

Groups from LDAP or ADFS appear under **People & groups**; grant them access under **Access**.

## Notifications

- **Email:** the scheduler runs every 15 minutes (`DISPATCH_CRON`, once per tick across replicas). It sends one digest per recipient: the latest passed reminder per item, a due-day reminder, and a weekly nudge while overdue. Deliveries are recorded, so nothing is sent twice.
- **Outlook:** every open obligation is an all-day calendar invite (`METHOD:REQUEST`) with a stable UID. Moving the date updates the same entry (increasing `SEQUENCE`); renewing, dismissing or retiring cancels it (`METHOD:CANCEL`). Both go through the configured SMTP relay (Exchange or Office 365).
- **Calendar feed:** each user has a private iCalendar URL (Profile → Calendar subscription) for *Add calendar → Subscribe from web*.

People can turn email reminders and Outlook invites on or off in their profile.

## Observability (opt-in)

Everything is off by default; each signal is switched on independently.

| Signal | What you get | Switch |
| --- | --- | --- |
| **Metrics** | Prometheus format on each service's `GET /metrics`: HTTP latency by route, DB pool, outbox backlog, event handling, job runs, process metrics, plus business counters (`am_logins_total`, `am_request_events_total`, `am_notifications_sent_total`). | `METRICS_ENABLED=true` |
| **Traces** | OpenTelemetry auto-instrumentation (HTTP, Fastify, pg, AWS SDK/S3, undici fetch). Spans are named by route, and context flows across the event bus (the trace carrier rides in the outbox payload), so *HTTP → outbox → consumer* is one trace. Exported over OTLP (`http/protobuf` or `grpc`). | `OTEL_ENABLED=true` + standard `OTEL_*` env vars |
| **Logs** | pino JSON to stdout, or Elastic Common Schema (`LOG_FORMAT=ecs`). Every log line inside a request carries `trace_id`/`span_id` (`trace.id`/`span.id` in ECS), so you can jump from a log to its trace. | `LOG_FORMAT=json\|ecs` |

**Helm** (`observability.*` in `values.yaml`):

```yaml
observability:
  logs:    { format: ecs }
  metrics:
    enabled: true
    serviceMonitor: { enabled: true }   # Prometheus Operator / OpenShift user-workload monitoring
    vmServiceScrape: { enabled: false } # VictoriaMetrics Operator
    prometheusRule: { enabled: true }   # 7 alerts: 5xx rate, p95 latency, failing events, outbox backlog, stalled reminders, DB pool, failing email
    grafanaDashboard: { enabled: true } # ConfigMap labelled grafana_dashboard=1 (sidecar pick-up)
  tracing:
    enabled: true
    backend: otlp                       # or "elastic"
    endpoint: http://otel-collector.observability:4318
    samplingRatio: 0.1                  # parentbased_traceidratio
```

**Elastic APM:** set `backend: elastic` and `elastic.serverUrl` to your APM Server (or Elastic Cloud APM endpoint), which accepts OTLP natively. Put the auth header into the app Secret as `OTEL_EXPORTER_OTLP_HEADERS` — `Authorization=Bearer <secret token>` or `Authorization=ApiKey <base64 key>`. Use `logs.format: ecs` so Filebeat/Elastic Agent links logs to APM traces. Any OTLP backend (Tempo, Jaeger, Honeycomb, Datadog Agent, an OTel Collector) works the same way with `backend: otlp`.

**Locally:**

```bash
docker compose --profile observability up -d   # Collector, Jaeger :16686, VictoriaMetrics :8428, Grafana :3000
METRICS_ENABLED=true OTEL_ENABLED=true pnpm dev
```

Grafana opens on the same dashboard the chart ships (`deploy/helm/asset-management/dashboards/asset-management.json`). The `pnpm dev` scripts preload `packages/platform/src/telemetry/bootstrap.ts`; production images run `node --import ./dist/telemetry.mjs`, so instrumentation is registered before any library loads. With `OTEL_ENABLED` unset, the preload does nothing and none of the OTel packages are loaded.

## Security notes

- Access tokens: 15-minute ES256 JWTs in an `HttpOnly; Secure; SameSite=Lax` cookie. Refresh tokens rotate on every use, are stored hashed, and are scoped to `/api/identity/auth`.
- CSRF: SameSite cookies, plus a required `X-Requested-With` header on unsafe methods. JSON-only bodies.
- Presigned POST policies pin the object key, content type and maximum size. Uploads are confirmed with `HeadObject` before they become visible. Downloads use short-lived URLs with `Content-Disposition`. Active content types such as HTML and SVG are rejected.
- Restricted values live in a separate column: they are excluded from search and redacted unless the caller has *manage*. The activity log records that they changed, never their values.
- LDAP filter input is escaped (RFC 4515), the OIDC flow uses PKCE + state + nonce, and login is rate-limited.
