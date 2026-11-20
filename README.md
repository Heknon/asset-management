# Asset Management

A generic system for everything an organisation buys and has to keep track of — software licenses, SIM lines, hardware, certificates, contracts — with templates, tracked dates, reminders, documents and fine-grained access. Built for OpenShift, backed by PostgreSQL and S3.

- **Templates, not hard-coded types.** An asset type is a template of fields (text, number, currency, date, select, person, secret, linked asset, …). "Software license" and "SIM line" are just starter templates.
- **Dates have meaning.** Any date field can be tagged with a *date kind* — Renewal, Notice deadline, Expiry, Payment due, Warranty end, or one you define. The kind decides behaviour (one-off, recurring, informational), default reminders and the action verb ("Renew", "Pay"). Dates can be *derived* ("cancellation deadline = renewal date − notice period") and *recur* by a fixed interval or by another field ("term in months").
- **Reminders that people act on.** One digest email per person, Outlook calendar invites that move or cancel when the date changes, and a personal calendar feed. "Renew" rolls the date forward and closes the occurrence, including derived dates.
- **Built for a whole company.** An organization tree (company → divisions → departments → teams → squads) drives everything. Membership comes from LDAP/ADFS groups or attributes like `department`. Members get their unit's default role, managers are Admins of everything beneath their unit, and division heads get rolled-up spend and renewals per sub-unit. Restricted fields (license keys, PINs) need the *See secrets* permission and are never searchable.
- **Roles, simple or precise.** Access is a role — Viewer, Commenter, Contributor, Editor, Admin — or a custom set of ten permissions, given to a person, an organization unit (everyone in it and beneath it) or an LDAP / ADFS group, on a unit, the whole organization or a catalog.
- **Catalogs you can share.** A unit groups its assets into catalogs ("R&D developer tooling", "Device lab") and shares them with other teams, divisions, groups or people, with any role.
- **Owners and buyers in one loop.** Before a renewal, the owner is asked "still needed?" automatically or with one click: renew as is, renew with changes, or don't renew. Every asset has a conversation with @mentions, and renewal decisions are recorded in it, next to its documents.
- **Export any table to CSV**, with the same filters, search and sorting, and only the rows (and fields) you are allowed to see.
- **Requests.** Anyone can ask for something for their team, or for any unit above it ("my department needs…", "the whole company needs…"). Procurement moves each request through a workflow of its own statuses (Jira-style, configurable per template); fulfilling creates the asset and links it back. Renewals are requests too. Everyone involved is emailed at each step.
- **Search that forgives.** One box searches every non-restricted field of every asset you can see, plus requests, teams and people. Words can match partially, anywhere in the text, or with small typos. Results show which field matched. Filters work on any field in plain language ("Renewal date is in the next 90 days", "Seats is at least 40"). Any search can be saved as a pinned view.
- **Phone, tablet and desktop; light and dark.** Below 1024px the sidebar becomes a slide-in menu under a compact top bar; dialogs rise from the bottom and forms take the full screen on phones; touch screens get larger targets and controls that don't depend on hover; wide tables keep the item name pinned while the rest scrolls; the calendar becomes a dotted month plus a day list. Theme is Light, Dark or Match device (follows the OS live), from the user menu.
- **Documents in S3** with presigned upload/download URLs and in-app preview (PDF, images, text, video, audio).
- **Sign-in** with LDAP / Active Directory, ADFS (OpenID Connect), and a break-glass local admin.

## Architecture

