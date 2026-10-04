# Durable interactive Extraction implementation evidence

Date: 2026-10-04. Status: implementation in progress; release capability OFF.
Origin: [issue 169](https://github.com/HUM-CDCH/FREE/issues/169).
Worktree: `/tmp/free-durable-extraction-implementation`.
Branch: `feat/durable-interactive-extraction`.
Base: `db6f8b92` (`origin/dev`, includes the view-prioritized streaming client).
Planning commit applied: `8be4bb805455afe9e64bc0a36b2b3f2fccf93ef6`.
ADR 0016 and the existing review-redesign specification preserved from `94328e650d4655a6fd3a5fbbad0929b97e99c324`; conflicting status headers retain the implemented streaming work and the newer review decision.

## Persistence boundary

The authored forward expansion adds only `extraction_runtime`; it does not
change public Extraction columns, original pins, artifacts, or review records.
It stores immutable selections, effective configuration, plans, finalized
inputs, checkpoints, retained snapshots, correction history, artifact
references, and dispatch handoffs. Runtime Head rows identify the new capability;
absence selects legacy readers. Worker privileges use an explicit routine
allowlist. The definer has no application-schema privileges.

Guarded check:

```sh
PROJECT_STORE_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/free_test_durable_implementation \
  pnpm --filter db exec tsx --test src/durable-extraction.postgres.check.ts
```

The target guard runs before any administrative connection. The fixture creates
and removes a uniquely suffixed `free_test_durable_*` database on the disposable
PostgreSQL server and a uniquely named restricted worker role. It does not reset
or use any runtime database, and does not modify another session's database.
The existing test server is only used to provision this isolated database.

Observed: forward migration preserves every seeded historical row byte for
byte (successful/reviewed, failed, and active legacy Extractions); repeated
migration is a no-op; worker table/schema access and internal routines denied;
only allowlisted routines granted; new capture refused after Pause; admitted
output commits during drain; Paused acknowledgement refused while in flight;
identical checkpoint publication returns the saved checkpoint; released/expired
lease rejects stale publication; original capture attribution remains unchanged;
immutable input rejects updates. No provider invocation is involved in this tier.

`pnpm --filter db test`: 85 checks passed, including the migration-reference
check. Extraction compatibility and legacy-reader checks: 4 passed. Extraction
TypeScript checking passed. These are boundary checks, not a full release claim.

## Lifecycle and call boundary

New explicitly named `extractDurableV1` and `extractionCallV1` workflows leave
the legacy workflow names, versions, and step order intact. A separate bounded
coordination pool releases every connection before provider work. Every method
yields at the call seam, publishes an immutable input including the actual HTTP
body, and replays committed outputs. Format fallback has its own dependent
capture and retains the original input. Native fields capture the native schema,
identity and counted input; guidance enters schema instructions rather than the
target source. Each method publishes structurally validated values from its
producer boundary, without reading debug progress as authoritative state.

Guarded process-recovery check:

```sh
EXTRACTION_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/free_test_durable_implementation \
  pnpm --filter extraction exec tsx --test src/durable-recovery.postgres.check.ts
```

Observed: all four faults passed (after capture, after finalized input, after
checkpoint commit before DBOS acknowledgement, and after retained-result
publication). Each fault kills a fresh process and starts a replacement. The
restricted worker role owns only its disposable `kei_dbos`; migrations and
fixture setup use the guarded administrative target. The fixture removes its
unique database, role, and temporary credentials. Scripted HTTP providers run
only in the disposable test container. Provider request count equals the final
checkpoint count; retained records survive each restart. This tier does not
establish live-model or browser/service acceptance.

Python targeted checks: 143 passed (8 durable adapter/method checks plus 135
legacy routing, artifacts, progress, worker boot, and model checks). The fresh
container uses image `phoenix-tracing-parsing_worker`, with the worktree mounted
read-only and no runtime database or volume. Node checks: 229 extraction and 85
database checks passed. Studio registration/schedules: 5 passed. TypeScript
checking passed for extraction and Studio. Subsequent edits require appropriate
re-verification before these counts can be used as a final release record.

The independent persistence standards/spec reviews found transaction-disconnect
handling, malformed snapshot admission, selection/manifest digest mismatches,
missing schema-dependent settings validation, unsaved-edit adoption, and
incompatible correction projection defects. These have been corrected; final
review remains required after all four boundaries.

## Pending release evidence

The live review/export and retention/deletion boundaries, additional lifecycle
and concurrent feedback/replanning fixtures, real DBOS drain/stop faults, and
isolated authenticated service/browser checks remain in progress. No readiness
or deployment claim is made by this record. Admissions must remain disabled
until the full [release matrix](../plans/2026-10-04-durable-interactive-extraction-release.md)
has passed. Prototype browser evidence is behavioral planning evidence only.
