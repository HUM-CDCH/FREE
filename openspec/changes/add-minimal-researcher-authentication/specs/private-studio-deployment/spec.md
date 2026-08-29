## Purpose

Define the production hosting and bootstrap boundary for a private multi-researcher FREE deployment.

## ADDED Requirements

### Requirement: Hosted Studio uses one production Node application

The hosted Studio deployment SHALL run the built Node server rather than the Vite development server. One Hono application SHALL own API dispatch, authentication middleware, static client assets, and authenticated SPA navigation in both production and Vite-backed development. The hosted deployment SHALL run exactly one Studio application process.

#### Scenario: Hosted Studio starts

- **WHEN** the Studio container starts with valid production configuration
- **THEN** it runs the built Node server and serves the built client through the shared Hono application
- **AND** it does not start Vite or expose the development LLM inspector

#### Scenario: Required server configuration is invalid

- **WHEN** `STUDIO_ORIGIN`, the canonical-base64 `FREE_SESSION_SECRET` decoding to at least 32 bytes, or the hosted proxy contract is missing or invalid
- **THEN** Studio fails before accepting requests

### Requirement: Caddy is the only host-facing service

The production Compose topology SHALL publish only Caddy to the host. Caddy SHALL terminate HTTPS with the operator-supplied certificate and key and SHALL proxy to Studio over a dedicated network containing only Caddy and Studio. Studio, PostgreSQL, and Parsing Service SHALL publish no host ports, and PostgreSQL and Parsing Service SHALL NOT join the proxy network. The deployment SHALL provide no public ACME, internal-CA, self-signed, or plain-HTTP fallback.

#### Scenario: Deployment ports are inspected

- **WHEN** the production Compose configuration is resolved
- **THEN** only Caddy publishes a host port
- **AND** Studio, PostgreSQL, and Parsing Service are reachable only on their required private networks

#### Scenario: TLS material is unavailable

- **WHEN** the supplied certificate or private key cannot be loaded
- **THEN** the gateway does not expose an unauthenticated or plain-HTTP Studio fallback

### Requirement: Caddy supplies a trustworthy client address

Caddy SHALL discard an inbound `X-Real-IP` header and set it from the direct client socket before proxying. Hosted Studio SHALL derive the login-limiter client address only from that header on the dedicated Caddy–Studio network. Loopback development MAY use the direct socket address and SHALL NOT trust a browser-supplied forwarding header.

#### Scenario: Client spoofs the forwarding header

- **WHEN** a client sends its own `X-Real-IP` value through Caddy
- **THEN** Caddy replaces it with the direct client address before Studio applies login throttling

#### Scenario: Hosted request bypasses the proxy contract

- **WHEN** hosted Studio receives a request without the Caddy-supplied client-address contract
- **THEN** Studio refuses to use a caller-supplied forwarding value for throttling

### Requirement: A hosted deployment starts from an empty authored baseline

Hosted startup SHALL replay authored database migrations against an empty deployment database and SHALL NOT run `db:update`, seed an account, or migrate existing Project Context data. The first Researcher Account SHALL be created explicitly with the account CLI after migrations complete.

#### Scenario: Fresh deployment is initialized

- **WHEN** the operator starts FREE with new database and artifact volumes
- **THEN** authored migrations produce the final schema with zero Researcher Accounts and zero Project Contexts
- **AND** no default credential or account is created

#### Scenario: Operator retains an old deployment

- **WHEN** existing data must be preserved
- **THEN** the operator backs up and keeps the old volumes rather than pointing the new baseline at them
