<!-- markdownlint-disable MD013 -->

# Proposal: harden-canonical-parsing-service

> **Status: closed after re-triage (human decision, 2026-07-16).** Tasks
> 1.1–2.4 are completed and shipped in PR #24 together with
> [`simplify-source-ingestion`](../simplify-source-ingestion/proposal.md),
> which superseded the ingestion, URL-hardening, quota, and concurrency
> direction. Every remaining task is dispositioned in `tasks.md`:
>
> - **2.5/2.6 closed — premise disproven.** Two evidence rounds showed Docling
>   never produces a multi-page `TableItem` (upstream docling issue #2976; a
>   scan of 203 upstream ground-truth tables found zero). The merged task 1.7
>   continuation predicate already handles the real page-local producer shape.
>   Reopen only if a genuine multi-page fixture ever appears.
> - **3.1–3.4 voided** — URL ingestion was deleted entirely.
> - **3.5 covered** by simplify-source-ingestion phase 7 trust-boundary tests;
>   **3.6 substantially done** in follow-up `c47f921` (typed upload errors).
> - **3.7–3.11 closed — no deployment target.** Container hardening, resource
>   profiling, and CI are deferred until FREE has a deployment beyond a
>   researcher's own machine; CI was explicitly declined for now.
> - **Batch 4 closed — conflicts** with the simplification direction; it would
>   rebuild deleted machinery.
> - **2.7, 2.8, and batch 5 migrated** to
>   [`parsing-docs-cleanup`](../parsing-docs-cleanup/proposal.md).
>
> This change can be archived once PR #24 merges.

## Why

PR #21 establishes canonical Source Document parsing as FREE's ingestion boundary, but independent review and focused reproductions found four defects that should be corrected before merge: real Docling BOTTOMLEFT table Evidence is discarded, the 50 MiB source limit is enforced only after multipart spooling, one task-local reconciliation failure can abort startup, and page headers break cross-page table reconstruction. The same review confirmed additional fidelity, security, storage, concurrency, deployment, and coverage gaps that are real but do not justify keeping the foundational PR open indefinitely.

## What Changed

This change uses two tracks:

1. **PR #21 merge gate** — four focused commits fix bbox conversion, pre-parser request admission, startup reconciliation isolation/no-op terminal handling, and page-header-aware split-table merging. The full backend suite, golden pipeline, and real Docling integration must all pass before merge.
2. **Ordered hardening batches after merge** — parsing fidelity first, then security and CI, then storage/concurrency, then cleanup and documentation.

The hardening work will:

- preserve list, code, formula, table-cell, and multi-page table meaning without inventing Evidence;
- restrict URL ingestion to confidently public destinations on ports 80/443 and expand negative coverage;
- run the parser as a resource-bounded non-root container and continuously test fast and model-backed tiers;
- integrity-verify canonical cache files, remove blocking work from async request paths, and make parser admission explicit and bounded;
- define terminal task expiry, orphan recovery grace, archive/cleanup coordination, and stable output-route conflict responses;
- make root installation OCR-profile neutral and remove obsolete normalization code and terminology drift.

## Capabilities

### New Capabilities

- `source-document-ingestion`: bounded multipart and URL admission for Source Documents, including destination, redirect, MIME, size, and error-handling rules.
- `canonical-document-parsing`: canonical Markdown, table, geometry, Evidence, and parser-fidelity rules.
- `parsing-service-operations`: task recovery, retention, cache integrity, concurrency, deployment, installation, and CI behavior.

### Modified Capabilities

None.

## Impact

- `prototypes/parsing_service/app/ingestion/`, `app/api/`, `app/parsing/`, `app/storage/`, `app/workers/`, and their tests.
- `prototypes/parsing_service/Dockerfile`, `compose.yaml`, package scripts, and root workspace scripts.
- New GitHub Actions workflows for required fast checks and nightly/manual model-backed checks.
- `docs/parsing-service.md`, `docs/parsing-quality.md`, prototype README, and terminology cleanup.
- ADR [`docs/adr/0004-model-multi-page-tables-as-one-logical-table.md`](../../../docs/adr/0004-model-multi-page-tables-as-one-logical-table.md) records the future `parsed_document.v2` table decision; the dependent [`publish-parsed-document-v2`](../publish-parsed-document-v2/proposal.md) change owns that contract.

## Non-goals

- Implementing `parsed_document.v2` in this change; version 1 will fail safe and the dependent [`publish-parsed-document-v2`](../publish-parsed-document-v2/proposal.md) change remains blocked until the real fixture is proven.
- Protecting cache data from a malicious actor with write access to the service-owned volume; this change detects corruption, not forgery.
- Promising power-loss durability; atomicity covers process crashes and integrity validation triggers rebuild after storage damage.
- Turning document, Markdown, or archive routes into alternate task-polling APIs.
- Adding model extraction or researcher-selectable parser pipelines to the parsing service.
