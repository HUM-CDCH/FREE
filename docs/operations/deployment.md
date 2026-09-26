# Private HTTPS Docker deployment

Production runs the same Compose container topology as development, behind the
host-managed nginx that already serves the machine. One command starts it:

```bash
node scripts/free.mjs production
```

It validates `.env` before anything starts, renders the shared nginx
application behavior for the host nginx into `.nginx/free-studio-locations.conf`,
and builds the images. After a successful build it stops Studio and the parsing
API/worker with a 60-second grace period, then runs
`docker compose -f compose.yaml -f compose.prod.yaml up --no-build -d --wait`.
It returns after services start and configured health checks pass. The launcher
requires Node.js 24, Docker, and an installed workspace
(`pnpm install --frozen-lockfile`). It reads FREE's configuration helpers.

`compose.yaml` builds the production Studio client and Node server;
`compose.prod.yaml` adds only the production deltas: restart policies, required
(never defaulted) secrets, real Entra authentication,
and Studio's `127.0.0.1:5173` loopback publish for the host nginx. TLS terminates in the
host nginx — there is no nginx container in production and this stack never
touches the host nginx configuration outside the one include described below.

## Prerequisites and hosted settings

Install Docker with Docker Compose v2.40.0 or later. The launcher checks this
before starting because the production network selection uses `gw_priority`.

The complete backend is built from `prototypes/parsing_service` in this
checkout. Compose runs its read API and its DBOS worker, and with GPU access
the vLLM model servers for OCR and extraction, beside Studio and the one
PostgreSQL server both use. No separate kei-exp repository or host process is
needed.

Both launchers use `FREE_GPU=auto` and probe Docker GPU access. A successful
probe adds `compose.gpu.yaml`, which starts the OCR (Surya) and extraction vLLM
servers: Surya, the NuExtract template extractor, and the instruction model.
Set `FREE_GPU=off` for CPU native-PDF parsing only, or
`FREE_GPU=required` to fail startup unless the GPU is available. Scanned PDFs
and extraction require the GPU model servers; without them an operator can
point `KEI_EXTRACT_URL` at another OpenAI-compatible vLLM endpoint. The
worker's document-layout processing runs on CPU so it does not compete with
the model servers for GPU memory.

First builds install the Python dependencies. The Python environment alone
is about 6 GiB; build caches and exported image layers require additional
space. First GPU startup downloads the Surya OCR weights,
`KEI_NUEXTRACT_MODEL` (default `numind/NuExtract3-FP8`, about 7 GB) and
`KEI_EXTRACT_MODEL` (default `Qwen/Qwen3.8-27B-FP8`, about 31 GB) into the
shared Hugging Face cache. Model caches persist in named volumes. Allow enough disk space,
network access, and startup time for these downloads.

TLS is the host nginx's: obtain a PEM certificate or full chain and its
matching PEM private key from the institution or VPN that owns the private
hostname, and configure them in the host server block as usual. FREE does not
request a public ACME certificate, run an internal CA, generate a self-signed
certificate, or expose a plain-HTTP fallback.

Generate the session secret and two independent database passwords once and
retain them across restarts (run the hexadecimal command once per database):

```bash
openssl rand -base64 32
openssl rand -hex 32
```

Create the ignored root `.env` file with the generated single-line values:

```dotenv
STUDIO_ORIGIN=https://free.example.edu
STUDIO_BASE_PATH=/free
FREE_SESSION_SECRET=<canonical-base64-output>
FREE_POSTGRES_PASSWORD=<hex-output>
FREE_KEI_POSTGRES_PASSWORD=<separately-generated-hex-output>
FREE_ENTRA_TENANT_ID=<microsoft-entra-tenant-uuid>
FREE_ENTRA_CLIENT_ID=<application-client-uuid>
FREE_ENTRA_CLIENT_CERT_PATH=/srv/free-secrets/entra-client.pem
FREE_ENTRA_CLIENT_CERT_THUMBPRINT=<sha256-certificate-thumbprint>
# FREE_DEPLOYMENT_CLI_PROVIDERS=codex-cli,claude-code
# CLAUDE_CODE_OAUTH_TOKEN=<claude-setup-token-output>
```

