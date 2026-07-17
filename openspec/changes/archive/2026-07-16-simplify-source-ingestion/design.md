<!-- markdownlint-disable MD013 -->

# Design: simplify-source-ingestion

## Context

FREE's parsing service runs locally for one humanities researcher and has no persistence layer beyond prototype task/artifact directories. Its Source Document boundary nevertheless includes remote URL fetching, source leases, four independent quota systems, and streamed request-envelope accounting. Those mechanisms obscure the smaller set of protections needed for local PDF uploads and make storage cleanup difficult to reason about.

The existing content-addressed Source Document path, parser pipeline, immutable canonical generations, and hourly cleanup are proven behavior. This change removes operational machinery around them without redesigning parsing output.

## Goals / Non-Goals

**Goals:**

- Make task creation upload-only and keep task metadata compatible with downstream parsing consumers.
- Preserve the 50 MiB upload stream cap, MIME and PDF-magic checks, sanitized display names, SHA-256 addressing, and atomic publication.
- Retain hourly stale-task, unreferenced-source, unreferenced-document, and orphan-generation cleanup with simple time-based rules.
- Delete quota and streamed-envelope accounting rather than replacing them with new abstractions.

**Non-Goals:**

- Hardening for hostile networks, multiple service processes, or shared storage.
- Changing `parsed_document.v1` compatibility fields for previously stored URL provenance.
- Redesigning `.pending` or canonical generation garbage collection.
- Continuing hardening task 2.5+, implementing `publish-parsed-document-v2`, or adding persistence.

## Decisions

### 1. Upload-only task admission

`POST /tasks` accepts one required PDF upload. Newly written metadata keeps `source_kind: "upload"` and `source_store_path` because the parser, manifest rebinding, status schema, and legacy recovery consume them. It no longer writes `submitted_url`. The versioned parsed-document source model retains URL-compatible fields so old stored documents remain readable.

The benchmark CLI also requires a local `--source`; retaining its URL import would keep the removed downloader alive as a compatibility shim.

### 2. Two independent byte boundaries

A small route-aware ASGI middleware rejects only a valid declared `Content-Length` above 51 MiB before multipart parsing. It does not wrap or count streamed receive messages. `copy_upload_to_path` remains authoritative for the exact 50 MiB Source Document limit and streams fixed-size chunks into a temporary sibling before `os.replace`.

### 3. Content-addressed source publication stays minimal

`store_source_by_hash` verifies that the input bytes match the supplied SHA-256 digest, returns the addressed path when already present, otherwise copies to a temporary sibling and atomically publishes with `os.replace`. It does not lock, reserve quota, prune during publication, or re-hash the destination. Same-digest concurrent writers are safe because each publishes validated identical bytes.

### 4. Source cleanup uses reference plus age

Hourly cleanup removes a source blob only when no task metadata references its digest and its mtime is at least one hour old. The grace replaces publication leases for this single-process prototype. No quota target influences deletion.

### 5. Retention is time-based, not capacity-based

Stale inactive tasks retain their existing 24-hour cleanup behavior. Unreferenced canonical document directories are removed only after seven days. Archive generation has no byte quota beyond the upstream upload and parser constraints. Existing task/document locks that coordinate active parsing, archive publication, and canonical generation cleanup remain; locks used only for quota transactions are removed.

### 6. Task creation is one linear flow

The route creates a task directory, offloads upload persistence, writes pending metadata atomically, schedules the worker, and returns the task identity. It removes URL branching, leases, quota reservation, and the global task-store lock. Failures remove the newly created task directory and return path-free client errors.

## Risks / Trade-offs

- **A deployment exposes the service to untrusted traffic** → enforce body limits at the proxy/server boundary; this prototype middleware trusts only declared length before multipart parsing.
- **Multiple processes upload and prune concurrently** → the one-hour source grace is intentionally a single-process ponytail; revisit with explicit coordination if deployment changes.
- **Disk fills without quotas** → local storage failure remains a generic ingestion/parsing failure; add one coarse disk-space check only if observed prototype use requires it.
- **An existing hash-addressed blob is corrupt** → the intentionally unconditional fast path does not repair it; parser authentication still detects mismatch, and integrity repair is a separate decision.

## Migration Plan

1. Park the hardening proposal at its current completed tasks.
2. Remove URL callers and metadata fields, then leases, quota accounting, streamed-envelope state, and route choreography in that order.
3. Update focused tests and documentation while preserving unrelated parsing and generation-GC coverage.
4. Validate the OpenSpec change, full backend suite, golden and real Docling tiers, diagnostics, and a live upload-to-Markdown lifecycle.

Rollback is a branch revert; no persistent schema migration is required. Existing task and parsed-document JSON remains readable because legacy normalization and the versioned source model retain URL compatibility.

## Open Questions

- Whether the backward-compatible URL fields should be removed in a future parsed-document schema version remains part of later re-triage, not this change.
