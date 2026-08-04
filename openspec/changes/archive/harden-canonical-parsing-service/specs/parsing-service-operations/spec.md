<!-- markdownlint-disable MD013 -->

# parsing-service-operations Delta Specification

## ADDED Requirements

### Requirement: Startup isolates task-local recovery failures

Startup reconciliation SHALL continue after malformed, over-quota, or unwritable individual task state while treating an unavailable shared store as fatal. Unchanged terminal tasks SHALL NOT be rewritten during reconciliation.

#### Scenario: One interrupted task cannot be persisted

- **WHEN** reconciliation encounters a task-local quota or filesystem failure
- **THEN** it logs a path-free task-scoped warning, leaves the original task state available for later recovery/cleanup, and continues with later tasks
- **AND** the parsing service starts if the shared store remains usable

#### Scenario: Shared store is unavailable

- **WHEN** startup cannot access or coordinate the shared task/document store
- **THEN** startup fails visibly rather than accepting work without a usable store

#### Scenario: Terminal task needs no migration

- **WHEN** a completed or failed task already has valid current metadata
- **THEN** reconciliation does not rewrite its metadata or extend its retention window

### Requirement: Terminal task retention has an explicit non-sliding clock

A task SHALL receive an immutable UTC `expires_at` 24 hours after its successful completed or failed transition. Reads and restarts SHALL NOT slide this expiry. Inactive unreconciled nonterminal tasks SHALL receive a 24-hour cleanup grace and SHALL only be removed while unlocked.

#### Scenario: Task reaches a terminal state

- **WHEN** task metadata is successfully persisted as completed or failed
- **THEN** `GET /tasks/{id}` exposes `expires_at` exactly 24 hours after the terminal transition

#### Scenario: Service restarts daily

- **WHEN** a terminal task is reconciled or read across restarts
- **THEN** its original `expires_at` remains unchanged and cleanup removes it after expiry

#### Scenario: Nonterminal recovery repeatedly fails

- **WHEN** an inactive pending/running task remains unrecoverable for 24 hours from its last valid task timestamp
- **THEN** cleanup removes it only after confirming it is inactive and acquiring its lock

### Requirement: Recovery degradation is observable without disabling healthy work

The status endpoint SHALL remain healthy when only individual tasks fail recovery, while exposing a recovery warning count/summary. Internal logs SHALL identify task IDs but SHALL NOT expose source URLs or storage paths in public status.

#### Scenario: Startup isolates two task failures

- **WHEN** startup otherwise succeeds after isolating two task-local recovery failures
- **THEN** `/status` reports the service online and reports two recovery warnings

### Requirement: Blocking storage work does not run on the event loop

Async request paths SHALL offload synchronous lock acquisition, recursive quota scans, filesystem reads, JSON decoding, and Pydantic validation. Entirely synchronous document-view handlers MAY rely on FastAPI's threadpool dispatch.

#### Scenario: Task reservation waits on the store lock

- **WHEN** another operation holds the task-store lock
- **THEN** unrelated async requests and event-loop heartbeats continue to make progress

#### Scenario: Large parsed document is requested

- **WHEN** the service reads and validates a large stored `ParsedDocument`
- **THEN** that work executes outside the event-loop thread

### Requirement: Parser admission is bounded across processes

Long-running conversion SHALL use a process-shared configurable slot limit that defaults to one, separate from short storage critical sections. Per-source locking SHALL still converge duplicate source content.

#### Scenario: A parser slot becomes available

- **WHEN** a pending task is waiting within its admission deadline
- **THEN** it acquires one slot, runs conversion, and releases the slot on every exit path

#### Scenario: Admission deadline expires

- **WHEN** no parser slot becomes available before the configured deadline
- **THEN** the task reaches failed with stable code `parser_capacity_timeout`

#### Scenario: Duplicate worker contends for one task

- **WHEN** a second worker cannot acquire the task ownership lock
- **THEN** it retries with bounded backoff, re-reads task state, and defers to the owner
- **AND** it never writes a failure without owning the task lock