- `STUDIO_ORIGIN` is the one externally visible, canonical HTTPS origin. Use
  the certificate's DNS name with no trailing slash, path, query, fragment, or
  credentials.
- `STUDIO_BASE_PATH` is the canonical prefixed path, `/free` everywhere by
  convention; development uses the same value, so Entra redirect URIs differ
  from production only by host. The shipped nginx template requires a non-root
  base path. Do not add a trailing slash.
- `FREE_SESSION_SECRET` must be canonical standard Base64 that decodes to at
  least 32 bytes. Keep it secret and stable; replacing it invalidates every
  browser session.
- `FREE_ENTRA_TENANT_ID` and `FREE_ENTRA_CLIENT_ID` identify the single-tenant
  application registration. `FREE_ENTRA_CLIENT_CERT_PATH` names the private-key
  PEM mounted read-only into Studio; the thumbprint is the uploaded
  certificate's SHA-256 fingerprint with or without colons.
- `FREE_POSTGRES_PASSWORD` must be the generated hexadecimal value. Compose
  supplies this one value to PostgreSQL and interpolates it into Studio's
  `DATABASE_URL`; restricting it to hexadecimal avoids URI-encoding and
  Compose-interpolation ambiguity. Changing it does not update an existing
  PostgreSQL volume's password, so retain it with that volume.
- `FREE_KEI_POSTGRES_PASSWORD` is the password of the Parsing Service's own
  database role, `kei`, which owns only the `kei_dbos` schema: the service
  parses untrusted PDFs and must not be able to read Studio's tables or rewrite
  Studio's workflow inputs. Studio's entrypoint creates the role and its
  schema from this value at every start, so changing it takes effect at the
  next start. Use a generated hexadecimal value.
- `FREE_DEPLOYMENT_CLI_PROVIDERS` (optional; `codex-cli`, `claude-code`,
  comma-separated) offers the Codex CLI and Claude Code to every researcher as
  read-only deployment connections. They run on this server's own CLI login,
  so every researcher's calls on them use the operator's billing and rate
  limits; leave it unset to offer neither. Log the CLIs in once inside the
  running container (`docker compose … exec studio codex login --device-auth`;
  Claude Code reads `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`).
- Studio's `DATABASE_URL` role must own database `free` or hold `CREATE` on it
  (DBOS creates the `dbos` schema at launch) and `CREATEROLE` (the entrypoint
  creates `kei`); Compose uses `postgres`.

### GPU and DGX Spark

The GPU overlay runs each model in its own vLLM server, separately from the
Python worker. The worker reaches `http://ocr_model:8000/v1/chat/completions`;
extraction reaches `http://nuextract_model:8000/v1/chat/completions` for field
values and `http://extraction_model:8000/v1/chat/completions` for its reasoning
calls. A run may choose the instruction model for field values too. No model
endpoint is published to the LAN. The servers start one after another, since
each profiles the GPU's free memory when it starts.

`VLLM_IMAGE` selects the image of every model server. The default is the generic vLLM
image; on DGX Spark set it to a validated native ARM64 image with GB10 support.
The previous kei-exp Spark deployment used `eugr/spark-vllm`; the migration
does not establish that an arbitrary tag works on a particular machine.
Validate the selected image and a representative scanned PDF on the target
hardware before serving researchers. GPU visibility alone does not prove
that its CUDA kernels or model architecture work.

For extraction's `Qwen/Qwen3.8-27B-FP8` (the `qwen3_5` architecture), the
image must also support that architecture and FP8 on the target GPU.

