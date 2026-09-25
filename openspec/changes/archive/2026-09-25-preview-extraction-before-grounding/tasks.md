## 1. Durable Job Model

- [x] 1.1 Add Extraction Job schema, relations, status shapes, and an authored forward migration that rejects incompatible pre-job batches.
- [x] 1.2 Add migration and database contract coverage for the clean migration and fail-closed precondition.

## 2. Unified Execution

- [x] 2.1 Refactor extraction execution into checkpoint-aware values and Evidence stages that return terminal data without persisting it.
- [x] 2.2 Implement owned job scheduling, reads, cancellation, claims, checkpoints, renewal, failure, and lease-guarded terminal promotion.
- [x] 2.3 Replace the batch worker, claimed persistence adapter, and operation registry with one priority Extraction Job worker and idle polling fallback.
- [x] 2.4 Schedule initial Batch Extraction member jobs atomically and derive batch progress from them without changing batch transport shapes.

## 3. Interactive Transport and UI

- [x] 3.1 Update Extraction contracts and handlers for schedule/replay, job snapshots, nullable terminal fields, polling reads, and durable cancellation.
- [x] 3.2 Update document reopen to select interactive jobs and terminal Extractions by logical scheduling time while hiding pending batch jobs.
- [x] 3.3 Update the Extraction hook and results UI to poll, render provisional values, retain failed previews, and keep review/export disabled until completion.

## 4. Verification

- [x] 4.1 Replace obsolete synchronous and batch-worker tests with unified executor/worker, persistence, transport, and client coverage.
- [x] 4.2 Add the blocked-grounding navigation/reopen E2E scenario and run batch regressions.
- [x] 4.3 Run OpenSpec validation, typecheck, unit tests, PostgreSQL integration tests, and E2E tests appropriate to the available infrastructure.

## 5. Review Corrections

- [x] 5.1 Fix reclaim, cancellation, normalized replay, reopen, retry, polling, and provisional-action races; delete pre-job runtime and migration compatibility.
- [x] 5.2 Add focused regressions and rerun validation.
