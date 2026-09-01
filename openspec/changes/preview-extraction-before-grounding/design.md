## Context

Interactive execution currently runs inside the POST request through `runSingle`, while Batch Extraction owns a second durable worker and a broad claimed persistence adapter. The values and Evidence stages already exist in one execution path, but there is no durable checkpoint between them. Extractions are immutable terminal rows and must remain so.

## Goals / Non-Goals

**Goals:**

- Reserve every new interactive and initial batch-member Extraction identity before model work.
- Put one durable values checkpoint between value extraction and Evidence linking.
- Replace synchronous and batch-specific execution orchestration with one worker and one execution module.
- Preserve ownership, lease, retry, Evidence, review, and safe-startup guarantees.

**Non-Goals:**

- Batch-member previews or batch cancellation.
- Generic operations, configurable concurrency, fair scheduling, or a new status endpoint.
- Runtime or migration compatibility for pre-job Extractions and Batch Extractions.

## Decisions

### Use one domain-specific Extraction Job table

`ExtractionJob` stores kind, ownership, resolved pins, retry selection, optional batch identity, status, cancellation, lease, checkpoint, diagnostics, failure, and timestamps. It is not a generic operation abstraction. Only terminal Extractions backed by completed jobs are readable.

Every Batch Extraction member points to one initial `BATCH_MEMBER` job. Interactive retries remain `INTERACTIVE` jobs even when their terminal Extraction belongs to a batch member.

### Make Batch Extraction a grouping aggregate

Batch scheduling atomically inserts its members and initial jobs. Member status, failure, and timing come from the initial job. Batch status is queued when every member job is queued, completed when every member job is completed or failed, and running otherwise.

This deletes the batch lease, member execution columns, batch worker, claimed persistence adapter, and the worker-local fingerprint helper.

### Execute all jobs through one deep module

The execution module receives resolved job inputs, an optional checkpoint, an awaited checkpoint callback, and an abort signal. It generates values only when necessary, checkpoints before Evidence linking, and returns a successful terminal payload without writing it. Failures throw to the worker.

The worker owns claim, lease renewal, cancellation, timeout, failure, and terminal promotion. Promotion atomically inserts the immutable Extraction and marks the job completed; failed or cancelled jobs retain checkpoints and create no Extraction.

### Use one priority worker per Studio process

The worker claims the oldest interactive job before the oldest batch-member job. An in-process wake minimizes latency; a five-second idle poll discovers work scheduled on other processes and expired leases. The worker exposes only an ID-checked abort method for same-process cancellation, so the current operation registry disappears.

### Keep one read contract for interactive attempts

The existing Extraction GET returns either an interactive job snapshot or an immutable Extraction. Job snapshots have execution status, nullable outcome/diagnostics, no Evidence, no review authority, and nullable provisional values. Pending batch jobs are not visible through this route or document reopen.

Completed job rows keep normalized identity and scheduling time but clear checkpoint payload after promotion. Every readable Extraction must have its completed job; there is no pre-job fallback shape.

## Risks / Trade-offs

- **Interactive priority can starve batch work** → mark the ceiling in code and add fair scheduling only after measured latency warrants it.
- **Existing Batch Extractions cannot be mapped without compatibility code** → fail before the first schema mutation and require an explicit data cutover outside this change.
- **One worker reduces per-process concurrency** → retain current bounded timeouts and defer additional workers until queue metrics justify them.
- **DTO terminal fields become nullable** → validate every state shape centrally and keep review/export guards terminal-only.

## Migration Plan

1. Add Extraction Jobs and a nullable initial-job relation on Batch Extraction members.
2. Fail before schema mutation when existing Batch Extraction rows would require compatibility mapping.
3. Make the initial job relation required for the supported empty starting state.
4. Drop duplicated member execution columns and batch lease/status/start columns.
5. Deploy application code that exclusively schedules, reads, and executes jobs. Normal startup continues to run the authored forward migration before readiness.

Rollback requires restoring the pre-change application and database backup; the forward migration deliberately removes duplicated execution columns after its empty-state precondition succeeds.
