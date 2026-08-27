# FREE

Document Extraction & Evaluation — shared team repo.

## Dev Container

Open the repository in a Dev Container to get Python 3.13, Node.js 24, pnpm
10.9, `uv`, and PostgreSQL 17. Dependencies are installed automatically when
the container is first created. Replay the authored database migrations and
start the application:

```bash
pnpm --filter db db:init
pnpm dev
```

Development uses a fixed fake Microsoft Entra identity by default and creates
its local Researcher Account on first sign-in. Set `FREE_ENTRA_REAL=1` only when
testing a real tenant over HTTPS; the tenant, client, certificate path, and
certificate thumbprint variables are then required.

The Studio and Parsing Service ports are forwarded automatically. The database
is stored in a named Docker volume and is available to the workspace through
the preconfigured `DATABASE_URL`.

FREE-managed provider credentials use the Dev Container user's GNOME Keyring.
A Dev Container rebuild creates a fresh operating-system keyring, so enter any
managed credentials again after rebuilding.

## Local HTTPS Podman setup on Windows

The production deployment below expects an institution- or VPN-managed
certificate and an NVIDIA runtime. For a local Windows workstation without
those prerequisites, create a localhost certificate, stable secrets, and a CPU
override before the first start. `.env`, `.certs/`, and `compose.local.yaml` are
ignored by Git. Gitignore is not secret storage: the commands below put the
Entra client private key outside the checkout under `%LOCALAPPDATA%`. Keep that
key, `.env`, and `.certs/studio.key` private and retain them while the
corresponding Podman volumes exist.

Run these commands from the repository root in PowerShell. Git for Windows
provides the OpenSSL executable used here:

```powershell
$openssl = 'C:\Program Files\Git\usr\bin\openssl.exe'
New-Item -ItemType Directory -Force .certs | Out-Null
$entraSecretDirectory = Join-Path $env:LOCALAPPDATA 'FREE\secrets'
New-Item -ItemType Directory -Force $entraSecretDirectory | Out-Null
$entraPrivateKeyFile = Join-Path $entraSecretDirectory 'entra-client.pem'

& $openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes `
  -keyout .certs/studio.key -out .certs/studio.crt `
  -subj '/CN=localhost' `
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1'
& $openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes `
  -keyout $entraPrivateKeyFile -out .certs/entra-client.crt `
  -subj '/CN=FREE local Entra client'
& $openssl x509 -in .certs/entra-client.crt -noout -fingerprint -sha256

$entraTenantId = Read-Host 'Microsoft Entra tenant UUID'
$entraClientId = Read-Host 'Microsoft Entra application client UUID'
$entraThumbprint = Read-Host 'Displayed SHA-256 certificate thumbprint'

$sessionBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($sessionBytes)
$passwordBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
$sessionSecret = [Convert]::ToBase64String($sessionBytes)
$postgresPassword = [Convert]::ToHexString($passwordBytes).ToLowerInvariant()
$certificatePath = (Resolve-Path .certs/studio.crt).Path.Replace('\', '/')
$privateKeyPath = (Resolve-Path .certs/studio.key).Path.Replace('\', '/')
$entraPrivateKeyPath = (Resolve-Path $entraPrivateKeyFile).Path.Replace('\', '/')

@"
COMPOSE_PROJECT_NAME=free-local
STUDIO_ORIGIN=https://localhost
STUDIO_BASE_PATH=/
FREE_SESSION_SECRET=$sessionSecret
FREE_POSTGRES_PASSWORD=$postgresPassword
FREE_ENTRA_TENANT_ID=$entraTenantId
FREE_ENTRA_CLIENT_ID=$entraClientId
FREE_ENTRA_CLIENT_CERT_PATH=$entraPrivateKeyPath
FREE_ENTRA_CLIENT_CERT_THUMBPRINT=$entraThumbprint
FREE_TLS_CERTIFICATE_PATH=$certificatePath
FREE_TLS_PRIVATE_KEY_PATH=$privateKeyPath
"@ | Set-Content -Encoding utf8NoBOM .env
```

Upload `.certs/entra-client.crt` to the Entra application registration and
register `https://localhost/auth/callback` plus
`https://localhost/auth/signed-out` before starting this root-path setup. See
the [Entra authentication runbook](docs/operations/entra-authentication.md).

On a machine without an NVIDIA runtime, create `compose.local.yaml`:

```yaml
services:
  parsing_service:
    runtime: crun
    environment:
      DOCLING_DEVICE: cpu
      NVIDIA_VISIBLE_DEVICES: ""
```

Validate the generated certificate and key before trusting them:

```powershell
& $openssl x509 -in .certs/studio.crt -noout -checkend 0 `
  -subject -issuer -dates -ext subjectAltName
& $openssl x509 -in .certs/studio.crt -pubkey -noout |
  & $openssl pkey -pubin -outform DER |
  & $openssl sha256
& $openssl pkey -in .certs/studio.key -pubout -outform DER |
  & $openssl sha256
```

The two SHA-256 outputs must match. To avoid a browser warning, trust only this
locally generated certificate for the current Windows account:

```powershell
certutil -user -addstore Root .certs\studio.crt
```

Start and verify the isolated local stack:

```powershell
podman machine start
podman compose -f compose.yaml -f compose.local.yaml config --quiet
podman compose -f compose.yaml -f compose.local.yaml up --build -d
podman compose -f compose.yaml -f compose.local.yaml ps
curl.exe --fail --silent --show-error https://localhost/api/healthz
```

Open `https://localhost` and sign in with a Researcher assigned to the Entra
enterprise application. The first successful callback creates the local
Researcher Account. To stop the stack without deleting its volumes, run:

```powershell
podman compose -f compose.yaml -f compose.local.yaml down
```
## Private HTTPS Docker deployment

The root `compose.yaml` is the production topology for one private LAN or VPN
deployment. It builds the production Studio client and Node server and runs
exactly one Studio process. TLS terminates in the nginx reverse proxy that
already runs on the host machine; it forwards the configured base path to
Studio's loopback-published port. Restrict host TCP port 443 to the intended
private network with the host or perimeter firewall.

### Prerequisites and hosted settings

The Parsing Service follows Docling's NVIDIA container baseline and requires an
NVIDIA driver plus the NVIDIA container runtime. Compose exposes every GPU to
the container and selects `DOCLING_DEVICE=cuda`. The initial image build carries
the CUDA `nvidia-*` wheel set, and the first start downloads Docling layout and
table models, so both can take several minutes and substantial disk space.
Later builds and starts reuse the named model cache.

The host nginx reverse proxy terminates TLS. Obtain a PEM certificate or full
chain and its matching PEM private key from the institution or VPN that owns
the private hostname, and configure nginx with both outside this repository.
FREE does not request a public ACME certificate, run an internal CA, generate
a self-signed certificate, or expose a plain-HTTP fallback.

Generate the session secret and database password once and retain both across
restarts:

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
FREE_ENTRA_TENANT_ID=<microsoft-entra-tenant-uuid>
FREE_ENTRA_CLIENT_ID=<application-client-uuid>
FREE_ENTRA_CLIENT_CERT_PATH=/srv/free-secrets/entra-client.pem
FREE_ENTRA_CLIENT_CERT_THUMBPRINT=<sha256-certificate-thumbprint>
```

- `STUDIO_ORIGIN` is the one externally visible, canonical HTTPS origin served
  on port 443. Use the certificate's DNS name with no trailing slash, path,
  query, fragment, or credentials.
- `STUDIO_BASE_PATH` is `/` for an origin-root deployment or one canonical path
  such as `/free` for a prefixed deployment. Do not add a trailing slash.
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
- Compose fixes `FREE_STUDIO_PROXY=trusted-proxy` and
  `FREE_STUDIO_PROXY_ADDRESS=172.30.0.1`. That address is the bridge gateway of
  the dedicated `172.30.0.0/24` proxy network: nginx on the host reaches the
  container through the published `127.0.0.1:5173` port, and `gw_priority` on
  the studio service's proxy network makes Docker route that published port
  through this network, so every such connection arrives from the gateway.
  Do not change one value without the
  other: hosted Studio rejects every socket peer except the configured proxy
  before it will trust the overwritten `X-Real-IP` header.

Before installing a certificate into nginx, inspect the subject alternative
names and validity period and confirm that the certificate and key produce the
same public-key digest:

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

### Start from clean volumes

> **Destructive cutover:** this authenticated release has one empty-database
> migration baseline. It does not migrate an old database, Project Context,
> artifact, account, or model configuration. Never point it at volumes whose
> data must be retained.

Before checking out the new deployment, quiesce writes and snapshot the old
named volumes with the container platform. From a still-running previous stack,
the following captures the database plus Studio artifacts, model configuration,
and keyring as rollback material:

```bash
umask 077
backup_dir="/srv/free-backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
docker compose exec -T db pg_dump -U postgres -d free -Fc \
  > "$backup_dir/free.pg_dump"
docker compose exec -T studio tar -C /root/.local/share -czf - . \
  > "$backup_dir/studio-data.tgz"
docker compose exec -T studio tar -C /root/.config -czf - . \
  > "$backup_dir/studio-config.tgz"
docker compose down
```

Keep the previous image and all required volume snapshots with those archives.
They support rollback to the previous release only; they are not inputs to the
new baseline. If preservation is required and a verified backup is unavailable,
stop here.

After configuring `.env`, deliberately remove the old Compose volumes and
create the clean deployment:

```bash
docker compose config --quiet
docker compose down --volumes --remove-orphans
docker compose up --build -d
docker compose ps
```

`docker compose down --volumes --remove-orphans` permanently removes
`postgres-data`, `parsing-tasks`, `parsing-models`, `studio-data`, and
`studio-config`. A plain `docker compose down` retains them and therefore does
not perform this clean cutover.

On every Studio container start, the entrypoint runs only
`pnpm --filter db db:init` to replay authored migrations before starting the
built Node host. It never runs `db:update`, seeds sample data, or creates an
account or credential. A clean start therefore contains zero Researcher
Accounts, zero Project Contexts, and no Model Connections or Capability Routes.

Wait for `studio` to report healthy, then check the public shallow health route
through the canonical HTTPS origin:

```bash
curl --fail --silent --show-error https://free.example.edu/free/api/healthz
```

Do not probe the container port directly: hosted Studio intentionally accepts
only the pinned bridge-gateway proxy peer, which is exactly the path host nginx
takes through the published loopback port. Studio's container healthcheck
instead opens a local TCP connection; because the entrypoint starts the Node
host only after migrations, a healthy container proves the schema replay
succeeded.

### Manage Researcher access

Assign or remove Researchers on the Microsoft Entra enterprise application.
FREE requests only `openid` and `profile`; it does not use Graph, groups, app
roles, refresh tokens, or a local disable list. A successful sign-in creates or
refreshes the local account keyed by the tenant and object claims.

FREE sessions are fixed and expire one minute before the Entra ID token. On
expiry the browser captures only the supported in-progress extraction, schema,
and batch drafts in same-tab storage, signs in again through Entra, and restores
them only for the same account and resource. Arbitrary component-local text can
be lost. Removing an Entra assignment takes effect at the next sign-in, normally
within about an hour; rotating `FREE_SESSION_SECRET` is the only immediate
global forced logout and signs out everyone.

See [the Entra authentication runbook](docs/operations/entra-authentication.md)
for registration, certificate rotation, guarded cutover, and smoke checks.

### Configure shared models

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

### Network exposure and proxy trust

The resolved production topology is:

| Service | Private reachability | Host-published port |
| --- | --- | --- |
| Host nginx | host network | TCP 443 (TLS) |
| Studio | `proxy` and `app`, port 5173 | TCP 127.0.0.1:5173 |
| PostgreSQL | `app`, port 5432 | none |
| Parsing Service | `app`, port 8055 | TCP 127.0.0.1:8055 |

Only Studio joins the dedicated `172.30.0.0/24` `proxy` network; only Studio,
PostgreSQL, and the Parsing Service join `app`. Host nginx reaches Studio
exclusively through the published loopback port, so every such connection
arrives at Studio from the proxy network's bridge gateway (`172.30.0.1`), the
peer Compose pins. Nginx discards any inbound `X-Real-IP`, writes
exactly one value from the direct client socket, and proxies to Studio. Studio
checks that the socket peer is its configured trusted proxy before consuming
that value. Browser session cookies are never forwarded to the Parsing Service.
Port 5432 is not published on the host; the Parsing Service publishes only its
loopback port for the operator's own web app (8000 is already taken on the
deployment machine, hence 8055).

#### Studio trust modes

The production Node host makes its network boundary explicit with
`FREE_STUDIO_PROXY`:

| Mode | Intended topology | Binding and client address |
| --- | --- | --- |
| `trusted-proxy` | Hosted HTTPS behind one pinned reverse-proxy peer | Binds `0.0.0.0`; accepts `X-Real-IP` only after the socket peer matches `FREE_STUDIO_PROXY_ADDRESS` |
| `loopback` | Node host run directly on the local machine | Binds `127.0.0.1`; uses the socket peer and ignores client-address headers |

Loopback mode requires a localhost, `127.0.0.1`, or `[::1]` `STUDIO_ORIGIN`
and requires `FREE_STUDIO_PROXY_ADDRESS` to be absent. Containers use the
verified `trusted-proxy` contract; there is no mode that binds every interface
while accepting an arbitrary socket peer.

#### Hosted proxy contract

Studio does not inspect or depend on the proxy implementation. Any reverse
proxy can use the hosted contract:

```dotenv
FREE_STUDIO_PROXY=trusted-proxy
FREE_STUDIO_PROXY_ADDRESS=<canonical IP address seen by Studio on the socket>
```

The configured address must be the proxy's direct socket address as observed by
Studio. When both processes run on the host and nginx connects over IPv4
loopback, that value is `127.0.0.1`. When Studio runs in a container and nginx
runs on the host — the shipped `compose.yaml` topology — it is the container
bridge gateway; Compose pins `172.30.0.1` on the dedicated proxy network.

The proxy must replace, not append to, `X-Real-IP` with the address
of its direct client. Set `STUDIO_BASE_PATH=/free`, preserve that prefix when
proxying, and use these host nginx locations:

```nginx
location = /free {
    return 308 /free/;
}

location ^~ /free/ {
    proxy_pass http://127.0.0.1:5173;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    add_header X-Frame-Options "DENY";
    add_header X-Content-Type-Options "nosniff";
    add_header Referrer-Policy "no-referrer";
}
```

The absence of a trailing slash on `proxy_pass` is intentional: Nginx must send
the original `/free/...` path to Studio. Keep the upstream private.
`STUDIO_ORIGIN` remains the origin only; `STUDIO_BASE_PATH` owns the path. The
same Studio image can run at `/`, `/free`, or another configured prefix without
proxy-specific URL rewriting.

Nginx adds `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a
no-referrer policy to every response. The deployment intentionally does not
send HSTS: a private hostname depends on institution- or VPN-managed trust and
certificate renewal, and pinning HTTPS in browsers could prevent operator
recovery after that private trust configuration changes. HTTPS remains the only
published transport.

### Replace a certificate

Validate a renewed certificate and key at their staging paths with the same
OpenSSL checks above. Keep the configured host paths unchanged. Because nginx
reads the two individual files, back them up and overwrite their contents in
place rather than renaming new files over the configured paths:

```bash
cp /srv/free-tls/studio.crt /srv/free-tls/studio.crt.previous
cp /srv/free-tls/studio.key /srv/free-tls/studio.key.previous
cat /srv/free-tls/renewed-studio.crt > /srv/free-tls/studio.crt
cat /srv/free-tls/renewed-studio.key > /srv/free-tls/studio.key
chmod 600 /srv/free-tls/studio.key
```

Make nginx load and validate the replacement, reload it, and then check the
live certificate through the gateway:

```bash
nginx -t && systemctl reload nginx
curl --fail --silent --show-error https://free.example.edu/free/api/healthz
```

If validation fails, restore both previous files in place and do not reload.

See [CONTEXT.md](CONTEXT.md) for domain language and [docs/](docs/) for current
decisions and parsing contracts.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how we work together.