```
                 ┌──────────── OpenShift Route (TLS) ────────────┐
                 │                                               │
Browser ───────► web (nginx: SPA + /api/* reverse proxy, CSP)
AI assistant ──► (/mcp) ──► mcp ──► registry · scheduler · identity, with the person's token
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
| **mcp** | Nothing (stateless): the Model Context Protocol server for AI assistants | registry, scheduler, identity — over HTTP, as the signed-in person |
| **web** | React SPA served by nginx, which proxies `/api/<service>/`, `/mcp` and the OAuth discovery documents | all |

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
| **Request** | REQ-1042 "10 Miro seats" for Platform; REQ-1043 "Renew Miro" | A purchase or a renewal, moving through a workflow (default: Submitted → In review → Approved → Ordered → Fulfilled, or Declined/Cancelled). Handlers have “Handle renewals” on the unit. |
| **Obligation** | "Renew GitHub Enterprise by Dec 30" | One active occurrence per asset × date field; done / snoozed / dismissed. |

## Local development

Requirements: [Bun](https://bun.sh) 1.4+, Node 22 (production runtime of the service images), Docker.

```bash
bun install
docker compose up -d                  # Postgres, MinIO, Mailpit, OpenLDAP
cp .env.example .env
bun run dev                           # services on :4001-4004 (Bun, restarts on change), web on http://localhost:5173
bun run seed                          # optional demo data
```

Sign in as `admin` / `admin-change-me` (local break-glass account from `.env`). The seed builds a company of about 150 units, 60 people and 400 assets. Try it as different people (password `password-1234`):

| Account | Persona | What to look at |
|---|---|---|
| `dana.cohen` | Procurement lead (manages the whole company) | Requests → To handle; Upcoming → "Waiting for owner"; ⋯ → Ask the owner |
| `tom.levi` | Platform team member | Upcoming → "Waiting for your answer"; the asset's conversation |
| `rachel.amar` | R&D division head | Catalogs → R&D developer tooling → Share; My teams → R&D rollups |
| `noa.mizrahi` | Finance (views company-wide) | Spend on the home screen; Catalogs → shared with her at edit; Export CSV |
 Emails and Outlook invites are captured by Mailpit at http://localhost:8025. To try LDAP sign-in, set `LDAP_ENABLED=true` and the `LDAP_*` values shown in `docker-compose.yml` (users `alice`/`bob`, password `password`).

```bash
bun run typecheck && bun test         # strict TypeScript across all packages + unit tests
docker compose --profile app up -d    # the production images, on http://localhost:8080
```

## Run modes: server or entirely in the browser

The same services run in two ways. Nothing is duplicated: each service is a definition (migrations, routes, event handlers) plus a few adapters for what differs between runtimes.

| | Server (production) | Browser |
|---|---|---|
| Where | OpenShift / Docker, one container per service | One service worker inside the user's browser |
| Database | Postgres, a schema per service | [PGlite](https://pglite.dev) (Postgres compiled to WebAssembly) in IndexedDB, the same schemas and migrations |
| Events | pg-boss queues with a transactional outbox | In-memory queue, same outbox, same retries |
| HTTP | Fastify | An in-process router with Fastify's request/reply shape; the same routes and request policy |
| Documents | S3 / MinIO, presigned URLs | IndexedDB, short-lived links served by the worker |
| Email | SMTP (Exchange / Office 365) | Kept in the browser: **Sent emails** page |
| Sign-in | Local, LDAP / AD, ADFS (OIDC) | Local accounts (one-click Administrator, demo personas) |

One environment variable switches between them: `VITE_RUNTIME` = `server` (default) or `browser`, set in the shell or in `.env`. The web app's normal `dev` and `build` commands read it; in browser mode they also build the service worker and the Postgres binaries.

```bash
VITE_RUNTIME=browser bun run --filter web dev    # browser mode on http://localhost:5173 (no Docker, no services)
VITE_RUNTIME=browser bun run --filter web build  # static site + service worker in apps/web/dist
```

On Vercel, `VITE_RUNTIME=server` runs the services as a Vercel Function (next section); unset or `browser`, the deployment is the in-browser version.

In browser mode the web app registers `/sw.js`, which starts the four services on first use (a few seconds the first time: it downloads Postgres and runs every migration; about a second afterwards). The service worker answers every `/api/*` request, so the web app, its links, downloads, previews and uploads are unchanged. The sign-in page offers **Continue as Administrator** and **Load the demo company** (the same seed as `bun run seed`, run inside the browser in about half a minute), then one-click sign-in as each persona.

What to expect in browser mode:

- Data lives in this browser only (per device and browser profile); **user menu → Reset this browser's data** wipes it. Clearing site data does too.
- Reminders and the daily renewal checks run while the app is open in a tab.
- No directory sign-in (LDAP / ADFS) and no outgoing email: messages are listed under **Sent emails**.
- Private windows and browsers without service workers cannot run it; the app says so.

Code: `packages/browser-runtime` (PGlite dialect, router, bus, storage, mailbox, service worker), `packages/platform` (portable building blocks; `@am/platform/node` is the server runtime), each service's `src/service.ts` (its definition) and `src/main.ts` (the server entry point with Node adapters).

## Serverless on Vercel (Neon + S3)

With `VITE_RUNTIME=server` in the Vercel project, `scripts/build-vercel.mjs` (the project's build command) produces the web app plus **one Vercel Function serving all of `/api`, `/mcp` and the OAuth discovery documents**: the same five service definitions (MCP included — connect assistants at `https://<domain>/mcp`), each with its own Postgres schema, run in one process (`packages/serverless`). Nothing runs between requests:

- **Events** go through the same durable pg-boss queues as the server, but are delivered right after the change that caused them (after the response is sent, with `waitUntil`) instead of by always-on workers. Anything left over, and failed deliveries' retries, run on the next change or cron call.
- **Reminders, renewal checks and housekeeping** run from Vercel Cron, calling `/api/cron` twice a day (06:00 and 18:00 UTC; `REMINDER_CRON` changes it at build time; Hobby plans allow daily only). Reminders are kept per day and per person, so each goes out once.
- **Signing keys** for sign-in tokens and cookies are generated on first start and kept in the database (`serverless.secrets`), unless `AUTH_SIGNING_KEY` / `COOKIE_SECRET` are set.

It reads what the integrations already provide:

| Variable | From | Used for |
|---|---|---|
| `DATABASE_URL_UNPOOLED` | Neon integration | Postgres (direct connection: each service pins its schema per connection, which the pooled endpoint does not allow) |
| `STORAGE_S3_BUCKET_NAME`, `STORAGE_AWS_REGION`, `STORAGE_AWS_ROLE_ARN` | AWS S3 integration | Documents; the function assumes the role with Vercel's OIDC token, no access keys |
| `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_BRANCH_URL` | Vercel | Links in emails, sign-in redirects, the bucket's CORS (`PUBLIC_URL` overrides) |

Set in the project (Settings → Environment Variables):

| Variable | Example | |
|---|---|---|
| `VITE_RUNTIME` | `server` | Required: build the function instead of the in-browser version |
| `LOCAL_ADMIN_PASSWORD` | 12+ characters | The first administrator, user name `admin` (or `LOCAL_ADMIN_USERNAME`); needed to sign in the first time |
| `AUTH_MODE` | `manual`, `ldap`, `adfs`, `manual,ldap`… | Sign-in methods. `manual`: admins add people with a password (**People & groups → Add person**), people change it on their profile. Unset: `manual` |
| `SMTP_URL`, `MAIL_FROM` | `smtps://user:pass@smtp.postmarkapp.com:465` | Email. Unset: nothing is sent and reminders wait (they go out once mail is set up) |
| `CRON_SECRET` | random string | Vercel sends it with cron calls; `/api/cron` then refuses anyone else |

LDAP and ADFS take the same `LDAP_*` / `OIDC_*` variables as the server, but the directory must be reachable from Vercel (the internet). Uploads and previews go from the browser straight to the bucket; on first start the function adds this deployment's origins to the bucket's CORS when its role allows, and logs a warning otherwise (then add a CORS rule allowing `GET`, `HEAD`, `POST` from your domain).

Locally: `bun run --filter @am/serverless dev` runs the same runtime on one port (`.env` as for the server; `PORT`, default 3000), and `VITE_API_URL=http://localhost:3000 bun run --filter web dev` points the app at it. `GET /api/health` lists the running services.

## Deploying to OpenShift

One Helm release, **six Deployments** — `identity`, `registry`, `files`, `scheduler`, `mcp` and `web` — each with its own Service, ConfigMap, PodDisruptionBudget and (optionally) HPA, installed by Terraform. Two switches decide where data lives:

| Flag (Helm / Terraform) | `true` (default) | `false` |
|---|---|---|
| `postgresql.managed` / `managed_postgres` | Managed PostgreSQL at `DATABASE_URL` (Crunchy, CloudNativePG, RDS, Azure…) | A PostgreSQL StatefulSet in the namespace (Red Hat's `rhel9/postgresql-16`), password generated and kept across upgrades |
| `objectStorage.managed` / `object_storage` | Any S3-compatible storage you provide: your own MinIO, OpenShift Data Foundation (NooBaa), Ceph RGW, another cloud's S3 API, or AWS (Terraform: `object_storage = "s3"` with endpoint, bucket and keys; or `"aws"` to have Terraform create the bucket) | `object_storage = "in-cluster"`: MinIO in the namespace; the bucket is created on start and browsers reach it on its own Route (`objectStorage.inCluster.publicHost`, default `<app-host>-storage.<domain>`) |

Nothing is tied to a cloud: PostgreSQL is any server at `DATABASE_URL`, and storage is any S3 API. The AWS provider is only used with `object_storage = "aws"`; otherwise it is never contacted (it still has to be in your Terraform provider mirror, since the configuration declares it).

Sign-in is chosen with `AUTH_MODE` (`TF_VAR_auth_mode`): `manual`, `ldap`, `adfs`, or a comma-separated mix.

### With GitLab CI, air-gapped (`.gitlab-ci.yml`)

Every push runs **verify** (install, typecheck, unit tests, Helm lint in both data-store modes, Terraform validate) and **build** (six images with rootless Buildah — no Docker daemon, no privileged runner). Pushes to **main** also **deploy**: Terraform plans and applies the release, with state kept in GitLab's own Terraform state.

Nothing is fetched from the internet; everything comes from Artifactory, configured with CI/CD variables (the full list with examples is at the top of `.gitlab-ci.yml`):

| What | Variables |
|---|---|
| npm packages for `bun install` | `NPM_REGISTRY`, `NPM_AUTH_TOKEN` (passed to the image build as a Buildah secret, never stored in a layer) |
| Base images and CI tool images | `DOCKER_MIRROR`, `QUAY_MIRROR`, `REDHAT_MIRROR`, `ARTIFACTORY_USER`, `ARTIFACTORY_TOKEN` |
| Terraform providers | `TF_PROVIDER_MIRROR` (Artifactory's Terraform network mirror) |
| Where images are pushed (and pulled from) | `IMAGE_REGISTRY`, `IMAGE_REGISTRY_USER`, `IMAGE_REGISTRY_PASSWORD`; OpenShift pulls with `PULL_USER`/`PULL_PASSWORD` (a pull Secret Terraform creates) |
| In-cluster PostgreSQL / MinIO images | `THIRD_PARTY_MIRROR` |
| The cluster | `OPENSHIFT_SERVER`, `OPENSHIFT_TOKEN`, `OPENSHIFT_CA` |
| The app | `TF_VAR_public_url`, `TF_VAR_namespace`, `TF_VAR_auth_mode`, `TF_VAR_managed_postgres`, `TF_VAR_object_storage`, `TF_VAR_s3`, `TF_VAR_database_url`, `TF_VAR_smtp_url`, `TF_VAR_ldap`, `TF_VAR_oidc` |

The same Dockerfile builds by hand: `buildah bud --target service --build-arg SERVICE=mcp --build-arg NPM_REGISTRY=… --secret id=npmrc,src=.npmrc …` (every base image is a build argument: `BUN_IMAGE`, `NODE_IMAGE`, `SERVICE_BASE_IMAGE`, `WEB_BASE_IMAGE`).

### By hand

1. **Build and push images** (one Dockerfile, six images):

   ```bash
   REG=default-route-openshift-image-registry.apps.<cluster>/asset-management TAG=0.1.0
   for s in identity registry files scheduler mcp; do
     buildah bud --target service --build-arg SERVICE=$s -t $REG/asset-management-$s:$TAG . && buildah push $REG/asset-management-$s:$TAG
   done
   buildah bud --target web -t $REG/asset-management-web:$TAG . && buildah push $REG/asset-management-web:$TAG
   ```

2. **Provision with Terraform** (`deploy/terraform/environments/production`). With managed storage this creates the S3 bucket (private, versioned, encrypted, TLS-only, CORS for the app origin, least-privilege IAM); it always generates the JWT signing key and cookie secret, writes the `asset-management` Secret (and a registry pull Secret when given), and installs the Helm chart:

   ```bash
   oc login ...
   cd deploy/terraform/environments/production
   cp terraform.tfvars.example terraform.tfvars    # fill in; prefer TF_VAR_* for secrets
   terraform init && terraform apply
   terraform output -raw local_admin_password
   ```

   Each service creates and migrates its own schema in an init container.

3. **Or use Helm directly** with your own Secret (keys: `DATABASE_URL` unless `postgresql.managed=false`, `AUTH_SIGNING_KEY`, `COOKIE_SECRET`, `SMTP_URL`, and `S3_*` / `LDAP_*` / `OIDC_*` secrets as enabled):

   ```bash
   helm upgrade --install assets deploy/helm/asset-management -f my-values.yaml \
     --set postgresql.managed=false --set objectStorage.managed=false   # everything in the namespace
   ```

The chart works with OpenShift's `restricted-v2` SCC (no fixed UIDs, read-only root filesystem, all capabilities dropped). It ships TLS edge Routes, NetworkPolicies (only the router reaches web, only release pods reach the backends and the in-cluster data stores), PodDisruptionBudgets, optional HPAs, and startup/readiness/liveness probes. Each service receives only the secret keys it needs. For air-gapped clusters set `image.registry`, `image.pullSecrets` and `image.mirrorRegistry` (third-party images).

## AI assistants (MCP)

People can connect Claude, an IDE or any other [Model Context Protocol](https://modelcontextprotocol.io) client to Assets and ask things like "what renews next month in my team?" or "request two more Figma seats for Design".

- **Connecting:** add `https://<your-assets-url>/mcp` as a remote MCP server (in Claude: Settings → Connectors → Add custom connector). The client opens Assets; the person signs in as usual (manual, LDAP or ADFS) and presses **Accept**.
- **What it can do:** search; list and read assets, asset types and units; see upcoming dates; list, read and create requests; comment on assets. Every call runs **as that person, with exactly their access**: the MCP server calls the same APIs as the app with the person's token.
- **Disconnecting:** Profile → Signed-in devices lists each connected app; **Disconnect** stops it within the hour (its refresh token is revoked at once; the last access token lapses).

How it works: identity is an OAuth 2.1 authorization server (RFC 8414 metadata at `/.well-known/oauth-authorization-server`, open dynamic client registration per RFC 7591, PKCE S256 only, single-use two-minute codes, rotating refresh tokens). The MCP service publishes RFC 9728 protected-resource metadata, answers `401` with `WWW-Authenticate: Bearer resource_metadata=…`, and only accepts tokens whose audience includes `<public-url>/mcp` — an ordinary app session cannot be replayed against it. Redirect URIs must be `https`, `http://localhost` / `127.0.0.1`, or a native app scheme. It speaks stateless Streamable HTTP, so any replica (or serverless instance) answers any request. Set `services.mcp.enabled=false` (Terraform: `mcp_enabled = false`) to turn it off.

## Organization and access at scale

- **Import the org chart** (Organization → Import): paste one line per unit, `Wix / R&D / Editor / Platform | member links | manager links`. Missing parents are created; re-imports update links and never duplicate units.
- **Link units to the directory.** A unit's member and manager links are LDAP group DNs, ADFS group names, or attribute values such as `department=Platform` (set `LDAP_UNIT_ATTRIBUTES` / `OIDC_UNIT_CLAIMS`). People are placed at every sign-in. Team leads can add people outside the directory by hand.
- **Reorganise freely.** Moving a unit moves its subtree: access, rollups, search and reminders follow immediately.
- **Nobody falls through the cracks.** If an asset's owner leaves, its reminders go to the nearest unit managers up the tree. Per date, a template can send them *never*, *only as a fallback*, or *always*.

## Roles and permissions

Access is always *who* × *what they can do* × *where*:

- **Who:** a person, an organization unit (everyone in it and in the units beneath it), or a directory group (LDAP / ADFS groups are synced at sign-in; local groups can be managed under People & groups).
- **Where:** a unit and everything beneath it (optionally only one kind of item, e.g. only Software licenses), the whole organization, or a catalog.
- **What:** a role, or *Custom* with exactly the permissions you tick:

| Permission | Lets you | Viewer | Commenter | Contributor | Editor | Admin |
|---|---|:-:|:-:|:-:|:-:|:-:|
| See items | items, fields, dates, documents, conversation | ✓ | ✓ | ✓ | ✓ | ✓ |
| Comment | write in conversations |  | ✓ | ✓ | ✓ | ✓ |
| Add documents | upload contracts, invoices, quotes |  |  | ✓ | ✓ | ✓ |
| Add items | create new items |  |  | ✓ | ✓ | ✓ |
| Edit items | change fields, status, owner, team, catalog |  |  |  | ✓ | ✓ |
| Handle renewals | renew, snooze, dismiss, ask owners; handle requests |  |  |  | ✓ | ✓ |
| Export | download tables as CSV |  |  |  | ✓ | ✓ |
| See secrets | restricted fields (license keys, PINs) |  |  |  |  | ✓ |
| Delete | items, and anyone's documents or messages |  |  |  |  | ✓ |
| Manage access | share, give access, catalogs, team templates |  |  |  |  | ✓ |

Access adds up: what someone can do with an item is the union of everything that reaches them — their unit's member role (Commenter by default for new units), Admin on units they manage, grants to them, their groups or their units, catalog shares, and *owner* rights (the owner of an item can always see it, comment and add documents). Templates, date kinds and organization-wide access are managed by administrators and by people who are Admins of the whole organization (e.g. Procurement).

Where to change it: a unit's **Access** tab (its managers), **Share** on a catalog, and **Settings → Access** for the whole organization. Every screen shows inherited access read-only, so "why can she see this?" has an answer in one place. Changes reach people within 15 minutes (the access-token lifetime) or at their next sign-in. Enforcement is one rule in `@am/core` (`effectivePermissions`) and one SQL filter in `@am/platform` (`visibleFilter`), used by every service.

## Templates, team variants and item IDs

- **One template per kind of thing**, owned by the organization (administrators and Admins of the whole company, e.g. Procurement). The license template carries what buying needs: vendor, license/contract ID, purchase order, purchase date, seats, cost, term, renewal date, cancellation deadline, documents.
- **Team variants.** A unit extends a template with what *it* tracks, without forking it: R&D's *Lab license* is a Software license plus the workstations that use it and their MAC addresses. Variants are created by the unit's managers (unit page → **Templates** → *Extend for R&D*) in the same builder, with the template's fields shown locked. Everyone in the unit and beneath it picks the variant as the item's *Kind*. Template changes flow into every variant; a template field may not reuse a variant's field key (the save explains the clash). Items, filters, columns, search, reminders and CSV exports all follow template + variant.
- **Item IDs.** Every item gets a readable ID from its template's prefix: `LIC-42`, `SIM-7`, `HW-118`. IDs are shown everywhere, searchable (typing `lic-42` jumps straight to it), exported, and never reused. The prefix is editable per template; existing items were numbered in creation order by the migration.
- **Lists and multiple links.** A *List* field holds several short values, each checked against a format (MAC address, IPv4, hostname, email or your own pattern); pasting a column adds them all. A *Linked asset* field can link several items (the machines that use a license).

## Importing spreadsheets

**Import** (on All assets, any template, a catalog, or ⌘K → *Import a spreadsheet*) brings in what people already track elsewhere:

1. **Table.** Drop a CSV / TSV / semicolon file or a Markdown file, or paste cells copied from Excel or Google Sheets. Delimiters are detected; a Markdown file with several tables lets you pick one (named after the heading above it).
2. **Where it goes.** The template whose fields best match the columns is suggested (or, for template managers, *New template from these columns* with field types guessed from the values). One team for every row, or a column that names the team (matched by name or path, `R&D / Platform`, with a picker for the rest). Optionally a team variant (*Kind*) and a catalog. *Add every row as new*, or *update items that already exist*, recognised by name, ID (`LIC-42`) or a field such as serial number.
3. **Columns.** Every column is matched to a field, Name, ID, Owner, Team or Status by its header (with common synonyms: Supplier → Vendor, Expires → Renewal date, # of licenses → Seats), each with a live "412 ok · 3 won’t fit" check. Dates are read day-first, month-first or ISO (detected from the values), numbers with currency symbols and either decimal mark, yes/no, option labels (unknown values can be mapped), people by email, username or name, linked items by ID or name, and lists split on `;` `,` or new lines. Columns the template lacks can become the team's own fields in one click (a team variant).
4. **Check.** A full dry run: the real import, rolled back, so the counts (new / updated / unchanged / problems) and every problem — by row and field — are exactly what will happen. Import the good rows and download the problem rows as CSV to fix.
5. **Done.** Items get IDs, reminders, search and history like hand-made ones. *Undo import* removes the items it added that nobody has changed since (Import → *Your recent imports*).

Imports run 500 rows per request (up to 20,000 per file), each row in its own savepoint, with the same permissions as adding items by hand.

## Request workflows and renewal requests

Requests follow a **workflow**: an ordered list of statuses, each with a name, a colour and a *meaning* — **To do** (waiting to be picked up; the first status is where requests start), **In progress**, **Done** (bought, delivered or renewed) and **Closed** (won't happen) — plus the moves allowed between them. A move is made by the people who handle requests, or also by the person who asked (e.g. "Cancel"). Meanings are what lists, counts, emails and automation use, so any workflow works everywhere.

- **Settings → Request workflow** edits the organization's default. **Templates → a template → Requests → Own request workflow** gives one kind of item its own (Hardware: Requested → Awaiting approval → Under purchase → Delivered). Template managers edit both.
- Removing a status, or changing its meaning, moves open requests in it to the new workflow's first status of the same meaning; finished requests keep theirs as history.
- A purchase for a template reaches **Done** by creating the item ("Create the item"), so the item and request stay linked. A request without a template can be marked done directly.
- **Renewal requests** ask the buyers to renew an existing item's date. They open when an owner answers a renewal check with *renew* / *renew with changes*, or from **⋯ → Open a renewal request** on any date. One is open per date at a time. Finishing it rolls a repeating date forward; renewing on the item directly finishes the open request. The date shows the request and its status in Upcoming and on the item.
- Email subjects use the workflow's names ("REQ-1016 is now “Under purchase”").

## Catalogs, conversations and renewal checks

- **Catalogs.** Managers of a unit create catalogs on the unit page (Catalogs tab) or under Catalogs. A catalog holds assets of its unit and every team beneath it; an asset is in at most one catalog (chosen in the asset form). Moving items into or out of a catalog needs *Edit items* on the catalog, because it changes who can see them.
- **Sharing.** *Share* gives a person, a unit (with all its sub-units) or a directory group a role on everything in the catalog, including items added later — e.g. Customer Care as Viewer of the Device lab, a security group as *Custom: See items + See secrets*. Only people with *Manage access* on the catalog change its sharing. Deleting a catalog never deletes assets. Sharing works the same everywhere: listings, search, documents, reminders, calendar and exports (one rule in `@am/core` + `visibleFilter` in `@am/platform`).
- **Renewal checks.** Recurring dates can ask the owner automatically ("Ask the owner first: 60 days before" on the date field; the license and domain templates do this by default), and anyone handling a renewal can ask with one click (⋯ → Ask the owner). The owner gets an email and a "Waiting for your answer" card on Upcoming, and answers with one click: renew as is, renew with changes (with a note) or don't renew. The answer is emailed to whoever asked (or to `REQUEST_INBOX_EMAILS` when the owner speaks first), shown as a badge on the date, and filterable (Upcoming → Waiting for owner / Owner answered). Each occurrence is asked once; the next cycle starts fresh.
- **Conversations.** Every asset has a conversation. Anyone who can see the asset can post; type `@` to mention someone (they are emailed), and the owner is emailed about new messages. Questions and answers from renewal checks appear in the thread, so the documents, the decisions and the discussion about a purchase live in one place.
- **CSV export.** *Export CSV* on any asset table (all assets, a type, a team, a catalog, a saved view) downloads every matching row with the table's filters, search and sort. Columns follow the templates (currency and numbers stay numeric), teams are written as full paths, and restricted fields are included only for people who manage them. Smaller tables (sub-unit rollups) export in the browser. Exports are counted (`am_exports_total`, `am_exported_rows_total`) and logged with who exported what. Set `CSV_EXPORT_ENABLED=false` (Helm: `services.registry.env`, Terraform: `csv_export_enabled`) to turn exports off.

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
METRICS_ENABLED=true bun run dev                # metrics on :4001-4004/metrics
bun run build && (cd services/registry && OTEL_ENABLED=true node --env-file=../../.env --import ./dist/telemetry.mjs dist/main.mjs)
```

Grafana opens on the same dashboard the chart ships (`deploy/helm/asset-management/dashboards/asset-management.json`). Tracing hooks Node's module loader, which Bun does not have, so traces come from the built services run with Node (above, one service at a time, or all of them with `docker compose --profile app up -d`): production images run `node --import ./dist/telemetry.mjs`, so instrumentation is registered before any library loads. With `OTEL_ENABLED` unset, the preload does nothing and none of the OTel packages are loaded.

## Security notes

- Access tokens: 15-minute ES256 JWTs in an `HttpOnly; Secure; SameSite=Lax` cookie. Refresh tokens rotate on every use, are stored hashed, and are scoped to `/api/identity/auth`.
- CSRF: SameSite cookies, plus a required `X-Requested-With` header on unsafe methods. JSON-only bodies.
- Presigned POST policies pin the object key, content type and maximum size. Uploads are confirmed with `HeadObject` before they become visible. Downloads use short-lived URLs with `Content-Disposition`. Active content types such as HTML and SVG are rejected.
- Restricted values live in a separate column: they are excluded from search and redacted unless the caller has *See secrets*. The activity log records that they changed, never their values.
- LDAP filter input is escaped (RFC 4515), the OIDC flow uses PKCE + state + nonce, and login is rate-limited.
