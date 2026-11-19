# Asset Management

A generic system for everything an organisation buys and has to keep track of — software licenses, SIM lines, hardware, certificates, contracts — with templates, tracked dates, reminders, documents and fine-grained access. Built for OpenShift, backed by PostgreSQL and S3.

- **Templates, not hard-coded types.** An asset type is a template of fields (text, number, currency, date, select, person, secret, linked asset, …). "Software license" and "SIM line" are just starter templates.
- **Dates have meaning.** Any date field can be tagged with a *date kind* — Renewal, Notice deadline, Expiry, Payment due, Warranty end, or one you define. The kind decides behaviour (one-off, recurring, informational), default reminders and the action verb ("Renew", "Pay"). Dates can be *derived* ("cancellation deadline = renewal date − notice period") and *recur* by a fixed interval or by another field ("term in months").
- **Reminders that people act on.** One digest email per person, Outlook calendar invites that move or cancel when the date changes, and a personal calendar feed. "Renew" rolls the date forward and closes the occurrence, including derived dates.
- **Access by purchase class.** Each asset is "purchased for" a purchase class (department, client, project). Users or LDAP/ADFS groups get *view*, *edit* or *manage* per purchase class × asset type. Restricted fields (license keys, PINs) are visible to managers only and never searchable.
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
| **identity** | People, groups, purchase classes, grants, sessions; issues ES256 access tokens (JWKS) | LDAP/AD, ADFS |
| **registry** | Asset types (versioned templates), date kinds, assets, activity log | — |
| **files** | Document metadata; presigned S3 POST/GET | S3, registry (access check) |
| **scheduler** | Obligations (occurrences of tracked dates), reminder deliveries, invites, calendar feeds | SMTP |
| **web** | React SPA served by nginx, which proxies `/api/<service>/` | all |

**Boundaries.** Each service owns one Postgres schema; its connection's `search_path` is pinned to it, so it cannot read another service's tables. Services integrate through events written to a **transactional outbox** and relayed via **pg-boss** (`asset.changed`, `asset.deleted`, `user.changed`, `purchase-class.changed`); consumers keep small local projections and are idempotent (at-least-once delivery). The only synchronous call is files → registry to authorise document access, because the registry owns asset authorisation. Every service verifies the caller's token locally against identity's JWKS.

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
| **Purchase class** | Engineering, Client: Acme | Every asset belongs to one; the primary access boundary. |
| **Grant** | Group "Procurement" → manage on Engineering × all types | Users or directory groups; highest matching grant wins. |
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

Sign in as `admin` / `admin-change-me` (local break-glass account from `.env`). Emails and Outlook invites are captured by Mailpit at http://localhost:8025. To try LDAP sign-in, set `LDAP_ENABLED=true` and the `LDAP_*` values shown in `docker-compose.yml` (users `alice`/`bob`, password `password`).

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

## Security notes

- Access tokens: 15-minute ES256 JWTs in an `HttpOnly; Secure; SameSite=Lax` cookie. Refresh tokens rotate on every use, are stored hashed, and are scoped to `/api/identity/auth`.
- CSRF: SameSite cookies, plus a required `X-Requested-With` header on unsafe methods. JSON-only bodies.
- Presigned POST policies pin the object key, content type and maximum size. Uploads are confirmed with `HeadObject` before they become visible. Downloads use short-lived URLs with `Content-Disposition`. Active content types such as HTML and SVG are rejected.
- Restricted values live in a separate column: they are excluded from search and redacted unless the caller has *manage*. The activity log records that they changed, never their values.
- LDAP filter input is escaped (RFC 4515), the OIDC flow uses PKCE + state + nonce, and login is rate-limited.
