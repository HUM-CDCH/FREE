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

## Pending release evidence

The other three end-to-end boundaries, per-method counting/replanning fixtures,
real DBOS process-recovery faults, live review/export, retention/deletion, and
isolated authenticated service/browser checks remain in progress. No readiness
or deployment claim is made by this record. Admissions must remain disabled
until the full [release matrix](../plans/2026-10-04-durable-interactive-extraction-release.md)
has passed. Prototype browser evidence is behavioral planning evidence only.
