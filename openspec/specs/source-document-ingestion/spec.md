<!-- markdownlint-disable MD013 -->

# source-document-ingestion Specification

## Purpose

Upload and retain source PDFs as verified, content-addressed artifacts.

## Requirements

### Requirement: Task creation accepts one uploaded PDF Source Document

The parsing service SHALL require an uploaded PDF Source Document for `POST /tasks` and SHALL NOT accept a URL ingestion alternative. Newly created task metadata SHALL identify the source kind as `upload`, retain its content-addressed source reference, and omit submitted URL metadata.

#### Scenario: Valid upload creates a task

- **WHEN** a client submits one valid PDF upload to `POST /tasks`
- **THEN** the service persists upload metadata and schedules canonical parsing
- **AND** the task status exposes `source_kind` as `upload`

#### Scenario: Upload is absent

- **WHEN** a client submits `POST /tasks` without an upload
- **THEN** task creation is rejected before task storage is created

#### Scenario: URL form data is submitted

- **WHEN** a client submits URL form data without an upload
- **THEN** task creation is rejected and no remote request is made

### Requirement: Upload validation preserves the PDF trust boundary

The parsing service SHALL stream uploaded bytes with an exact 50 MiB cap, require a sanitized display filename ending in `.pdf`, validate allowed PDF MIME hints when present, and require `%PDF-` magic bytes. Empty MIME hints and the currently allowed PDF and octet-stream hints SHALL remain accepted.

#### Scenario: Upload is exactly 50 MiB

- **WHEN** the Source Document contains exactly 50 MiB
- **THEN** upload persistence accepts all bytes

#### Scenario: Upload exceeds 50 MiB

- **WHEN** streaming reads any byte beyond 50 MiB
- **THEN** upload persistence stops, removes temporary content, and returns 413

#### Scenario: Filename is unsafe or has an invalid extension

- **WHEN** an upload name contains path components but ends in `.pdf`
- **THEN** only its sanitized basename is stored as display metadata
- **WHEN** the sanitized display name does not end in `.pdf`
- **THEN** ingestion rejects the upload

#### Scenario: MIME hint is disallowed

- **WHEN** a non-empty upload MIME hint is outside the allowed PDF and octet-stream set
- **THEN** ingestion rejects the upload

#### Scenario: PDF magic is absent

- **WHEN** uploaded bytes do not begin with `%PDF-`
- **THEN** ingestion rejects the upload and publishes no Source Document blob

### Requirement: Declared oversized task requests are rejected before multipart parsing

The parsing service SHALL reject `POST /tasks` when one valid declared `Content-Length` exceeds 51 MiB. The declaration check SHALL be route-aware, SHALL preserve outermost CORS behavior, and SHALL NOT replace the exact streamed 50 MiB Source Document limit.

#### Scenario: Declared request is at the envelope boundary

- **WHEN** `POST /tasks` declares a `Content-Length` of exactly 51 MiB
- **THEN** the request proceeds to multipart handling

#### Scenario: Declared request exceeds the envelope boundary

- **WHEN** `POST /tasks` declares a `Content-Length` greater than 51 MiB
- **THEN** the service returns 413 before task creation
- **AND** an allowed Origin receives the configured CORS response header

#### Scenario: Another route declares an oversized body

- **WHEN** a route other than `POST /tasks` declares a body above 51 MiB
- **THEN** this task-specific middleware does not reject it

### Requirement: Source Documents are published by verified content hash

The parsing service SHALL verify that input bytes match the supplied SHA-256 digest, address the blob as `{sha256}.pdf`, write new content to a temporary sibling, and publish it with an atomic rename. An existing addressed blob SHALL be reused, and concurrent same-digest publication SHALL converge on one path.

#### Scenario: Input digest does not match

- **WHEN** the supplied SHA-256 digest differs from the input bytes
- **THEN** publication fails without creating the addressed blob

#### Scenario: Same Source Document is submitted twice

- **WHEN** two tasks submit identical Source Document bytes
- **THEN** both metadata records reference the same SHA-256-addressed blob
- **AND** only one addressed source blob exists

#### Scenario: Temporary publication fails

- **WHEN** copying or atomic replacement fails before publication completes
- **THEN** no partial addressed blob is visible
- **AND** temporary content is removed

### Requirement: Source cleanup uses references and a one-hour grace

Hourly cleanup SHALL remove only source blobs that are unreferenced by task metadata and whose mtime is at least one hour old. It SHALL NOT require lease files or quota pressure.

#### Scenario: Young unreferenced source exists

- **WHEN** an unreferenced source blob is younger than one hour
- **THEN** cleanup leaves it available

#### Scenario: Old unreferenced source exists

- **WHEN** an unreferenced source blob is at least one hour old
- **THEN** cleanup removes it

#### Scenario: Referenced source is old

- **WHEN** task metadata references a source blob older than one hour
- **THEN** cleanup leaves it available

### Requirement: Retention cleanup is independent of storage quotas

The hourly cleanup loop SHALL retain stale-task cleanup, remove only unreferenced canonical document directories older than seven days, and retain canonical pending/orphan generation cleanup. Active or locked tasks SHALL not be removed. Cleanup and archive publication SHALL NOT depend on per-source, per-document, per-task, aggregate, or archive byte quotas.

#### Scenario: Stale inactive task exists

- **WHEN** an inactive task is older than its existing 24-hour stale-task cutoff and its task lock can be acquired
- **THEN** cleanup removes the task

#### Scenario: Stale task is active or locked

- **WHEN** a stale task is active or its task lock cannot be acquired
- **THEN** cleanup leaves the task available

#### Scenario: Unreferenced document crosses retention

- **WHEN** an unreferenced canonical document is at least seven days old
- **THEN** cleanup removes its document directory

#### Scenario: Referenced or young document exists

- **WHEN** a canonical document is referenced by task metadata or is younger than seven days
- **THEN** retention cleanup leaves it available

#### Scenario: Archive is generated

- **WHEN** a completed task requests its canonical ingestion archive
- **THEN** the archive is atomically published under the task lock without quota accounting
