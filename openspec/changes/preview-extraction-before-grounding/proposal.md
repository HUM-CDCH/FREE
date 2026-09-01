## Why

Interactive Extraction currently keeps the request open until values, Evidence linking, and terminal persistence finish, so researchers cannot inspect extracted values early and navigation cancels server work. Batch Extraction already has durable scheduling, but its separate worker and persistence adapter duplicate execution concerns without supporting interactive retry identity.

## What Changes

- Durably schedule interactive and initial Batch Extraction member work as domain-specific Extraction Jobs.
- Return interactive POST requests immediately and expose provisional values through the existing Extraction GET while Evidence linking continues.
- Replace synchronous single execution and the batch-specific worker with one priority Extraction Job worker and one shared values-to-Evidence execution module.
- Preserve immutable terminal Extractions; failed or cancelled new jobs retain provisional values without creating review authority.
- Keep Batch Extraction transport and review behavior stable while deriving member progress from initial member jobs.
- **BREAKING**: nonterminal Extraction responses gain execution status and nullable terminal fields; navigation no longer cancels server work.
- **BREAKING**: pre-job Extractions and Batch Extractions are not migrated or exposed; deployments containing them fail the migration without modifying data.

## Capabilities

### New Capabilities

- `durable-extraction-jobs`: Durable scheduling, checkpointing, leasing, cancellation, and batch-member execution for Extraction Jobs.

### Modified Capabilities

- `canonical-evidence-lifecycle`: Expose provisional values before Evidence exists while preserving the rule that only terminal grounded Extractions are reviewable.

## Impact

- Changes the database contract and forward migration for Extractions, Batch Extractions, and Batch Extraction members.
- Refactors `packages/extraction` persistence, execution, and worker interfaces.
- Changes Studio Extraction transport, polling, reopen, and result-state behavior.
- Requires migration, PostgreSQL integration, transport, client, and Evidence lifecycle E2E coverage.
