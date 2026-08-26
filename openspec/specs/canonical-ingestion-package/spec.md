<!-- markdownlint-disable MD013 -->

# canonical-ingestion-package Specification

## Purpose
Completed ingestion exports a deterministic, integrity-verified portable canonical package; parsing-service storage stays a processor cache.



## Requirements

### Requirement: Completed ingestion exports a portable canonical package

`GET /tasks/{id}/download` for a completed v2 task SHALL return a deterministic
ZIP package that contains the original PDF Source Document,
`parsed_document.v2`, canonical Markdown, and a package manifest. All
references required to interpret canonical content SHALL be package-relative
and SHALL NOT depend on parsing-service storage paths or task retention.
The package's `parsed_document.json` SHALL be the same portable JSON payload
served by the document route.

#### Scenario: Canonical package leaves the parsing cache

- **WHEN** a completed task package is copied to storage owned by a future
  Project Context
- **THEN** its source, canonical document, Markdown, tables, blocks, and
  Evidence Anchors remain interpretable after the parsing task and cache are
  deleted

#### Scenario: Package contains a service path

- **WHEN** package assembly finds a required canonical reference that is
  absolute or service-relative rather than package-relative
- **THEN** package publication fails closed

### Requirement: Canonical package contents are minimal and fixed

The default canonical package SHALL contain the source PDF under a fixed
internal name, one v2 JSON contract, one canonical Markdown artifact, and one
digest manifest. Canonical tables, content blocks, page data, and EvidenceIndex
SHALL be represented by `parsed_document.v2`. The package SHALL NOT contain raw
Docling JSON, raw DocTags, PyMuPDF inspection output, parser debug artifacts,
task metadata, or extraction/model artifacts.

#### Scenario: Package is inspected

- **WHEN** a completed package is opened
- **THEN** it contains only the fixed canonical entries declared by its package
  schema
- **AND** no raw parser diagnostics or task-local archive content is present

#### Scenario: Diagnostics exist in the cache

- **WHEN** the canonical generation contains raw parser diagnostics
- **THEN** those artifacts remain available only under parsing-service retention
  policy
- **AND** are not copied into the portable package

### Requirement: Package manifest integrity-verifies every entry

The package manifest SHALL identify the package schema version, ParsedDocument
schema version, source content hash, preprocessing identity, and every
non-manifest entry's relative path, media type, byte size, and SHA-256 digest.
Package validation SHALL reject missing, extra, duplicate, unsafe, or
digest-mismatched entries.

#### Scenario: Package entry changes after assembly

- **WHEN** a canonical Markdown or source byte differs from the size or digest
  recorded in the package manifest
- **THEN** package validation fails

#### Scenario: Package contains an undeclared entry

- **WHEN** a ZIP entry is not declared by the manifest or repeats a normalized
  path
- **THEN** package validation fails rather than ignoring it

### Requirement: Package ZIP bytes are deterministic

For identical source bytes and preprocessing identity, package assembly SHALL use
stable entry ordering, names, timestamps, permissions, UTF-8 filenames,
LF-normalized canonical text, and uncompressed `ZIP_STORED` entries so the
resulting ZIP bytes do not vary with compressor implementations.

#### Scenario: Same generation is packaged twice

- **WHEN** the same committed v2 generation is packaged twice on supported
  platforms
- **THEN** both ZIP files have identical bytes and SHA-256 digest

### Requirement: Package assembly is task-locked, atomic, and quota-free

Package construction SHALL use the existing task-lock coordination and atomic
archive/package assembly from the completed source-ingestion simplification.
It SHALL NOT introduce source, document, task, or archive byte quotas.
Storage failures and cancellation SHALL remove temporary package content and
fail closed; no partial package SHALL be published. Before the task lock is
released, publication SHALL create an immutable delivery artifact and a
delivery lease. `FileResponse` SHALL open and stream that artifact through the
lease, renewing or holding the lease for the entire response lifetime. Cleanup
SHALL not remove it while the stream is active; the lease is released only
after response completion or cancellation, and response lifetime SHALL remain
outside the task lock.

#### Scenario: Package assembly succeeds

- **WHEN** a completed task's required source and canonical artifacts are
  assembled under the task lock
- **THEN** the package is atomically published as one complete artifact
- **AND** no partial package is visible

#### Scenario: Package storage fails

- **WHEN** a required read, write, digest, assembly, or final publication step
  fails
- **THEN** temporary package content is removed
- **AND** package publication fails closed with no partial package

#### Scenario: Package assembly is cancelled

- **WHEN** package construction or publication is cancelled
- **THEN** temporary package content is removed
- **AND** no partial package is published

### Requirement: Parsing-service storage remains a processor cache

Canonical package export SHALL NOT change parsing-service retention into durable
Project Context storage. After package delivery, task, source, and
canonical-generation cleanup SHALL continue under the completed
source-ingestion simplification's time-based retention and existing lock
coordination. No byte quota, durable pin, or repository semantics is added.

#### Scenario: Exported task expires

- **WHEN** a task has exported its package and later reaches its retention
  deadline
- **THEN** parsing-service cleanup may remove its task and eventually
  unreferenced cache data according to time-based retention
- **AND** the exported package remains the portable ownership-transfer artifact
