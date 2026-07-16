# Proposal: simplify-source-ingestion

## Why

The parsing service is a localhost, single-researcher prototype, but Source Document ingestion and storage currently carry URL-fetching, lease, quota, and request-stream machinery intended for a multi-process production service. Removing those mechanisms makes the trust boundary easier to understand while retaining the protections that matter for local PDF uploads.

## What Changes

- **BREAKING** Make `POST /tasks` upload-only and remove URL ingestion from the service, local control page, and benchmark CLI.
- Retain the exact 50 MiB streaming upload cap, MIME and PDF-magic validation, sanitized display filenames, SHA-256 content addressing, and atomic temporary-file publication.
- Replace source leases with a one-hour mtime grace before unreferenced source blobs can be pruned.
- Remove source, document, task, and archive quota accounting while retaining hourly cleanup, stale-task removal, seven-day unreferenced-document retention, and the existing canonical-generation cleanup.
- Reduce request-envelope admission to rejecting a declared `Content-Length` above 51 MiB for `POST /tasks`; the upload stream remains the authoritative 50 MiB limit.
- Simplify task creation to save the upload, persist metadata, and schedule the parser.
- Park `harden-canonical-parsing-service` at its current completed tasks for later re-triage; do not resume task 2.5+, document-generation GC redesign, or `publish-parsed-document-v2` here.

## Capabilities

### New Capabilities

- `source-document-ingestion`: Upload-only Source Document admission, validation, content-addressed publication, task creation, and retention cleanup.

### Modified Capabilities

None.

## Impact

- Parsing-service task API, upload handling, source/document storage cleanup, request middleware, archive creation, task worker, local control page, and benchmark CLI.
- Parsing-service ingestion/storage tests and documentation.
- URL task creation and URL-valued `compare.py --source` are removed; callers must submit or reference a local PDF.
- The versioned `parsed_document.v1` source model remains backward-compatible for previously stored URL provenance, while newly created task metadata is upload-only.
