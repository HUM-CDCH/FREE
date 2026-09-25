# DBOS plan review evidence — 2026-09-24–25

Status: **focused probes passed on the sixth-revision pins (M0R 1, 2026-09-25);
runtime migration and M0R 2–5 are pending.**
This record supports the [sixth-revision plan](../2026-09-24-unified-durable-execution.md).
It retains historical experiments against the pre-cutover schema, not a second
runtime or a permanent test suite. Move applicable assertions into integration
tests during implementation; the baseline-change gate replaces the old FK
failure assertion with the required deletion behavior.

## Environment and findings

The review used Node 24.21.0, Prisma Next 0.16.0, PostgreSQL 17, TypeScript
DBOS 5.0.2, `@dbos-inc/vercel-ai` 0.3.7, AI SDK 7.0.0 and Python DBOS 3.0.0.

**M0R 1 rerun (2026-09-25).** All five probes were rerun in one fresh container
on the sixth-revision pins: TypeScript DBOS 5.1.10, `@dbos-inc/vercel-ai`
0.4.4, AI SDK 7.0.93 (Studio's lockfile version), `pg` 8.22.0, Python DBOS
3.1.0 and PostgreSQL 17.11, on x86_64. Every probe reproduced the result in
the table below. The new `version-probe.mjs` covers the behaviours the sixth
revision adds. No ARM64 run has been made yet.
Only disposable loopback `free_test_*` databases, synthetic rows and a synthetic
model were used. No live provider, GPU, browser, ARM64 or deployment result is
claimed. The experiment containers were removed after use.

The retained portable scripts were rerun on 2026-09-25 against fresh disposable
databases: all five reproduced the results below. The FK database applied all
ten current migrations. Markdown links/fences, script syntax and whitespace
checks passed. No application runtime files were changed by this plan revision.

| Probe | Observed result | Plan consequence |
| --- | --- | --- |
| `probe.mjs`: admission poison | Same workflow ID still returns `not_admitted` after its domain row is later inserted | Delete start-before-commit and the admission wait |
| `probe.mjs`: Prisma/DBOS atomicity | Rollback: row=false, workflow=false; commit: row=true, workflow=true | Bind the transaction's `pg` client to both public APIs |
| `probe.mjs`: active dedup | Different candidate IDs return one handle/result (`first`) | No upload follower workflows |
| `probe.mjs`: publication crash | SIGKILL after revision 1 insert; recovered unguarded step inserts revision 2 | DBOS steps are at-least-once; every domain write needs idempotency |
| `admission-races.mjs`: same turn | One created, one replayed | Insert domain row first; reload after its primary-key conflict |
| `admission-races.mjs`: different turns | One created, one `DBOSQueueDuplicatedError`; one question persisted | Transactional chat dedup rejects a second turn without an orphan row |
| `admission-races.mjs`: cancellation | CANCELLED updates the DB timestamp, clears dedup, admits a new turn | Database-clock boot boundary; active dedup is not permanent identity |
| `stream-probe.mjs` | One provider call; outer sanitized return still leaves the synthetic secret in the recorded step error; replay ends with ordinary `finish` | Sanitize inside middleware; record failure then throw rather than returning workflow success |
| `queue_probe.py` | Following work remains ENQUEUED while the cancelled native step is blocked; it starts after that step ends | Worker concurrency plus flock serializes kei execution and cleanup |
| `fk-probe.mts` | Actual `deleteSourceDocument` fails with SQLSTATE 23503 on `batchSchemaSuggestionSource_sourceRepresentationRevisionId_fkey` | Replace restrictive membership FK and specify preservation/cascade semantics |
| `version-probe.mjs` (5.1.10/0.4.4 only) | A successful `durableCalls` stream leaves its synthetic request body and response header in no `dbos` table, but its provider metadata is in `operation_outputs`. Inside the step, `DBOS.stepStatus.cancelSignal` exists and fires 1001 ms after `cancelWorkflow`; no provider call follows, and the workflow ends CANCELLED | The sanitizer strips provider metadata and maps errors only; the key wait and Studio calls abort on `cancelSignal` |

Source inspection also confirmed that DBOS 5.0.2 rejects
`duplicationPolicy: 'return-existing'` in caller-owned transactions, and that
vercel-ai 0.3.7 refuses a stream retry after emitting content. The latter also
matches the partial-error probe's single provider call. The SDK client accepts
portable priority 0, whereas Python's direct enqueue-option validator requires
at least 1; the plan's priority-0 cleanup is submitted through the TS client.
No claim that priority enforces physical exclusion is made.

These are positive and negative probes of library behavior. They do not prove
the future Studio integration, deletion races, error-free providers, secret
absence across all paths, or browser recovery. Those remain M0R acceptance gates.

## Reproduction

Run once against a **fresh** disposable container. Several probes intentionally
leave completed workflows or crash their child process; rerunning against the
same database is not an independent test. Requirements: the pre-cutover FREE
checkout with `pnpm install` completed, Node 24, Docker, npm, pnpm and uv. Port
5432 must be unused; do not stop another service to make room. The JavaScript
probes call FREE's disposable-target guard before connecting; Python checks the
same loopback/user/database restrictions. Passwords below are synthetic.

From the FREE repository root, in a disposable shell:

```bash
set -e
export FREE_REVIEW_ROOT="$PWD"
FREE_REVIEW_DIR="$(mktemp -d /tmp/free-dbos-review.XXXXXX)"
cp docs/plans/2026-09-24-unified-durable-execution-evidence/*.mjs "$FREE_REVIEW_DIR/"
cp docs/plans/2026-09-24-unified-durable-execution-evidence/*.mts "$FREE_REVIEW_DIR/"
cp docs/plans/2026-09-24-unified-durable-execution-evidence/*.py "$FREE_REVIEW_DIR/"
npm install --prefix "$FREE_REVIEW_DIR" --ignore-scripts --no-audit --no-fund --save-exact \
  @dbos-inc/dbos-sdk@5.1.10 @dbos-inc/vercel-ai@0.4.4 ai@7.0.93 pg@8.22.0

FREE_REVIEW_CONTAINER="free-dbos-review-$(date +%s)"
docker run --rm -d --name "$FREE_REVIEW_CONTAINER" \
  --mount type=tmpfs,destination=/var/lib/postgresql/data \
  -p 127.0.0.1:5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=review-disposable-only \
  -e POSTGRES_DB=free_test_dbos_review postgres:17
# Install cleanup only after docker run succeeds; it names only this container.
trap 'docker stop "$FREE_REVIEW_CONTAINER" >/dev/null' EXIT
for attempt in $(seq 1 30); do
  if docker exec "$FREE_REVIEW_CONTAINER" pg_isready -U postgres; then break; fi
  sleep 1
done
docker exec "$FREE_REVIEW_CONTAINER" pg_isready -U postgres

docker exec "$FREE_REVIEW_CONTAINER" createdb -U postgres free_test_dbos_races
docker exec "$FREE_REVIEW_CONTAINER" createdb -U postgres free_test_dbos_fk
docker exec "$FREE_REVIEW_CONTAINER" createdb -U postgres free_test_dbos_version
node "$FREE_REVIEW_DIR/probe.mjs"
node "$FREE_REVIEW_DIR/admission-races.mjs"
node "$FREE_REVIEW_DIR/stream-probe.mjs"
node "$FREE_REVIEW_DIR/version-probe.mjs"
uv run --no-project --python 3.13 --with 'dbos==3.1.0' \
  python "$FREE_REVIEW_DIR/queue_probe.py"
DATABASE_URL='postgresql://postgres:review-disposable-only@127.0.0.1:5432/free_test_dbos_fk' \
  pnpm --filter db db:init > "$FREE_REVIEW_DIR/migrations.log"
pnpm --filter db exec tsx "$FREE_REVIEW_DIR/fk-probe.mts"

docker stop "$FREE_REVIEW_CONTAINER"
trap - EXIT
```

The portable copies only replace the original absolute checkout path with
`FREE_REVIEW_ROOT` and resolve Prisma Next through the installed `db` package.
They preserve the original probe logic. The FK probe must use the original ten
migrations; after the planned schema replacement its expected failure is obsolete.
The Python SDK can log an awaited-cancellation traceback during the intentional
cancel probe; the assertions and `NO_OVERLAP` event ordering are the result.

## Claude Code sparring record

Three tool-free review rounds used Claude Code with model `claude-opus-5-5` and
medium effort. Returned model-usage metadata confirmed the model. The final
response is retained in [opus-review.md](opus-review.md); it is a review to
challenge, not an authoritative specification. Invocation:

```bash
claude -p --safe-mode --model claude-opus-5-5 --effort medium \
  --tools '' --strict-mcp-config --no-session-persistence --output-format json
```

The briefs supplied the relevant design, source findings, experiment outputs
and explicit user choices. They asked for must-fix contradictions and further
net deletions, not implementation. Accepted: transactional admission, merging
ExtractionJob/Extraction and membership, whole-batch suggestion retry, dropping
upload keys/followers, truthful stream failure, and quiescence-aware cleanup.

Corrections and rejected proposals:

- The chat dedup key is an immutable Source Representation Revision, not a
  moving conversation revision. No new thread/head abstraction is needed.
- kei uses deployment-owned models; per-account keys do not require a model
  proxy or permission to read Studio tables.
- Studio selects cleanup candidates with its existing privileges and sends
  IDs to the restricted kei executor. kei cannot inspect Studio history.
- Active queue dedup does not replace completed-content or same-action replay.
- Terminal-only retention cannot expire a live parent's backlog.
- Removing immediate child cancellation would leave GPU work running until
  the sweep; retain immediate cancellation plus repair.
- Discard must suppress older proposals on the same base too; deleting only
  the newest would let an older proposal reappear.
- Preserve 24-hour staging-orphan age rather than adopting the review's shorter
  request-window cutoff. Retention and reference checks remain distinct.
- Defer removing the Python read API and per-model-call Python checkpoints;
  neither demonstrates a supported net reduction yet.

The final plan also preserves the concurrent browser-key revision. Its
60-second wait, lazy per-attempt key lookup, boot-ID resending and account
checks supersede the earlier encrypted-server-credential premise.

## Eighth revision (2026-09-25)

The eighth revision (kei lanes, decision 14) rests on these files:

- `fair_queue_probe.py`: DBOS 3.1.0 on SQLite. Per-account partitions give
  random per-poll sharing; plain priority and FIFO starve a second book. It
  informed the deferral of fairness.
- `rev8-review-brief.md`: the brief for Codex `gpt-6-astra`'s read-only
  review of the first proposal (A–D), which the user ran in a T3 thread. The
  brief records a proposal that was rejected. Findings and outcomes are in the
  plan's review log.
- `rev8-sparring-prompt.md` and `rev8-sparring-answer.md`: the Codex
  `gpt-6-astra` sparring round on the lane plan.
- `rev8-tests/`: measurements on the Spark's production model servers from
  throwaway containers, with synthetic documents (OCR contention, extraction
  contention, Catalog chunking). `rev8-tests/README.md` has the tables, the
  method and what remains untested.
- `rev8-plan-review-prompt.md` and `rev8-plan-review-answer.md`: the Codex
  `gpt-6-astra` read-only review of the written eighth revision (1 P1, 2 P2,
  1 P3, all accepted; see the plan's review log).

## M0R 1–4 (2026-09-26)

- [`m0r/`](m0r/README.md): items 2 (in-process lifecycle and the production
  bundle), 3 (admission with `applicationName`, `return-existing`, dequeue
  latency, kills around commit) and 4 (the four kei lanes, deadlines, database
  clock stamps, kei boot boundary, conversion budget), on x86_64.
- [`m0r-arm64/`](m0r-arm64/README.md): item 1's five probes rerun on the
  Spark (aarch64, Node 24.21.0) in throwaway containers; all match x86_64.
