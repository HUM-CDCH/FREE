# FREE

Document Extraction & Evaluation — shared team repo.

## Dev Container

Open the repository in a Dev Container to get Python 3.13, Node.js 24, pnpm
10.9, `uv`, and PostgreSQL 17. Dependencies are installed automatically when
the container is first created. Replay the authored database migrations, create
the first Researcher Account explicitly, and then start the application:

```bash
pnpm --filter db db:init
pnpm account create researcher@example.edu
pnpm start
```

The account command reads a temporary password from a hidden prompt; it never
accepts the password as an argument. No migration or seed creates a default
account. The first login is limited to choosing a new password, after which the
researcher logs in again normally.

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
ignored by Git. Keep `.env` and `.certs/studio.key` private and retain them while
the corresponding Podman volumes exist.

Run these commands from the repository root in PowerShell. Git for Windows
provides the OpenSSL executable used here:

```powershell
$openssl = 'C:\Program Files\Git\usr\bin\openssl.exe'
New-Item -ItemType Directory -Force .certs | Out-Null

& $openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes `
  -keyout .certs/studio.key -out .certs/studio.crt `
  -subj '/CN=localhost' `
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1'

$sessionBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($sessionBytes)
$passwordBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
$sessionSecret = [Convert]::ToBase64String($sessionBytes)
$postgresPassword = [Convert]::ToHexString($passwordBytes).ToLowerInvariant()
$certificatePath = (Resolve-Path .certs/studio.crt).Path.Replace('\', '/')
$privateKeyPath = (Resolve-Path .certs/studio.key).Path.Replace('\', '/')

@"
COMPOSE_PROJECT_NAME=free-local
STUDIO_ORIGIN=https://localhost
FREE_SESSION_SECRET=$sessionSecret
FREE_POSTGRES_PASSWORD=$postgresPassword
FREE_TLS_CERTIFICATE_PATH=$certificatePath
FREE_TLS_PRIVATE_KEY_PATH=$privateKeyPath
"@ | Set-Content -Encoding utf8NoBOM .env
```

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

A clean database has no Researcher Accounts. Create one interactively after
Studio is healthy; passwords contain 6 through 128 Unicode scalar values:

```powershell
podman exec -it free-local-studio-1 pnpm --filter studio account create researcher@example.edu
```

Open `https://localhost`, sign in with the temporary password, choose a new
password when prompted, and sign in again. To stop the stack without deleting
its volumes, run:

```powershell
podman compose -f compose.yaml -f compose.local.yaml down
```
## Private HTTPS Docker deployment

The root `compose.yaml` is the production topology for one private LAN or VPN
deployment. It builds the production Studio client and Node server, runs exactly
one Studio process, and puts Caddy at the only host-facing boundary. Restrict
host TCP port 8443 to the intended private network with the host or perimeter
firewall.

### Prerequisites and hosted settings

The Parsing Service follows Docling's NVIDIA container baseline and requires an
NVIDIA driver plus the NVIDIA container runtime. Compose exposes every GPU to
the container and selects `DOCLING_DEVICE=cuda`. The initial image build carries
the CUDA `nvidia-*` wheel set, and the first start downloads Docling layout and
table models, so both can take several minutes and substantial disk space.
Later builds and starts reuse the named model cache.

Obtain a PEM certificate or full chain and its matching PEM private key from
the institution or VPN that owns the private hostname. Put both files outside
the repository build context. FREE does not request a public ACME certificate,
run an internal CA, generate a self-signed certificate, or expose a plain-HTTP
fallback.

Generate the session secret and database password once and retain both across
restarts:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

Create the ignored root `.env` file with the generated single-line value and
absolute host paths to the supplied TLS files:

```dotenv
STUDIO_ORIGIN=https://free.example.edu:8443
FREE_SESSION_SECRET=<canonical-base64-output>
FREE_POSTGRES_PASSWORD=<hex-output>
FREE_TLS_CERTIFICATE_PATH=/srv/free-tls/studio.crt
FREE_TLS_PRIVATE_KEY_PATH=/srv/free-tls/studio.key
```

- `STUDIO_ORIGIN` is the one externally visible, canonical HTTPS origin served
  on port 8443. Use the certificate's DNS name with `:8443` and no trailing
  slash, path, query, fragment, or credentials.
- `FREE_SESSION_SECRET` must be canonical standard Base64 that decodes to at
  least 32 bytes. Keep it secret and stable; replacing it invalidates every
  browser session.
- `FREE_POSTGRES_PASSWORD` must be the generated hexadecimal value. Compose
  supplies this one value to PostgreSQL and interpolates it into Studio's
  `DATABASE_URL`; restricting it to hexadecimal avoids URI-encoding and
  Compose-interpolation ambiguity. Changing it does not update an existing
  PostgreSQL volume's password, so retain it with that volume.
- The two TLS paths must already be regular, readable files. The private key
  must match the certificate and should be readable only by the operator and
  Docker.
- Compose fixes `FREE_STUDIO_PROXY=trusted-caddy` and
  `FREE_STUDIO_PROXY_ADDRESS=172.30.0.2`. Caddy owns that address on the
  dedicated `172.30.0.0/24` proxy network. Do not change one value without the
  other: hosted Studio rejects every socket peer except that Caddy address
  before it will trust the overwritten `X-FREE-Client-Address` header.

Before starting, inspect the subject alternative names and validity period and
confirm that the certificate and key produce the same public-key digest:

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
`postgres-data`, `parsing-tasks`, `parsing-models`, `studio-data`,
`studio-config`, `caddy-data`, and `caddy-config`. A plain
`docker compose down` retains them and therefore does not perform this clean
cutover.

On every Studio container start, the entrypoint runs only
`pnpm --filter db db:init` to replay authored migrations before starting the
built Node host. It never runs `db:update`, seeds sample data, or creates an
account or credential. A clean start therefore contains zero Researcher
Accounts, zero Project Contexts, and no Model Connections or Capability Routes.

Wait for `caddy` to report healthy, then check the public shallow health route
through the canonical HTTPS origin:

```bash
curl --fail --silent --show-error https://free.example.edu:8443/api/healthz
docker compose exec caddy caddy validate \
  --config /etc/caddy/Caddyfile --adapter caddyfile
```

Do not probe Studio directly: hosted Studio intentionally accepts the Caddy
proxy peer only. Studio's container healthcheck instead opens a local TCP
connection; because the entrypoint starts the Node host only after migrations,
Caddy does not start until that readiness check passes.

### Manage Researcher Accounts

After migrations complete, create the first account from a terminal attached to
the running Studio container:

```bash
docker compose exec studio pnpm --filter studio account create researcher@example.edu
```

The command prompts for and confirms a hidden temporary password. Creation and
reset accept exactly 6 through 128 Unicode scalar values without Unicode
normalization. They can also read the password once from standard input with
`docker compose exec -T`, but the password must never be appended to the command
or exposed in process arguments.

Operators use the same CLI to reset a forgotten password or disable an account:

```bash
docker compose exec studio pnpm --filter studio account reset-password researcher@example.edu
docker compose exec studio pnpm --filter studio account disable researcher@example.edu
```

Create and reset require a mandatory password change and invalidate that
account's existing sessions. Disable also invalidates every session and blocks
future login while leaving the account's Project Contexts and descendants
durable. There is no default account, default password, public registration, or
self-service reset.

Open the exact `STUDIO_ORIGIN`, log in with the temporary password, and choose a
new 6–128-scalar password on the required password-change screen. Research and
model pages remain unavailable until that succeeds. The change invalidates the
temporary session, so log in once more with the new password.

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
| Caddy | `proxy` at `172.30.0.2` | TCP 8443 only |
| Studio | `proxy` and `app`, port 5173 | none |
| PostgreSQL | `app`, port 5432 | none |
| Parsing Service | `app`, port 8055 | none |

Only Caddy and Studio join `proxy`; only Studio, PostgreSQL, and the Parsing
Service join `app`. Caddy cannot reach the database or Parsing Service. It
discards any inbound `X-FREE-Client-Address`, writes exactly one value from the
direct client socket, and proxies to Studio. Studio checks that the socket peer
is the pinned Caddy address before consuming that value. Browser session cookies
are never forwarded to the Parsing Service. Ports 80, 5173, 5432, and 8055 are
not published on the host.

Caddy adds `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and a
no-referrer policy to every response. The deployment intentionally does not
send HSTS: a private hostname depends on institution- or VPN-managed trust and
certificate renewal, and pinning HTTPS in browsers could prevent operator
recovery after that private trust configuration changes. HTTPS remains the only
published transport.

### Replace a certificate

Validate a renewed certificate and key at their staging paths with the same
OpenSSL checks above. Keep the configured host paths unchanged. Because Compose
bind-mounts the two individual files, back them up and overwrite their contents
in place rather than renaming new files over the mounted paths:

```bash
cp /srv/free-tls/studio.crt /srv/free-tls/studio.crt.previous
cp /srv/free-tls/studio.key /srv/free-tls/studio.key.previous
cat /srv/free-tls/renewed-studio.crt > /srv/free-tls/studio.crt
cat /srv/free-tls/renewed-studio.key > /srv/free-tls/studio.key
chmod 600 /srv/free-tls/studio.key
```

Make Caddy load and validate the replacement, force the reload even though the
configuration path is unchanged, and then check the live certificate through
the gateway:

```bash
docker compose exec caddy caddy validate \
  --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose exec caddy caddy reload \
  --config /etc/caddy/Caddyfile --adapter caddyfile --force
curl --fail --silent --show-error https://free.example.edu:8443/api/healthz
```

If validation fails, restore both previous files in place and do not reload.

See [CONTEXT.md](CONTEXT.md) for domain language and [docs/](docs/) for current
decisions and parsing contracts.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how we work together.