`OCR_KV_CACHE_BYTES` sizes the OCR server's KV cache; with a cache size set,
vLLM ignores `OCR_GPU_MEMORY_UTILIZATION`. The default context is 24,576 tokens with up to
`OCR_MAX_NUM_SEQS` (default 4) simultaneous sequences. The same value sets the parsing
processes' `SURYA_INFERENCE_PARALLEL`, so Surya sends no more requests at once than the
server runs. Otherwise a book's queued requests would sit ahead of a small document's. `EXTRACT_MAX_MODEL_LEN` (default 32,768 tokens)
and `EXTRACT_KV_CACHE_BYTES` (default 8G) size the extraction server; it
loads the text model only. `KEI_NUEXTRACT_MODEL` (default
`numind/NuExtract3-FP8`), `NUEXTRACT_MAX_MODEL_LEN` and
`NUEXTRACT_KV_CACHE_BYTES` (default 4G) do the same for the NuExtract server,
which runs its repository's processor code (`--trust-remote-code`); pin a
reviewed model revision if that matters to the deployment. Leave room for every
server's weights, the
document-layout process, and the operating system. Spark's system memory is
shared with its GPU.

For direct Compose commands, add `-f compose.gpu.yaml` after the local or
production overlay. The normal launcher selects it after its GPU probe.

Before installing a certificate, inspect the subject alternative names and
validity period and confirm that the certificate and key produce the same
public-key digest:

```bash
openssl x509 -in /srv/free-tls/studio.crt -noout -checkend 0 \
  -subject -issuer -dates -ext subjectAltName
openssl x509 -in /srv/free-tls/studio.crt -pubkey -noout \
  | openssl pkey -pubin -outform DER | openssl sha256
openssl pkey -in /srv/free-tls/studio.key -pubout -outform DER \
  | openssl sha256
```

The two SHA-256 outputs must match. Also validate the chain with the
institution's or VPN's trust procedure.

## Host nginx (one-time include)

The application-facing proxy behavior — base-path routing and redirects,
forwarded headers, security headers, the 110m body limit, and timeouts — is
version-controlled once in
[`docker/nginx/free-studio-locations.inc.template`](../../docker/nginx/free-studio-locations.inc.template)
and consumed identically by the development nginx container and the host
nginx. `node scripts/free.mjs production` renders it with the deployment's
`STUDIO_BASE_PATH` and the `127.0.0.1:5173` upstream into the git-ignored
`.nginx/free-studio-locations.conf`; re-running the command re-renders it, so
the file is always current.

The host wrapper stays thin and host-managed: the existing (or a new) server
block for the canonical hostname keeps its own `listen`, `server_name`, and
TLS directives and adds only the include plus the namespaced websocket map:

```nginx
map $http_upgrade $free_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name free.example.edu;

    ssl_certificate     /srv/free-tls/studio.crt;
    ssl_certificate_key /srv/free-tls/studio.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    include /srv/free/FREE/.nginx/free-studio-locations.conf;
}
```

Adjust the include to the repository checkout path (or copy the rendered file
under `/etc/nginx/` if policy requires it — then re-copy after every
`STUDIO_BASE_PATH` change or template update). The rendered file contains only
`location` blocks for `STUDIO_BASE_PATH`, so it cannot affect anything else
the host nginx serves. Validate and load:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Restrict the host nginx's TLS port to the intended private network with the
host or perimeter firewall; Studio's `127.0.0.1:5173` publish is loopback-only
and never needs to be exposed.

## Bundled nginx (hosts without a managed nginx)

On a host where the operator cannot configure nginx (no root, as on the DGX
Spark), set `FREE_NGINX=container`. The launcher then adds
[`compose.nginx.yaml`](../../compose.nginx.yaml): an nginx container renders
the same shared location template and terminates TLS itself, and nothing is
rendered for a host nginx.

```dotenv
FREE_NGINX=container
FREE_NGINX_PORT=11434
FREE_TLS_CERT_PATH=/home/free/free-tls/studio.crt
FREE_TLS_KEY_PATH=/home/free/free-tls/studio.key
STUDIO_ORIGIN=https://free.example.edu:11434
```

The container publishes `FREE_NGINX_PORT` (default 443) on every interface;
`STUDIO_ORIGIN` must carry the same port, and the Entra redirect URIs follow
from it. The certificate should be a full chain, and the launcher refuses to
start unless both files exist. The bundled nginx has the fixed address
`172.30.0.10` on the `proxy` network, which is Studio's only trusted proxy
peer, and Studio publishes no host port. Restrict the published port with the
perimeter firewall as for the host nginx; certificate renewal replaces the two
files and restarts the `nginx` service.