### Requirement: Canonical cache reuse is integrity-verified

Before cache reuse, internal integrity metadata SHALL bind the canonical JSON and every canonical generation artifact to expected byte sizes and SHA-256 digests. It SHALL also verify source identity, preprocessing identity, safe relative paths, regular-file status, and expected text consistency. Integrity metadata SHALL remain outside the public parsed-document schema.

#### Scenario: Canonical JSON or an artifact is corrupted

- **WHEN** a byte, digest, manifest entry, path, or required file differs from the committed integrity metadata
- **THEN** the entry is not served as a cache hit
- **AND** the service rebuilds from the content-addressed source or fails closed

#### Scenario: Cache entry is valid

- **WHEN** canonical JSON, manifest, artifacts, source identity, and policy identity all verify
- **THEN** the service reuses the immutable generation without conversion

### Requirement: Cleanup cannot remove an archive before streaming opens it

The service SHALL hold task ownership from archive readiness through response completion and SHALL release it on successful, failed, or cancelled responses.

#### Scenario: Cleanup runs while an archive response is pending

- **WHEN** cleanup attempts to remove the task after the archive is prepared but before/during response streaming
- **THEN** cleanup cannot acquire the task lock and leaves the archive available

### Requirement: Task status is the sole polling contract

Clients SHALL poll `GET /tasks/{id}`. Document, Markdown, and archive routes SHALL serve completed tasks and SHALL return a structured 409 conflict for any non-completed task.

#### Scenario: Output is requested for a running task

- **WHEN** a client requests document, Markdown, or archive output while status is running
- **THEN** the service returns 409 with a stable code and current task status
- **AND** directs the client to the task-status endpoint

#### Scenario: Output is requested for a failed task

- **WHEN** a client requests output after terminal failure
- **THEN** the service returns the same structured 409 shape with failed status rather than pretending the task is still retryable

### Requirement: Checked-in deployment is a hardened baseline

The container SHALL run parsing under a dedicated non-root identity and SHALL expose only required writable data/model locations. Compose SHALL define overridable pid, CPU, and memory limits selected from measured CPU/GPU parsing profiles.

#### Scenario: Parser runs in the checked-in container

- **WHEN** a Source Document is parsed through Compose
- **THEN** the parser process is non-root, can write required volumes, and cannot write application code paths

### Requirement: Root installation does not select an OCR profile

Plain root `pnpm install` SHALL perform profile-neutral Python synchronization. Mutually exclusive CPU and GPU OCR profiles SHALL only be selected through explicit workspace commands.

#### Scenario: GPU profile exists and root install runs

- **WHEN** a developer has selected the GPU OCR profile and later runs root `pnpm install`
- **THEN** installation does not replace it with the CPU profile

### Requirement: Fast and model-backed checks run at appropriate CI tiers

Pull requests SHALL run the profile-neutral fast backend suite and diagnostics. Real Docling integration and golden E2E SHALL run nightly on `dev` and via manual dispatch with reusable caches and retained failure evidence.

#### Scenario: Pull request changes parsing code

- **WHEN** CI runs for the pull request
- **THEN** deterministic backend checks are required without downloading model assets

#### Scenario: Nightly real tier detects parser drift

- **WHEN** real Docling or golden assertions fail on the nightly workflow
- **THEN** the failure is visible with retained logs/artifacts but does not retroactively block unrelated pull requests

### Requirement: Atomic publication promises process-crash visibility

Storage documentation SHALL define atomic replacement as a process-crash visibility guarantee, not a host power-loss durability guarantee. Integrity mismatch after storage damage SHALL prevent cache reuse.

#### Scenario: Process terminates before canonical commit

- **WHEN** a process stops before the atomic canonical record is replaced
- **THEN** readers see the prior valid commit or no commit, never a partially serialized commit

#### Scenario: Host storage loses acknowledged bytes

- **WHEN** a host/filesystem failure damages data despite atomic replacement
- **THEN** integrity validation rejects the damaged entry
- **AND** durability beyond that behavior depends on the mounted volume/filesystem
