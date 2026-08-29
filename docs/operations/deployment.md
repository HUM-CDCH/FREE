# Private HTTPS Docker deployment

Production runs the same Compose container topology as development, behind the
host-managed nginx that already serves the machine. One command starts it:

```bash
node scripts/free.mjs production
```

It validates `.env` before anything starts, renders the shared nginx
application behavior for the host nginx into `.nginx/free-studio-locations.conf`,
and runs `docker compose -f compose.yaml -f compose.prod.yaml up --build -d
--wait`, returning once every service is healthy — migrations replay in the
Studio entrypoint before Studio's healthcheck can pass. The script needs only
Node.js (the repository standard is 24) and Docker on the host; it has no
package dependencies and installs nothing.

`compose.yaml` builds the production Studio client and Node server;
`compose.prod.yaml` adds only the production deltas: restart policies, required
(never defaulted) secrets, real Entra authentication, and Studio's
`127.0.0.1:5173` loopback publish for the host nginx. TLS terminates in the
host nginx — there is no nginx container in production and this stack never
touches the host nginx configuration outside the one include described below.

## Prerequisites and hosted settings

Install Docker with Docker Compose v2.33.1 or later. The launcher checks this
before starting because the production network selection uses `gw_priority`.

The Parsing Service defaults to `DOCLING_DEVICE=cpu` so the stack stays
portable. A GPU deployment must explicitly provide its NVIDIA runtime/device
configuration and select CUDA; `compose.prod.yaml` carries a commented example.
The initial image build and the first start's Docling layout and table model
download can take several minutes and substantial disk space. Later builds and
starts reuse the named model cache.

TLS is the host nginx's: obtain a PEM certificate or full chain and its
matching PEM private key from the institution or VPN that owns the private
hostname, and configure them in the host server block as usual. FREE does not
request a public ACME certificate, run an internal CA, generate a self-signed
certificate, or expose a plain-HTTP fallback.

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
forwarded headers, security headers, the 60m body limit, and timeouts — is
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

## Start from clean volumes

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
docker compose -f compose.yaml -f compose.prod.yaml config --quiet
docker compose -f compose.yaml -f compose.prod.yaml down --volumes --remove-orphans
node scripts/free.mjs production
docker compose -f compose.yaml -f compose.prod.yaml ps
```

`down --volumes --remove-orphans` permanently removes `postgres-data`,
`parsing-tasks`, `parsing-models`, `studio-data`, and `studio-config`. A plain
`down` retains them and therefore does not perform this clean cutover.

On every Studio container start, the entrypoint runs only
`pnpm --filter db db:init`: authored forward migrations replay before the built
Node host starts. Startup never resets or seeds data. A clean deployment
therefore contains zero Researcher Accounts, zero Project Contexts, and no
Model Connections, Capability Routes, or saved provider credentials.
`pnpm db:reset` must never be run against production.

`node scripts/free.mjs production` returns once every service is healthy; then
check the public shallow health route through the canonical HTTPS origin:

```bash
curl --fail --silent --show-error https://free.example.edu/free/api/healthz
```

Do not probe the Studio container from anywhere but the host nginx path:
hosted Studio intentionally accepts only its pinned proxy peer, which is
exactly how the host nginx's loopback connections arrive. Studio's container
healthcheck instead opens a local TCP connection; because the entrypoint
starts the Node host only after migrations, a healthy container proves the
schema replay succeeded.

## Manage Researcher access

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

## Network exposure and proxy trust

The resolved production topology is:

| Service | Private reachability | Host-published port |
| --- | --- | --- |
| host nginx (not a container) | n/a | 443 (TLS, host-managed) |
| Studio | `proxy` and `app`, port 5173 | TCP 127.0.0.1:5173 (for host nginx) |
| PostgreSQL | `app`, port 5432 | none |
| Parsing Service | `app`, port 8055 | TCP 127.0.0.1:8055 |

Studio is the only member of the dedicated `172.30.0.0/24` `proxy` network in
production, and its `gw_priority` makes host port forwarding enter through
that network, so every connection the host nginx makes to `127.0.0.1:5173`
reaches Studio from the network's bridge gateway. Compose fixes
`FREE_STUDIO_PROXY=trusted-proxy` and `FREE_STUDIO_PROXY_ADDRESS=172.30.0.1`
(that gateway): Studio accepts a request only from that single peer address.
PostgreSQL and the Parsing Service sit on `app` with their own non-gateway
addresses and are rejected. (Development differs only here: the nginx
container joins `proxy` and the trusted peer set is that network's block.)
Nginx discards any inbound `X-Real-IP`, writes exactly one value from the
direct client socket, and proxies to Studio. Browser session cookies are never
forwarded to the Parsing Service. Port 5432 is not published on the host; the
Parsing Service publishes only its loopback port for the operator's own web app
(8000 is already taken on the deployment machine, hence 8055).

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
