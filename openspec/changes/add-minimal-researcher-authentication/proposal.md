## Why

FREE currently assumes one trusted researcher on one machine: Studio has no login boundary, every Project Context is globally visible, and knowing a resource identifier is sufficient to reach project-owned data. A small known group needs a minimal private deployment in which each Humanities Researcher authenticates locally and can access only their own Project Contexts.

## What Changes

- Add local email-and-password Researcher Accounts managed through deployment CLI commands, with forced temporary-password changes, disablement, and password reset.
- Add signed, bounded browser sessions and a login gate around Studio; only the login surface, static assets, and shallow Studio health check remain unauthenticated.
- **BREAKING** Replace the unused `User` schema and global Project Context access with required direct ownership from each Project Context to one Researcher Account.
- Enforce ownership in server-side data access for Project Contexts and every descendant resource, including source representations, schemas, extractions, batches, reviews, and artifacts.
- Keep Model Connections and Capability Routes deployment-wide and editable by every authenticated researcher while requiring authentication for their configuration and probe endpoints.
- **BREAKING** Replace the Vite development middleware used as the hosted application server with a single production Node server behind Caddy and rebuild the database from a clean authenticated baseline; existing local data is intentionally not migrated.
- Keep the Parsing Service internal and system-to-system; browser session authentication terminates at Studio rather than being propagated to Parsing Service task endpoints.

## Capabilities

### New Capabilities

- `researcher-authentication`: Local account provisioning, password login/change/reset, signed browser sessions, logout, disablement, and the deny-by-default Studio authentication boundary.
- `researcher-project-ownership`: Direct Researcher Account ownership of Project Contexts and transitive server-side authorization of all project-owned data and operations.

### Modified Capabilities

- `model-connection-configuration`: Require authentication for shared connection, route, credential-state, and probe operations; define serialized whole-document writes for multiple authenticated researchers.

## Impact

- Studio gains a production Node host, authentication middleware and endpoints, login/password UI, account CLI, owner-aware API dispatch, and authenticated shared model configuration.
- `packages/db` replaces the unused `User` model, adds required Project Context ownership, removes unscoped ProjectStore entry points, and emits a clean migration baseline and owner-aware fixtures.
- Studio's Docker image and Compose topology add the production server and Caddy gateway, consume institution/VPN-provided trusted certificates, and expose only the gateway on the host network.
- New direct runtime dependencies are expected for the Hono Node host; password hashing and cookie signing use Node built-ins.
- Work overlaps active changes touching ProjectStore, schema/extraction lifecycles, evidence/reopen flows, and Studio navigation; implementation must rebase those call sites onto authenticated ownership rather than retain unscoped compatibility paths.
