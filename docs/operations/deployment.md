# Private HTTPS Docker deployment

Production runs the same Compose container topology as development. One
command starts it:

```bash
node scripts/free.mjs production
```

It validates `.env`, renders the shared nginx application behavior for a host
nginx into `.nginx/free-studio-locations.conf`, and builds the images. Only
after a successful build does it stop Studio and the parsing API/worker
(60-second grace period) and run
`docker compose -f compose.yaml -f compose.prod.yaml up --no-build -d --wait`
with the deployment's overlays (`compose.nginx.yaml`, `compose.gpu.yaml`),
returning once the configured health checks pass. Each built image is labelled
with the last commit of its build context (`org.opencontainers.image.revision`,
suffixed `-dirty` when tracked files there changed), so an unchanged context is
not recreated, and the launcher reports each service's revision as `current` or
`STALE`. It needs an installed workspace (`pnpm install --frozen-lockfile`,
which also runs `uv sync` for the Parsing Service; see the README's
[requirements](../../README.md#requirements)).

`compose.prod.yaml` adds only the production deltas to `compose.yaml`: restart
policies, required (never defaulted) secrets, real Entra authentication, and
Studio's `127.0.0.1:5173` loopback publish for the host nginx. By default TLS
terminates in the host nginx; hosts without one use the
[bundled nginx container](#bundled-nginx-hosts-without-a-managed-nginx). This
stack never touches the host nginx configuration outside the one include
described below.

## Prerequisites and hosted settings

Install Docker with Docker Compose v2.40.0 or later; the launcher checks this
because the production network selection uses `gw_priority`. The Parsing
Service is built from `apps/parsing_service` in this checkout; Compose runs its
read API and DBOS worker, and with GPU access the vLLM model servers for OCR
and extraction, beside Studio and the one PostgreSQL server both use.

The launcher probes Docker GPU access (`FREE_GPU=auto`) and adds
`compose.gpu.yaml` when it succeeds; `FREE_GPU=off` and `FREE_GPU=required`
work as in the [README](../../README.md#run). Scanned PDFs and extraction
require the GPU model servers; without them an operator can point
`KEI_EXTRACT_URL` at another OpenAI-compatible vLLM endpoint. The worker's
document-layout processing runs on CPU so it does not compete with the model
servers for GPU memory.

The first build installs the Python environment (about 6 GiB, plus build
caches and image layers). The first GPU start downloads the Surya OCR weights,
`KEI_NUEXTRACT_MODEL` (default `numind/NuExtract3-FP8`, about 7 GB) and
`KEI_EXTRACT_MODEL` (default `Qwen/Qwen3.8-27B-FP8`, about 31 GB) into the
shared Hugging Face cache, which persists in a named volume. Allow enough disk
space, network access, and startup time for these downloads.

Obtain a PEM certificate (a full chain) and its matching PEM private key from
the institution or VPN that owns the private hostname. FREE does not request a
public ACME certificate, run an internal CA, generate a self-signed
certificate, or expose a plain-HTTP fallback. Before installing a certificate,
inspect the subject alternative names and validity period and confirm that the
certificate and key produce the same public-key digest:

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
  limits; leave it unset to offer neither. Log the CLIs in as the
  [README](../../README.md#models) shows; in production Claude Code's
  `CLAUDE_CODE_OAUTH_TOKEN` goes in `.env`.
- `FREE_CATALOG_METHOD` (optional; `unified`) admits new single and batch
  Catalog Extractions on the unified Catalog method instead of the legacy
  generic and recipe Catalog. Leave it unset until the unified method
  has passed a preregistered held-out evaluation on independent labelled
  documents (boundary, field and evidence quality, partial-item rate).
  Accounts with legacy Catalog preferences must apply the unified settings
  before their next Catalog Extraction; admitted work, including a retried
  Extraction ID, keeps the method it was admitted with. Unsetting it again
  pauses new unified admissions; admitted unified work still runs and reads.
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

`VLLM_IMAGE` selects the image of every model server. The default is the
generic vLLM image; on DGX Spark set it to a native ARM64 image with GB10
support. Validate the selected image and a representative scanned PDF on the
target hardware before serving researchers. GPU visibility alone does not prove
that its CUDA kernels or model architecture work. For extraction's
`Qwen/Qwen3.8-27B-FP8` (the `qwen3_5` architecture), the image must also
support that architecture and FP8 on the target GPU.

`OCR_KV_CACHE_BYTES` (default 4G) sizes the OCR server's KV cache; with a cache
size set, vLLM ignores `OCR_GPU_MEMORY_UTILIZATION`. The context is 24,576
tokens with up to `OCR_MAX_NUM_SEQS` (default 4) simultaneous sequences. The
same value sets the parsing processes' `SURYA_INFERENCE_PARALLEL`, so Surya
sends no more requests at once than the server runs; otherwise a book's queued
requests would sit ahead of a small document's. `EXTRACT_MAX_MODEL_LEN`
(default 32,768 tokens) and `EXTRACT_KV_CACHE_BYTES` (default 8G) size the
extraction server; it loads the text model only. `KEI_NUEXTRACT_MODEL`
(default `numind/NuExtract3-FP8`), `NUEXTRACT_MAX_MODEL_LEN` and
`NUEXTRACT_KV_CACHE_BYTES` (default 4G) do the same for the NuExtract server,
which runs its repository's processor code (`--trust-remote-code`); pin a
reviewed model revision if that matters to the deployment.
`NUEXTRACT_MAX_NUM_SEQS` (default 4) sets how many requests the NuExtract
server runs at once and, as the worker's `KEI_CATALOG_CHUNKS`, how many model
calls a recipe or unified Catalog Extraction makes at once. Its reasoning
calls, unified discovery among them, go to the extraction server, which runs 4
at once, so a larger value queues them there. Keep it at 64 or below: a larger
value stops the worker at boot, and its restart policy then restarts it in a
loop. Leave room
for every server's weights, the document-layout process, and the operating
system; on DGX Spark, system memory is shared with the GPU.

Constrained decoding can loop on whitespace between JSON tokens; the Parsing
Service recovers a generic Catalog record call that does with a bounded
xgrammar grammar ([service contract](../../apps/parsing_service/README.md)).
The worker pins `xgrammar` to the extraction server's version so that grammar
parses there: when you change `VLLM_IMAGE`, check that the image's xgrammar
matches the pin in `apps/parsing_service/pyproject.toml`. Do not enable vLLM's
`--structured-outputs-config '{"disable_any_whitespace": true}'` for the
extraction server: the compact grammar it forces changes the answers, which is
worse than the loop.

For direct Compose commands, add `-f compose.gpu.yaml` after the local or
production overlay. The normal launcher selects it after its GPU probe.

## Configure models

Each researcher configures their own Model Connections and model choices in
Studio (**Configure models**; see the [README](../../README.md#models)).
Startup never saves Model Connections or Capability Routes. The deployment
offers only read-only connections:

- With the GPU overlay, Studio lists the extraction and NuExtract servers as
  deployment connections (`FREE_DEPLOYMENT_INSTRUCT_URL`,
  `FREE_DEPLOYMENT_INSTRUCT_MODEL`, `FREE_DEPLOYMENT_NUEXTRACT_URL`), so Schema
  Suggestion and Interaction work before any route is saved. Set
  `KEI_EXTRACT_MODEL` in `.env` to the Hugging Face repo id the extraction
  server loads.
- `FREE_DEPLOYMENT_CLI_PROVIDERS` adds the CLI providers (above).

`KEI_OCR_MODEL` (default `surya`) is the OCR model a parse uses when its owner
chose none; the Parsing Service's listing and its conversions read the same
value.

Among a researcher's own connections, a vLLM or OpenAI-compatible connection
has no default base URL: enter the URL under which `/models` and
`/chat/completions` sit, keeping any `/v1`. For Ollama, enter the server's base
URL; FREE adds `/api` itself. Connection checks
are advisory: a failed model listing does not block **Apply**, and a model ID
typed by hand is used as is. Only vLLM connections switch the model's thinking
off and can run NuExtract's template protocol. A keyless Ollama connection is
called anonymously even when the operator's environment sets `OLLAMA_API_KEY`.
A stored key is bound to its connection's provider and API base and is never
sent to a changed one.

## OCR result reuse

A parse of PDF bytes the Parsing Service already converted with the same
effective settings reuses the earlier result instead of running OCR again; the
match is on the parse recipe's fingerprint
([service contract](../../apps/parsing_service/README.md)). The OCR server's
image (`VLLM_IMAGE`, default `vllm/vllm-openai:latest`) and its weights
(`datalab-to/surya-ocr-2`) are not pinned, so the recipe cannot see a change to
either.

- **When the OCR server changes**, set a new `KEI_OCR_REVISION` in `.env` (any
  label, such as the date and what changed) and redeploy. This covers pulling a
  newer image, new weights, or different quantization or server flags that
  change what it reads. Without a new label, uploads of PDFs parsed before the
  change keep their earlier OCR. The label is part of the recipe of every parse
  that runs an OCR model, so the first such parse of each PDF after the change
  runs OCR again; a native parse keeps reusing. Earlier results stay readable.
- **Never bump `RESULT_VERSION` to force a re-OCR.** It is the result format:
  the reader refuses results written at another version, so every earlier run
  would lose its result, and extraction over its documents would fail.

## Host nginx (one-time include)

The application-facing proxy behavior — base-path routing and redirects,
forwarded headers, security headers, the 110m body limit, and timeouts — is
version-controlled once in
[`docker/nginx/free-studio-locations.inc.template`](../../docker/nginx/free-studio-locations.inc.template)
and consumed identically by the nginx containers and the host nginx.
`node scripts/free.mjs production` renders it with the deployment's
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

On a host where the operator cannot configure nginx (for example a shared host
without root), set `FREE_NGINX=container`. The launcher then adds
[`compose.nginx.yaml`](../../compose.nginx.yaml): an nginx container renders
the same shared location template and terminates TLS itself, and nothing is
rendered for a host nginx.

```dotenv
FREE_NGINX=container
FREE_NGINX_PORT=8443
FREE_TLS_CERT_PATH=/srv/free-tls/studio.crt
FREE_TLS_KEY_PATH=/srv/free-tls/studio.key
STUDIO_ORIGIN=https://free.example.edu:8443
```

The container publishes `FREE_NGINX_PORT` (default 443) on every interface;
`STUDIO_ORIGIN` must carry the same port, and the Entra redirect URIs follow
from it. The certificate should be a full chain, and the launcher refuses to
start unless both files exist. The bundled nginx has the fixed address
`172.30.0.10` on the `proxy` network, which is Studio's only trusted proxy
peer, and Studio publishes no host port. Restrict the published port with the
perimeter firewall as for the host nginx.

## Replace a certificate

Validate the renewed certificate and key with the OpenSSL checks above. If
validation fails, keep the previous files and do not reload or restart.

With the host nginx, renewal is the host's normal procedure: install the files
at the paths the host server block names, then:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent --show-error https://free.example.edu/free/api/healthz
```

With the bundled nginx, replace the files at `FREE_TLS_CERT_PATH` and
`FREE_TLS_KEY_PATH`, then restart its container (add `-f compose.gpu.yaml` when
the deployment uses it):

```bash
docker compose -f compose.yaml -f compose.prod.yaml -f compose.nginx.yaml restart nginx
curl --fail --silent --show-error https://free.example.edu:8443/free/api/healthz
```

## Start and preserve state

Normal startup builds before it stops the existing Studio and parsing
API/worker, so a failed build leaves the application running. Once they stop,
Compose starts Studio: its entrypoint replays the authored migrations, creates
the Parsing Service's role and schema, and Studio launches DBOS, which migrates
the `dbos` schema and applies its schedules: garbage collection every ten
minutes and durable Extraction reconciliation every minute. The Parsing
Service's worker starts only after Studio is healthy; it takes its slot lock
(`KEI_RUNS/.worker-<slot>.lock`), reads the database clock as its boot
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
only after migrations and the DBOS launch; the Parsing Service API has its own
healthcheck. Extraction quality is checked by integration validation, not by
the health routes. Check the public application through the configured HTTPS
proxy and sign-in path.

A redeploy restarts Studio, which empties its in-memory copy of researchers'
model keys: an open page sends its keys again, and background work that needs
a key no open page resends fails with `model_key_required` until the
researcher retries it.

After the first start, also check the following (run the queries with the
`psql` command in [Durable execution](#durable-execution-dbos)):

- `\dn` includes `public`, `dbos`, `kei_dbos` and `extraction_runtime`;
- `SET ROLE kei; SELECT 1 FROM public."projectContext"` is denied;
- `SELECT * FROM dbos.workflow_schedules` lists `collectGarbage` and
  `reconcileDurableExtractions`;
- the worker logged `kei worker kei-slot-1 serving`;
- a researcher can sign in, upload a PDF, build a schema, start an Extraction
  and stop it, then delete the test project, after which `gc:now` reports no
  failed phase.

## Model-call traces (Phoenix)

Every deployment starts Phoenix from the base `compose.yaml`, and Studio and the
worker export their model-call traces to it (`http://phoenix:6006/v1/traces`).
Nothing depends on the collector: stopping it loses new spans but never stops
inference. Phoenix restarts with Docker and keeps its traces in `phoenix-data`.

Content capture is off by default. To record content, set `FREE_TRACE_CAPTURE`
in `.env` and redeploy: `prompts,responses` records LLM input and raw output,
and `parsed` adds FREE's interpreted output. For a single deployment, the
process environment takes precedence over `.env`
(`FREE_TRACE_CAPTURE=prompts,responses,parsed pnpm production`). Captured
content includes source text and persists in the trace volume; request headers
and model keys are never recorded.

The dashboard is published only on the host's loopback at port 6006, never
through nginx. From your own machine, forward it over SSH and open
http://localhost:6006:

```bash
ssh -N -L 6006:127.0.0.1:6006 <deploy-host>
```

The [local tracing guide](local-development.md#model-call-traces-phoenix)
describes what a trace contains.

## Manage Researcher access

Assign or remove Researchers on the Microsoft Entra enterprise application.
A removal takes effect at the Researcher's next sign-in, up to eight hours
later; rotating `FREE_SESSION_SECRET` signs everyone out at once. The
[Entra authentication runbook](entra-authentication.md) covers registration,
sessions, certificate rotation and smoke checks.

## Network exposure and proxy trust

The resolved production topology is:

| Service | Private reachability | Host-published port |
| --- | --- | --- |
| host nginx (not a container) | n/a | 443 (TLS, host-managed) |
| Studio | `proxy` and `app`, port 5173 | TCP 127.0.0.1:5173 (for host nginx) |
| PostgreSQL | `app`, port 5432 | none |
| Parsing Service API | `app`, port 8001 | none |
| Parsing worker (DBOS) | `app`; no HTTP listener | none |
| Phoenix | `app`, port 6006 | TCP 127.0.0.1:6006 (dashboard, through an SSH tunnel) |
| Surya vLLM server (GPU overlay) | `app`, port 8000 | none |
| NuExtract vLLM server (GPU overlay) | `app`, port 8000 | none |
| Extraction vLLM server (GPU overlay) | `app`, port 8000 | none |

With the bundled nginx, an nginx container on `proxy` (`172.30.0.10`) takes the
host nginx's place and publishes `0.0.0.0:FREE_NGINX_PORT`, and Studio
publishes no port.

Studio reaches the API at `http://parsing_service:8001`. The worker reads
Studio's staged source PDFs from the `source-inbox` volume (read-only) and
writes runs; the API only reads runs and has no database access. The internal
API is private to the Compose network; researchers reach document processing
through FREE's authenticated, ownership-scoped routes. Do not publish the
service API or the model-server ports to the LAN.

With the host nginx, Studio is the only member of the dedicated
`172.30.0.0/24` `proxy` network, and its `gw_priority` makes host port
forwarding enter through that network, so every connection the host nginx
makes to `127.0.0.1:5173` reaches Studio from the network's bridge gateway.
Compose fixes `FREE_STUDIO_PROXY=trusted-proxy` and
`FREE_STUDIO_PROXY_ADDRESS=172.30.0.1` (that gateway): Studio accepts a request
only from that single peer address. With the bundled nginx, the nginx
container is the second `proxy` member and the trusted peer is its address,
`172.30.0.10`. The databases, Parsing Service, and model servers sit on `app`
with their own non-gateway addresses and are rejected. (Development differs
only here: the nginx container joins `proxy` and the trusted peer set is that
network's block.) Nginx discards any inbound `X-Real-IP`, writes exactly one
value from the direct client socket, and proxies to Studio. Browser session
cookies are never forwarded to the Parsing Service. Production publishes
neither database nor the Parsing Service. Development publishes only the
explicitly configured loopback tooling ports.

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
proxy on the host can take nginx's place if it connects to `127.0.0.1:5173`,
replaces (not appends to) `X-Real-IP` with the address of its direct client,
and preserves the `STUDIO_BASE_PATH` prefix. Compose fixes
`FREE_STUDIO_PROXY` and `FREE_STUDIO_PROXY_ADDRESS`, so `.env` cannot change
them; they matter only when the Node host runs outside Compose. The shipped
[`docker/nginx/free-studio-locations.inc.template`](../../docker/nginx/free-studio-locations.inc.template)
is that contract — rendered with `STUDIO_BASE_PATH` and the environment's
upstream by the nginx image's `envsubst` entrypoint in the nginx containers and
by `node scripts/free.mjs production` for the host nginx: the same file in
every topology. `STUDIO_ORIGIN` remains the origin only; `STUDIO_BASE_PATH`
owns the path, so the same Studio image can run under any configured prefix
without proxy-specific URL rewriting.

The template adds `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
and `Referrer-Policy: same-origin` to every response (`no-referrer` would make
browsers send `Origin: null` on the logout form POST, which Studio rejects); a
different proxy must add the same headers. The deployment intentionally does
not send HSTS: a private hostname depends on institution- or VPN-managed trust
and certificate renewal, and pinning HTTPS in browsers could prevent operator
recovery after that private trust configuration changes. HTTPS remains the
only published transport.

## Durable execution (DBOS)

Studio and the Parsing Service run their work as DBOS workflows in database `free`:

| Schema | Owner | Holds |
| --- | --- | --- |
| `public` | Studio | Research state and each account's model configuration (no keys) |
| `dbos` | Studio | Studio's workflows; queues `studio`, `suggest` and `gc`; the schedules `collectGarbage` (queue `gc`) and `reconcileDurableExtractions` (queue `studio`) |
| `kei_dbos` | role `kei` | The Parsing Service's workflows; lanes `kei-convert-large`, `kei-convert-small`, `kei-extract`, `kei-gc` |
| `extraction_runtime` | Studio (migrations); its routines belong to the `NOLOGIN` role `free_extraction_runtime` and run as `SECURITY DEFINER` | Durable Extraction coordination: heads, attempts, call checkpoints and snapshots |

The `kei` role is denied on `public` and `dbos`; in `extraction_runtime` it has
no table access, only `EXECUTE` on an allowlist of routines. One worker serves
the one slot; never scale `parsing_worker`.

Inspect both workflow schemas from the database container (read-only queries):

```bash
docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c \
  "SELECT workflow_uuid, name, status, queue_name, to_timestamp(updated_at / 1000.0) AS updated FROM dbos.workflow_status ORDER BY created_at DESC LIMIT 20"
docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free -c \
  "SELECT workflow_uuid, name, status, queue_name, to_timestamp(updated_at / 1000.0) AS updated FROM kei_dbos.workflow_status ORDER BY created_at DESC LIMIT 20"
```

Add `-f compose.nginx.yaml` and `-f compose.gpu.yaml` when the deployment uses
them.

- **Cancelling.** A DBOS cancel stops a workflow at its next step boundary; a
  step already running finishes first. Conversions check between pages and
  carry on when the status cannot be read. Durable Extraction Pause and Stop
  let reserved model calls finish and save first; a DBOS cancellation alone
  never proves a call has stopped.
- **Garbage collection** runs every ten minutes on queue `gc`. It cancels work
  whose outcome is already recorded or whose Project Context is gone; deletes
  current interactive history 24 hours and background history 30 days after it ends,
  and a deleted scope's history at once; asks the Parsing Service to delete
  runs nothing references (after 24 hours) with their history; and removes
  staged PDFs of finished attempts and unreferenced canonical packages after
  24 hours. Work cancelled in the running process is kept until that process
  restarts, because one of its steps may still write; every deploy restarts
  both. Run a sweep now with `docker compose … exec -T studio pnpm --filter
  studio gc:now`, which prints a JSON summary; a non-empty `failedPhases` also
  appears in Studio's log as `collectGarbage: <phase> failed (<error class>)`,
  and the next sweep retries it.
- **Application versions.** A change to a workflow's steps ships behind a DBOS
  patch, so workflows started before it recover on the old path. The versions
  `studio@1` and `kei@1` change only for an incompatible contract change, and
  only after draining. To drain, close the researcher-facing route on the host
  nginx or stop the bundled `nginx` service, stop any external API callers, and
  leave `studio` and `parsing_worker` running so admitted work finishes; when
  neither schema has an `ENQUEUED`, `DELAYED` or `PENDING` workflow, deploy.

## Back up and restore

Stop `studio` and `parsing_worker` first, so nothing writes while the backup
runs. The backup set is:

- `pg_dump -Fc free`, for example
  `docker compose … exec -T db pg_dump -U postgres -Fc free > free.dump` (all
  four schemas: `public`, `dbos`, `kei_dbos` and `extraction_runtime`; it
  includes workflow history — interactive results for up to about a day,
  background inputs for up to about 30 days);
- the `source-inbox`, `parsing-runs` and `studio-data` volumes;
- the CLI homes: `studio-config` (the Codex login under `codex/`) and
  `studio-claude`;
- outside Compose: `.env` and the secret files it names.

No backup holds a researcher's key: keys live only in researchers' browsers
and in Studio's memory. The CLI homes hold the operator's own CLI logins, so
protect those backups like `.env`. The model caches are re-downloadable and
need no backup.

`pg_dump` does not include the cluster roles that own the dump's objects. To
restore into an empty PostgreSQL volume, start only `db`, create those roles,
then restore the dump:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up -d --wait db
docker compose -f compose.yaml -f compose.prod.yaml exec -T db psql -U postgres -d free \
  -c "CREATE ROLE kei LOGIN" \
  -c "CREATE ROLE free_extraction_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS"
docker compose -f compose.yaml -f compose.prod.yaml exec -T db pg_restore -U postgres -d free < free.dump
```

Then restore the volumes and start normally: migrations are already applied,
and the entrypoint sets the `kei` role's password from `.env` again.

Migrations are forward-only. To upgrade, take the backup set, update the
checkout and run `node scripts/free.mjs production`. On a GPU host,
`docker compose … config --hash '*'` shows beforehand whether a model server's
configuration changed: Compose recreates a container whose hash differs from
its `com.docker.compose.config-hash` label, and a recreated model server loads
its model again. To roll back, stop the application processes, remove the `db`
container and its `postgres-data` volume (`docker compose … rm -sf db`, then
`docker volume rm <project>_postgres-data`; `docker volume ls` lists it),
restore the pre-upgrade backup set as above, check out the previous release and
run the launcher again; anything saved after the backup is lost.
