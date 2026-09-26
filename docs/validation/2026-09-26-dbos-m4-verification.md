# DBOS M4 verification — 2026-09-26

**Scope.** `feat/dbos-m2-m6` through `735e917` (Tasks 11–14 and integrated-review repairs). This record concerns M4 only. The [M4 acceptance traceability table](../plans/2026-09-26-dbos-m4-studio-background.md#traceability-m4-acceptance--tests) maps each binding-spec item to its test. No deployment or Spark run was performed.

## Automated gates

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Passed after `735e917`. |
| `pnpm lint` | Passed after `735e917`; three existing React hook dependency warnings, no errors. |
| `pnpm test:unit` | Passed after `735e917`: Studio 1,361, DB 60, extraction 68, export 33, scripts 58, config 4, parsing 949. Parsing reported 72 skipped and 66 deselected. |
| `pnpm test:safety` | 18/18 passed after the Compose port parameterization. |
| `pnpm test:postgres` | The original full gate passed on fresh M4 databases: DB 41/41, extraction 55/55, Studio 26/26, parsing 48/48. After `a0314ec`, its DB, extraction and Studio tiers passed 41/41, 55/55 and 26/26 on recreated databases. The parsing tier was run separately with `PARSING_TEST_DATABASE_URL` set to fresh `free_test_m4_parsing` and passed 48/48, with 1,039 deselected. The real DBOS launch test passed 3/3 again after `735e917`. An intervening retry against the already used store database failed its required empty-database assertion; the next combined command reached parsing but lacked that URL. |
| `FREE_PLAYWRIGHT_KEI_EXP_PORT=29752 pnpm --filter studio exec playwright test --workers=4` | 56/56 passed. The alternate fake-kei port avoided another checkout's listener on 29750. The initial full run encountered that collision and a picker timeout; the next run found a narrow-viewport resize race in an accessibility test, which was fixed and passed in isolation before this full green run. |
| `pnpm --filter studio test:e2e:base-path` | 2/2 passed. |
| `pnpm test:service` | Final `735e917` rerun 9/9 passed with the real kei DBOS worker, native Docling/PDFium parsing, and a scripted instruction-model boundary. The cancellation case waits for the released model response and recorded `extract_run` step completion before checking for late publication. A test-only barrier at the native export phase, after Docling parsing, proves that a small conversion and extraction finish while the large lane remains occupied, and that a worker killed inside the native runner recovers. The focused two-case run also passed 2/2. |
| `FREE_TEST_OLLAMA_BASE_URL=http://127.0.0.1:1 FREE_TEST_OLLAMA_MODEL=unreachable pnpm test:system` | Final `735e917` isolated rerun 15/15 passed against a disposable Compose project on ports 41843, 41844 and 45445. The deliberately unreachable Ollama route confirms the exercised extraction uses the scripted external model fixture. Each invocation owns a random project name and a proxy subnet separate from development; authentication, Studio, PostgreSQL, DBOS, parsing, grounding, review, restart and deletion use the built stack. |
| `pnpm --filter studio build` | Passed. |

The black-box system suite used a one-day self-signed local certificate because `mkcert` was absent in this checkout; its harness disables TLS validation for that local test. The initial system attempt stopped before startup for missing `mkcert`, then the certificate-backed run passed. The real-service environment was repaired earlier with `uv sync --locked`, which installed the pinned `dbos==3.1.0` into this worktree's `.venv`; that repair was outside the plan's no-`uv sync` constraint and changed no dependency declaration or lockfile.

## Production-bundle smoke

Rebuilt from production source at `735e917` after the recovery repairs. The following is the sanitized equivalent of the executed shell script; `free-m1-pg` is the disposable PostgreSQL container and `free_test_m4_bundle` is its dedicated test database:

```bash
set -euo pipefail
pg_password=$(docker inspect free-m1-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
export DATABASE_URL="postgresql://postgres:${pg_password}@127.0.0.1:5432/free_test_m4_bundle"
unset pg_password
docker exec free-m1-pg dropdb --if-exists -U postgres free_test_m4_bundle
docker exec free-m1-pg createdb -U postgres free_test_m4_bundle
pnpm --filter db db:init
pnpm --filter studio build
smoke_dir=$(mktemp -d /tmp/free-m4-bundle.XXXXXX)
openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=free-bundle-smoke \
  -keyout "$smoke_dir/key.pem" -out "$smoke_dir/cert.pem" >/dev/null 2>&1
export FREE_ENTRA_CLIENT_CERT_PATH="$smoke_dir/key.pem"
export FREE_ENTRA_CLIENT_CERT_THUMBPRINT=$(openssl x509 -in "$smoke_dir/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)
export FREE_ENTRA_TENANT_ID=11111111-2222-4333-8444-555555555555
export FREE_ENTRA_CLIENT_ID=66666666-7777-4888-9999-aaaaaaaaaaaa
export FREE_SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
export FREE_STUDIO_PROXY=loopback STUDIO_ORIGIN=http://127.0.0.1:41901 STUDIO_BASE_PATH=/ PORT=41901 NODE_ENV=production
export FREE_SOURCE_INBOX="$smoke_dir/inbox" XDG_DATA_HOME="$smoke_dir/xdg" KEI_EXP_URL=http://127.0.0.1:1
mkdir -p "$FREE_SOURCE_INBOX"
node prototypes/studio/dist/server/index.js >"$smoke_dir/server.log" 2>&1 &
studio_pid=$!
until rg -q 'FREE Studio listening' "$smoke_dir/server.log"; do sleep 0.2; done
# Insert the Node client below here as a heredoc, then:
kill -TERM "$studio_pid"
wait "$studio_pid" || test "$?" -eq 143
rm -rf "$smoke_dir"
```

The external-client command between readiness and SIGTERM used this code (Node 24, from the worktree root). Insert it at the marked line, wrapped by `node --input-type=module <<'JS'` and a closing `JS` line:

```js
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
const requireStudio = createRequire(new URL('./prototypes/studio/package.json', import.meta.url))
const { DBOSClient } = requireStudio('@dbos-inc/dbos-sdk')
const { Pool } = requireStudio('pg')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
const client = await DBOSClient.create({ systemDatabaseUrl: process.env.DATABASE_URL,
  systemDatabaseSchemaName: 'dbos', applicationName: 'studio', systemDatabasePoolSize: 2 })
const count = async () => Number((await pool.query(
  'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()')).rows[0].n)
try {
  const idle = await count()
  const handle = await client.enqueue({ queueName: 'studio', workflowName: 'runExtraction',
    workflowID: `bundle-smoke:${randomUUID()}` }, randomUUID())
  const duringAdmission = await count()
  let status
  for (let attempt = 0; attempt < 300; attempt++) {
    status = (await handle.getStatus())?.status
    if (['SUCCESS', 'ERROR', 'CANCELLED'].includes(status)) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  console.log(JSON.stringify({ idle, duringAdmission, workflowStatus: status }))
  if (status !== 'SUCCESS') process.exitCode = 1
} finally { await client.destroy(); await pool.end() }
```

Captured output: the server logged `FREE Studio listening on 127.0.0.1:41901`; the client printed `{"idle":6,"duringAdmission":7,"workflowStatus":"SUCCESS"}`. The server exited after SIGTERM. The exact run's shell, migration and server logs are retained in this worktree's ignored `.superpowers/sdd/2026-09-26-dbos-m4-studio-background/task-14-logs/` directory. The workflow used an absent Extraction ID, so it exercised production DBOS dispatch and no kei handoff.

The same client queried `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()` on the bundle database: **6 connections idle** before enqueue and **7 during admission** immediately after enqueue. These are observed counts with the smoke's measuring client included, not a capacity bound or a full Studio-plus-kei load measurement. M6 should use them as an input to its pool measurement.

## Integrated-review repairs

The first integrated read-only review at `34a16ba` found that recovered workflows could dispatch before Studio exposed its DBOS clients, and that uncertain kei submission in extraction or ingestion could leave a child running. Commit `a0314ec` constructs and exposes the clients before `DBOS.launch()` can dispatch recovered work, then withdraws and closes them if startup fails. It also includes submission in both workflows' cancellation-protected region, preserving the original error if best-effort child cancellation fails. Focused regressions cover dispatch during launch, cleanup after a queue-registration failure, both uncertain submissions, and retention of ingestion's staged source. The real PostgreSQL DBOS launch test passed after the change.

The same commit maps an upload's failed DBOS status read after successful admission to HTTP 503 and retains its staged source. Its focused test passed.

The re-review found a teardown race: a queue claim already in flight could dispatch while failed-startup cleanup withdrew the clients. Commit `735e917` retains the clients until DBOS shutdown drains dispatch, applies the same order to normal shutdown, and waits for teardown before any in-process relaunch. Unit regressions invoke the client reader during both shutdown paths and check serialized relaunch. It also lets an aborted upload request detach without labeling the abort a persistence outage; its staged source remains for the admitted workflow.

The final read-only re-review found no Critical or Important blocker in this repair. A real queue claim paused across failed-startup teardown was not executed; the SDK source and mocked shutdown tests support that ordering. The development HTTP adapter does not propagate a connection-close signal into the upload request, so its disconnect behavior remains outside the abort regression.

## Residue and limits

The M4 residue search found no live `ExtractionJob`, lease worker, suggestion pump, ingestion-key admission or Studio HTTP-kei submission path. Remaining literal names occur in negative contract tests (`ingestionKey`, `retryOfId`, `KEI_EXP_MODEL`) and current batch-member view types, which are not the removed table. Older operations and architecture documents are deferred to M6 by the [task plan](../plans/2026-09-26-dbos-m4-studio-background.md).

The real-service model is scripted, and the system model fixture answers the contract PDF deterministically. These gates do not establish real-model behavior or scanned-book/GPU concurrency; the binding spec reserves those checks for later verification. The bundle smoke exercises startup and DBOS dispatch with a missing domain row, not a complete hosted extraction.