## Start and preserve state

Normal startup builds before it stops the existing Studio and parsing
API/worker, so a failed build leaves the application running. Once they stop,
Compose starts Studio: its entrypoint replays the authored migrations, creates
the Parsing Service's role and schema, and Studio launches DBOS, which migrates
the `dbos` schema and applies the ten-minute garbage-collection schedule. The
Parsing Service's worker starts only after Studio is healthy; it takes its slot
lock (`KEI_RUNS/.worker-<slot>.lock`), reads the database clock as its boot
timestamp and migrates `kei_dbos`. A failed migration prevents startup. The
launcher never resets a database or seeds an account, Project Context, Model
Connection, route, or key.

```bash
node scripts/free.mjs production
docker compose -f compose.yaml -f compose.prod.yaml ps
curl --fail --silent --show-error https://free.example.edu/free/api/healthz
```

Retain the `postgres-data`, `source-inbox`, `parsing-runs`, `studio-data`,
`studio-config` and `studio-claude` volumes; the model caches are
re-downloadable. Completed runs are inputs to later extractions, not caches. A
plain `docker compose down` retains volumes; `down --volumes` destroys them.
Never run `down` on a GPU host just to redeploy: it stops the model servers
too.

Studio's container healthcheck opens a local TCP connection, which succeeds
only after migrations and the DBOS launch. The Parsing Service API has its own
healthcheck; the worker logs `kei worker kei-<slot> serving` once it serves its
lanes. Extraction quality is checked by integration validation, not by the
health routes. Check the public application through the configured HTTPS proxy
and sign-in path.

## Manage Researcher access

Assign or remove Researchers on the Microsoft Entra enterprise application.
FREE requests only `openid` and `profile`; it does not use Graph, groups, app
roles, refresh tokens, or a local disable list. A successful sign-in creates or
refreshes the local account keyed by the tenant and object claims.

FREE sessions are fixed and expire eight hours after successful sign-in,
independently of the identity token's later expiry. Token validity is checked
at sign-in. This applies to both Microsoft Entra and local mock OIDC. On
expiry the browser captures only the supported in-progress extraction, schema,
and batch drafts in same-tab storage, signs in again through Entra, and restores
them only for the same account and resource. Arbitrary component-local text can
be lost. Removing an Entra assignment takes effect at the next sign-in, which
can be up to eight hours later; rotating `FREE_SESSION_SECRET` is the only immediate
global forced logout and signs out everyone.

See [the Entra authentication runbook](entra-authentication.md)
for registration, certificate rotation, guarded cutover, and smoke checks.

## Configure models

After signing in, each researcher opens **Configure models** in the Project
Context rail. The configuration belongs to that Researcher Account and applies
to its own Project Contexts only.

1. **Connections**: the deployment's own servers are listed read-only — the
   vLLM servers with the GPU overlay, and the CLI providers the operator
   enabled. A researcher adds their own connections (Ollama, OpenAI, Anthropic,
   Google, vLLM, OpenAI-compatible). A key typed there stays in that browser;
   Studio holds a copy only in memory while it needs one.
2. **Models**, in three steps: *Reading documents* (the Ingestion Model Choice:
   the OCR and layout models for new ingestions and reprocessing), *Schema &
   chat* (the Assistant model; Schema Suggestion follows it unless given its
   own model) and *Extracting data* (the Extraction Model Choice). A step at its
   defaults says so in one sentence.
3. **Apply** saves the whole configuration in one transaction.

A Studio restart empties its memory: an open page sends its keys again with
its next request, and background work started without an open page fails with
`model_key_required` until the researcher retries it. A keyless Ollama
connection is called anonymously even when the operator's environment sets
`OLLAMA_API_KEY`; a researcher who uses ollama.com enters their own key. There
is no configuration reset; the configuration is validated whenever it is
saved.

