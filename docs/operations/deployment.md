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
checkout. Compose runs its API, worker, job PostgreSQL, schema initializer,
and, with GPU access, the vLLM model servers for OCR and extraction alongside
Studio and its database. No separate kei-exp repository or host process is
needed.

Both launchers use `FREE_GPU=auto` and probe Docker GPU access. A successful
probe adds `compose.gpu.yaml`, which starts the OCR (Surya) and extraction vLLM
servers. Set `FREE_GPU=off` for CPU native-PDF parsing only, or
`FREE_GPU=required` to fail startup unless the GPU is available. Scanned PDFs
and extraction require the GPU model servers; without them an operator can
point `KEI_EXTRACT_URL` at another OpenAI-compatible vLLM endpoint. The
worker's document-layout processing runs on CPU so it does not compete with
the model servers for GPU memory.

First builds install the Python dependencies. The Python environment alone
is about 6 GiB; build caches and exported image layers require additional
space. First GPU startup downloads the Surya OCR weights and
`KEI_EXTRACT_MODEL` (default `Qwen/Qwen3.8-27B-FP8`, about 30 GB) into the
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
FREE_PARSING_POSTGRES_PASSWORD=<separately-generated-hex-output>
FREE_ENTRA_TENANT_ID=<microsoft-entra-tenant-uuid>
FREE_ENTRA_CLIENT_ID=<application-client-uuid>
FREE_ENTRA_CLIENT_CERT_PATH=/srv/free-secrets/entra-client.pem
FREE_ENTRA_CLIENT_CERT_THUMBPRINT=<sha256-certificate-thumbprint>
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

### GPU and DGX Spark

`FREE_PARSING_POSTGRES_PASSWORD` is the separate job database password. Use a
generated hexadecimal value and retain it with the database volume, just as
for `FREE_POSTGRES_PASSWORD`.

The GPU overlay runs each model in its own vLLM server, separately from the
Python worker. The worker reaches `http://ocr_model:8000/v1/chat/completions`;
extraction reaches `http://extraction_model:8000/v1/chat/completions`. Neither
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

`OCR_GPU_MEMORY_UTILIZATION` and `OCR_KV_CACHE_BYTES` control the OCR
server's memory reservations. The default context is 24,576 tokens with up to
four simultaneous sequences. `EXTRACT_MAX_MODEL_LEN` (default 32,768 tokens)
and `EXTRACT_KV_CACHE_BYTES` (default 8G) size the extraction server; it
loads the text model only. Leave room for both servers' weights, the
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

## Start and preserve state

Normal startup builds before stopping the existing Studio and parsing API/worker,
so a failed build leaves the application running. Once they stop, Compose runs
`kei-jobs schema --apply` against the separate job database before starting
the replacement API and worker. Studio replays its authored migrations before
serving requests. A failed migration prevents startup. The launcher does not
reset either database or seed an
account, Project Context, Model Connection, route, or credential.

```bash
node scripts/free.mjs production
docker compose -f compose.yaml -f compose.prod.yaml ps
curl --fail --silent --show-error https://free.example.edu/free/api/healthz
```

Retain the existing `postgres-data`, `studio-data`, `studio-config`, and
`studio-claude` volumes. The new job database and shared parsing runs must also
survive restarts: completed runs are needed by later extractions, not merely
disposable parsing caches. Back up both databases and their corresponding
artifact volumes together after quiescing writes. A plain `docker compose
down` retains volumes; `down --volumes` destroys them and is not a migration
step.

This source consolidation does not transfer runs from a separately running
kei-exp installation. A Source Document uploaded before the service cutover
may have no run in the new job database; upload it again before requesting a
new extraction. Existing saved results and review history remain in FREE.
Do not delete the separate deployment or its data as part of startup.

Studio's container healthcheck opens a local TCP connection. Its entrypoint
starts the server only after forward migrations finish. The Parsing Service
has its own API healthcheck. Worker execution, completed jobs, and model
quality are checked by integration validation, not the shallow Studio health
route. The public application must be checked through the configured HTTPS
proxy and sign-in path.

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

## Configure shared models

After normal login, use the **Configure providers** gear in the Project Context
rail:

1. Add a Model Connection and set its provider, base URL when applicable, and
   any write-only credential.
2. Review the advisory probe or refresh the model list. Probes use the current
   draft and transient credential but do not save either one.
3. Choose a single model or assign the Extraction and Interaction Capability
   Routes, then select **Apply**. Apply replaces the complete shared document;
   it does not run another provider probe.

Model Connections, Capability Routes, and saved credential state are
deployment-wide, never per-account or per-Project Context. Every fully
authenticated researcher may view, probe, and replace them for everybody.
Coordinate concurrent edits: complete writes are serialized, and the document
whose commit finishes later becomes authoritative without a field-level merge.
Credential values are write-only and are never returned; Studio shows only
`present`, `absent`, or `unavailable` state plus preserve/remove controls.

## Configure service extraction

Set `KEI_EXTRACT_MODEL` in `.env` to the Hugging Face repo id the included
extraction vLLM server loads. This is independent of Studio's stored Model
Connections, which still drive Schema Suggestion and Interaction. For those
capabilities, an OpenAI-compatible Model Connection can use
`http://extraction_model:8000/v1` and the same model. Configuration is explicit; startup does not save
Model Connections or Capability Routes.

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
| Parsing worker and schema initializer | `app`; no HTTP listener | none |
| Parsing PostgreSQL | `app`, port 5432 | none |
| Surya vLLM server (GPU overlay) | `app`, port 8000 | none |
| Extraction vLLM server (GPU overlay) | `app`, port 8000 | none |

Studio reaches the API at `http://parsing_service:8001`. The API and worker
share the job database and run volume. Their unauthenticated administrative
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
