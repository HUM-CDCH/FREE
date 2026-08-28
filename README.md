# FREE

FREE lets an authenticated humanities researcher turn source documents into
structured, evidence-grounded extraction results and review them.

## Start

```bash
pnpm dev          # local:      Docker Compose + containerized nginx + mock OIDC
pnpm production   # production: Docker Compose behind the host-managed nginx
```

Both run `node scripts/free.mjs <local|production>` over the same base
`compose.yaml`; `compose.override.yaml` (local) and `compose.prod.yaml`
(production) differ only in listen address, TLS material, domain, upstream
address, and identity provider. Local serves https://localhost:8443/free/.

## Product contract

This is the sole behavioral authority for FREE (approved 2026-08-28).

1. **One supported entrypoint.** One user-facing command with an explicit
   `local` or `production` target starts the intended environment. Internal
   scripts and Compose files are implementation detail; there are no competing
   documented startup paths. Local and production share one base Compose
   topology.
2. **Authentication is active.** All research data and operations require an
   authenticated researcher. Static assets, health endpoints, and the OIDC
   login/callback endpoints may be public. Local development uses an isolated
   mock OIDC provider that exercises the real session and authorization path;
   production uses Microsoft Entra, and the local mock cannot be enabled in
   production.
3. **Safe startup ordering.** The database starts, migrations run to
   completion, and only then does the app report healthy/ready — from a fresh
   empty database and from an already-migrated one.
4. **Project creation.** A researcher can create, list, rename, and
   permanently delete a project. Deletion removes all project-owned database
   state and removes filesystem artifacts only when no remaining project
   references them.
5. **Document ingestion.** A researcher can upload a PDF source document into
   a project and see its parsed content.
6. **Extraction workflow.** One canonical schema-guided extraction path:
   define/approve an extraction schema, run extraction over the project's
   documents, with visible progress and completion. Schema suggestions exist
   only to create the schema this path uses.
7. **Evidence grounding.** Every extracted value is presented with source
   evidence locatable in the document; a value without evidence is visibly
   flagged, never silently accepted.
8. **Review.** Accept/reject review decisions on extraction results are
   recorded and stored.
9. **Durability.** Projects, documents, schemas, extraction results, and
   review decisions survive a normal restart (volumes retained).
10. **Proxy parity.** Production keeps its host-managed nginx; local uses
    containerized nginx. Both consume the same version-controlled proxy
    fragment (`docker/nginx/free-studio-locations.inc.template`) for `/free`
    routing, redirects, forwarded headers, auth callback routing, security
    headers, body-size limits, and timeouts.
11. **No committed secrets.** Secrets enter only via environment or the OS
    credential store; the repository holds only `.env.example` placeholders.
12. **Destructive DB safety.** Forward-only migrations may target the
    configured production database. Reset, drop, teardown, and disposable-test
    operations fail unless the target is explicitly local and disposable.

Out of scope: backward compatibility with historical API shapes, multi-path
deployment, speculative extensibility. Historical tests, documentation, and
implementation details have no authority unless they prove one of the
outcomes above.

## Safety boundaries

- Production nginx is host-managed — never containerized. The rendered
  fragment for it comes from the same template local nginx consumes.
- `packages/db` refuses destructive operations against any database that is
  not local and disposably named (see `packages/db/src/database-url.ts`).
- Session cookies are signed; API writes are origin-checked; uploads are
  validated (`application/pdf`, magic bytes, 50 MiB cap).

## Verification

The black-box suite in [`tests/`](tests/) proves the contract — startup and
health, unbypassable authentication, the full researcher workflow
(project → ingest → schema → extraction → evidence → review), persistence
across restart, migration behavior, and destructive-target rejection. Run it
with `pnpm test` against a running local stack.