## Configure service extraction

Set `KEI_EXTRACT_MODEL` in `.env` to the Hugging Face repo id the included
extraction vLLM server loads. The GPU overlay also hands Studio that server and
the NuExtract server as deployment connections (`FREE_DEPLOYMENT_INSTRUCT_URL`,
`FREE_DEPLOYMENT_INSTRUCT_MODEL`, `FREE_DEPLOYMENT_NUEXTRACT_URL`), so Schema
Suggestion and Interaction work before any route is saved. Startup never saves
Model Connections or Capability Routes.

`KEI_OCR_MODEL` (default `surya`) is the OCR model a parse uses when its owner
chose none; the Parsing Service's listing and its conversions read the same
value.

Article and Catalog extraction, discovery, and grounding run in the included
Python service. The former Catalog policy editor and `FREE_CATALOG_POLICY`
configuration no longer apply. See the
[service contract](../../prototypes/parsing_service/README.md) for supported
options and limitations.

## Network exposure and proxy trust

The resolved production topology is:

| Service | Private reachability | Host-published port |
| --- | --- | --- |
| host nginx (not a container) | n/a | 443 (TLS, host-managed) |
| Studio | `proxy` and `app`, port 5173 | TCP 127.0.0.1:5173 (for host nginx) |
| PostgreSQL | `app`, port 5432 | none |
| Parsing Service API | `app`, port 8001 | none |
| Parsing worker (DBOS) | `app`; no HTTP listener | none |
| Surya vLLM server (GPU overlay) | `app`, port 8000 | none |
| NuExtract vLLM server (GPU overlay) | `app`, port 8000 | none |
| Extraction vLLM server (GPU overlay) | `app`, port 8000 | none |

Studio reaches the API at `http://parsing_service:8001`. The worker reads
Studio's staged source PDFs from the `source-inbox` volume (read-only) and
writes runs; the API only reads runs and has no database access. The internal
API is private to the Compose network; researchers reach document processing
through FREE's authenticated, ownership-scoped routes. Do not publish the
service API or the model-server ports to the LAN.

Studio is the only member of the dedicated `172.30.0.0/24` `proxy` network in
production, and its `gw_priority` makes host port forwarding enter through
that network, so every connection the host nginx makes to `127.0.0.1:5173`
reaches Studio from the network's bridge gateway. Compose fixes
`FREE_STUDIO_PROXY=trusted-proxy` and `FREE_STUDIO_PROXY_ADDRESS=172.30.0.1`
(that gateway): Studio accepts a request only from that single peer address.
The databases, Parsing Service, and model servers sit on `app` with their
own non-gateway addresses and are rejected. (Development differs only here: the nginx
container joins `proxy` and the trusted peer set is that network's block.)
Nginx discards any inbound `X-Real-IP`, writes exactly one value from the
direct client socket, and proxies to Studio. Browser session cookies are never
forwarded to the Parsing Service. Production publishes neither database nor the Parsing Service. Development
publishes only the explicitly configured loopback tooling ports.

### Studio trust modes

The production Node host makes its network boundary explicit with
`FREE_STUDIO_PROXY`:

| Mode | Intended topology | Binding and client address |
| --- | --- | --- |
| `trusted-proxy` | Hosted HTTPS behind the proxy network's reverse proxy | Binds `0.0.0.0`; accepts `X-Real-IP` only after the socket peer matches `FREE_STUDIO_PROXY_ADDRESS` (one IP, or membership in one IPv4 CIDR block) |
| `loopback` | Node host run directly on the local machine | Binds `127.0.0.1`; uses the socket peer and ignores client-address headers |

Loopback mode requires a localhost, `127.0.0.1`, or `[::1]` `STUDIO_ORIGIN`
and requires `FREE_STUDIO_PROXY_ADDRESS` to be absent. Containers use the
verified `trusted-proxy` contract; there is no mode that binds every interface
while accepting an arbitrary socket peer.

### Hosted proxy contract

Studio does not inspect or depend on the proxy implementation. Any reverse
proxy can use the hosted contract:

```dotenv
FREE_STUDIO_PROXY=trusted-proxy
FREE_STUDIO_PROXY_ADDRESS=<canonical IP address, or IPv4 CIDR block, seen by Studio on the socket>
```

The proxy must replace, not append to, `X-Real-IP` with the address of its
direct client, preserve the `STUDIO_BASE_PATH` prefix when proxying, and keep
the upstream private. The shipped
[`docker/nginx/free-studio-locations.inc.template`](../../docker/nginx/free-studio-locations.inc.template)
is that contract — rendered with `STUDIO_BASE_PATH` and the environment's
upstream by the nginx image's `envsubst` entrypoint in development and by
`node scripts/free.mjs production` for the host nginx: the same file in every
topology. `STUDIO_ORIGIN` remains the origin only; `STUDIO_BASE_PATH` owns the
path, so the same Studio image can run under any configured prefix without
proxy-specific URL rewriting.

Nginx adds `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a
no-referrer policy to every response. The deployment intentionally does not
send HSTS: a private hostname depends on institution- or VPN-managed trust and
certificate renewal, and pinning HTTPS in browsers could prevent operator
recovery after that private trust configuration changes. HTTPS remains the only
published transport.

## Durable execution (DBOS)

Studio and the Parsing Service run their work as DBOS workflows in database `free`:

| Schema | Owner | Holds |
| --- | --- | --- |
| `public` | Studio | Research state and each account's model configuration (no keys) |
| `dbos` | Studio | Studio's workflows; queues `studio`, `suggest` and `gc`; the `collectGarbage` schedule |
| `kei_dbos` | role `kei` | The Parsing Service's workflows; lanes `kei-convert-large`, `kei-convert-small`, `kei-extract`, `kei-gc` |

The `kei` role is denied on `public` and `dbos`. One worker serves the one
slot; never scale `parsing_worker`.

Inspect both schemas from the database container (read-only queries):

```bash
docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c \
  "SELECT workflow_uuid, name, status, queue_name, to_timestamp(updated_at / 1000.0) AS updated FROM dbos.workflow_status ORDER BY created_at DESC LIMIT 20"
docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c \
  "SELECT workflow_uuid, name, status, queue_name, to_timestamp(updated_at / 1000.0) AS updated FROM kei_dbos.workflow_status ORDER BY created_at DESC LIMIT 20"
docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c \
  "SELECT 'dbos' AS schema, status, count(*) FROM dbos.workflow_status GROUP BY 2 UNION ALL SELECT 'kei_dbos', status, count(*) FROM kei_dbos.workflow_status GROUP BY 2"
docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c "SELECT * FROM dbos.workflow_schedules"
```

Add `-f compose.nginx.yaml` and `-f compose.gpu.yaml` when the deployment uses
them.

- **Cancelling.** A cancel stops a workflow at its next step boundary; a step
  already running finishes first. The Parsing Service's steps also check for a
  cancel between pages and records. That check fails open: if the worker cannot
  read a workflow's status (a PostgreSQL restart), it carries on and logs `the
  status of … could not be read` once per step execution, and reads again at
  its next check.
- **Garbage collection** runs every ten minutes on queue `gc`. It cancels work
  whose outcome is already recorded or whose Project Context is gone; deletes
  interactive history 24 hours and background history 30 days after it ends,
  and a deleted scope's history at once; asks the Parsing Service to delete
  runs nothing references (after 24 hours) with their history; and removes
  staged PDFs of finished attempts and unreferenced canonical packages after
  24 hours. Work cancelled in the running process is kept until that process
  restarts, because one of its steps may still write; every deploy restarts
  both. Run a sweep now with `docker compose … exec -T studio pnpm --filter
  studio gc:now`, which prints a JSON summary; a non-empty `failedPhases` also
  appears in Studio's log as `collectGarbage: <phase> failed (<error class>)`,
  and the next sweep retries it.
- **Changing a workflow.** A code change that adds, removes, reorders or
  renames a step of a workflow ships behind a patch — `DBOS.patch('<name>')` in
  Studio, `DBOS.patch("<name>")` in the Parsing Service (both enable patching)
  — so workflows started before it recover on the old path. Remove the branch
  with `deprecatePatch` / `deprecate_patch` once no workflow from before the
  patch can still be recovered. The application versions `studio@1` and
  `kei@1` stay fixed; change one only for an incompatible contract change,
  and only after draining: stop new work, wait until neither schema has an
  `ENQUEUED`, `DELAYED` or `PENDING` workflow, then deploy.

## Back up and restore

Stop `studio` and `parsing_worker` first, so nothing writes while the backup
runs. The backup set is:

- `pg_dump -Fc free` (all three schemas; it includes workflow history —
  interactive results for up to about a day, background inputs for up to about
  30 days);
- the `source-inbox`, `parsing-runs` and `studio-data` volumes;
- the CLI homes: `studio-config` (the Codex login under `codex/`) and
  `studio-claude`;
- outside Compose: `.env` and the secret files it names.

No backup holds a researcher's key: keys live only in researchers' browsers
and in Studio's memory. The CLI homes hold the operator's own CLI logins, so
protect those backups like `.env`. The model caches are re-downloadable and
need no backup. To restore, recreate `free` from the dump into an empty
PostgreSQL volume, restore the volumes, and start normally: migrations are
already applied, and the entrypoint sets the `kei` role's password from
`.env` again.

## Cutover to durable execution (one-time, clean slate)

This runbook moves a deployment from Procrastinate to DBOS once, before FREE
holds production data. Nothing on the host survives it: researchers re-enter
their connections and keys and re-upload their PDFs. It is the one exception
to "production is never reset" (README #10).

1. Build the new images while the old stack serves: `docker compose <files> build`.
2. Stop `nginx` (with the bundled nginx), `studio`, `parsing_service` and
   `parsing_worker`, then the old `parsing_migrate` container. The old worker
   locked `.slot-<slot>.lock` and the new one locks `.worker-<slot>.lock`, so the
   two would not exclude each other: confirm no `kei-jobs` process is left
   (`docker ps --format '{{.Names}} {{.Command}}'`).
3. Take one `pg_dump -Fc` of `free` and of the old `parsing_db` for inspection;
   there is no restore path.
4. Reset the storage: remove the `parsing_db` container and its
   `parsing-postgres` volume; drop and recreate database `free`; empty
   `parsing-runs` and Studio's data directory in `studio-data`
   (`FREE Studio-nodejs`); delete `FREE Studio-nodejs/model-config.json` from
   `studio-config`, keeping `codex/`; keep `studio-claude`.
5. In `.env`, add `FREE_KEI_POSTGRES_PASSWORD` (`openssl rand -hex 32`), set
   `FREE_DEPLOYMENT_CLI_PROVIDERS` if wanted, and remove
   `FREE_PARSING_POSTGRES_PASSWORD`.
6. Start: `node scripts/free.mjs production`. The baseline migration, the
   `kei` role and schema, and both DBOS schemas are created at startup.
7. Check: the health route; `\dn` lists `public`, `dbos` and `kei_dbos`;
   `SET ROLE kei; SELECT 1 FROM public."ProjectContext"` is denied;
   `dbos.workflow_schedules` has `collectGarbage`; the worker logged
   `serving`.
8. Smoke-test: upload; an extraction and a cancel; a Batch Schema Suggestion;
   a generation and a schema edit proposal across a reload and a Studio
   restart; a second account, where one exists, sees none of the first's
   configuration or operations; delete a project and run `gc:now`.

Never restart a model server as part of this: if `docker compose config --hash
'*'` shows a model server's hash changed, stop and decide first.

## Replace a certificate

TLS certificates belong to the host nginx, so renewal is the host's normal
procedure: validate the renewed certificate and key with the same OpenSSL
checks above, install them at the paths the host server block names, then:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent --show-error https://free.example.edu/free/api/healthz
```

If validation fails, restore the previous files and do not reload. No FREE
container is involved in certificate rotation.
