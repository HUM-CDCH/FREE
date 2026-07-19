<!-- markdownlint-disable MD013 -->

# Design: harden-canonical-parsing-service

## Context

PR #21 introduces `parsed_document.v1`, exact page offsets, SSRF-safe URL ingestion, content-addressed sources, immutable canonical generations, task recovery, Docling text/tables, and page-local OCR fallback. Review confirmed that the Evidence/page-offset foundation is sound, but also found four merge-blocking defects and a set of qualified follow-ups. Broadly fixing every follow-up inside the already large PR would make regression review and rollback harder, so the work is split into a narrow merge gate and ordered hardening batches.

## Goals / Non-Goals

**Goals:**

- Fix the four reproduced merge blockers with producer-faithful tests.
- Preserve source meaning and fail to absent Evidence rather than wrong Evidence.
- Make admission, recovery, retention, integrity, and parser concurrency explicit contracts.
- Continuously verify deterministic tests and regularly exercise real Docling conversion.
- Harden the checked-in container as a minimum deployable baseline.

**Non-goals:**

- Implementing the future multi-page table schema (`parsed_document.v2`).
- Cryptographically authenticating data against a malicious local-volume writer.
- Guaranteeing host power-loss durability.
- Supporting arbitrary URL ports or uncertain IPv6 transition destinations.
- Running model-backed conversion on every pull request.

## Decisions

### 1. Keep the PR merge gate to four focused commits

The merge gate consists of bbox conversion, request admission, reconciliation, and split-table merging. Each commit carries its focused regression. Reconciliation fixes task-local exception isolation and stops rewriting unchanged terminal metadata, but explicit expiry and recovery reporting remain in the later storage batch.

Before merge, run focused tests, the full backend suite, `RUN_GOLDEN_E2E=1`, `RUN_DOCLING_INTEGRATION=1`, and diagnostics. Results are recorded in the PR because CI hardening is a subsequent batch.

### 2. Normalize Docling geometry at the producer boundary

Docling exposes `l/t/r/b`; under BOTTOMLEFT, `t > b`. `_bbox_inventory` will emit an ordered inventory tuple (`y0=b`, `y1=t` for BOTTOMLEFT), retaining the origin. `_inventory_bbox` remains the generic origin-aware conversion into displayed top-left coordinates. A test constructs a real `docling_core` BOTTOMLEFT box and passes it through producer and consumer. This preserves the intermediate `x0 <= x1`, `y0 <= y1` invariant and prevents fixtures from inventing a convention the producer never emits.

### 3. Enforce request bytes before multipart parsing

The exact Source Document limit remains 50 MiB. `POST /tasks` receives a route-aware pure-ASGI admission guard with a 51 MiB request limit: 50 MiB plus a fixed 1 MiB multipart-envelope allowance. The guard rejects an excessive valid `Content-Length` before invoking FastAPI and counts `http.request` messages for absent-length or chunked bodies without buffering the request. The existing post-parse exact source-byte check remains defense in depth.

### 4. Separate task-local recovery faults from shared-store failure

A malformed, over-quota, or unwritable individual task cannot prevent startup or reconciliation of later tasks. Reconciliation logs task-scoped, path-free diagnostics and continues. Failure to access or coordinate the shared store remains fatal at startup.

Before merge, unchanged terminal metadata is not rewritten, preventing restart-driven retention extension. Later, terminal transitions set an immutable UTC `expires_at` 24 hours ahead; task status exposes it. Inactive nonterminal tasks that cannot be recovered receive the same 24-hour grace from their last valid task timestamp and are removed only when unlocked. `/status` remains healthy for new work but reports a recovery-warning count/summary.

### 5. Preserve canonical Markdown semantics

DocTags list containers/items render as Markdown lists (`-` and `1.`), code renders in an adaptive fence that cannot be closed by its contents, and block formulas render between separate-line `$$` delimiters. Source text inside those wrappers is preserved. Rendering changes bump the converter-policy revision so old cache entries cannot mask changed canonical text.

A successful Camelot invocation returning zero candidates is a successful empty result. Literal Docling string `NaN` remains source content; only non-string missing-value sentinels on the Camelot adapter are blanked.

Page headers and footers are page furniture only for the narrow interstitial predicate that decides whether body-only OTSL fragments continue one table. Their ordinary rendering/drop behavior does not otherwise change.

### 6. Keep v1 safe; design multi-page tables in v2 separately

Per ADR 0004, a multi-page table is one logical table with page-scoped Evidence. This change does not guess the v2 shape. It checks in or derives a small real Docling fixture that demonstrates multiple physical-page Evidence. In v1, detection retains text/structure, suppresses misleading single-page geometry, and emits a stable warning. The fixture and ADR unblock the dependent [`publish-parsed-document-v2`](../publish-parsed-document-v2/design.md) change, whose first task freezes the producer-faithful field shape before implementation.

That v2 handoff also preserves conservative parser roles: Docling remains authoritative for semantic table content and structure, while Camelot may provide exact-match monotonic geometry enrichment or an explicitly attributed no-inventory fallback. Version 2 synchronizes Markdown with the final logical table, separates content/structure/geometry attribution, and surfaces DocTags, Docling, or Camelot disagreement instead of publishing competing table representations. These are v2 contract requirements, not additional v1 merge-gate work.

### 7. Use a conservative URL destination policy

Every initial URL and redirect hop permits only HTTP port 80 or HTTPS port 443. Literal-IP parsing is restructured so `UnsafeUrlError` is not caught as `ValueError`; forbidden literals are rejected before DNS. Resolved-IP validation and socket pinning remain authoritative.

Known IPv4-mapped/embedded and transition forms that cannot be confidently classified as public—including mapped private IPv4, well-known NAT64 carrying non-global IPv4, 6to4, and Teredo cases—are rejected. Network-specific translation remains a deployment egress concern. Redirect-to-private, redirect-loop, missing-Location, streamed-size, content-length, invalid MIME, and invalid PDF-magic paths receive focused tests.

Initial source-copy failures use typed classification: exact size overflow is 413, invalid source content is 400, quota/disk exhaustion is a generic 507, and unexpected filesystem failure is a generic 500. Internal paths and raw `OSError` text never reach a response.

### 8. Keep cache integrity internal to storage

The service-owned volume is trusted, so hashes detect corruption rather than malicious forgery. Each pending generation receives an internal manifest of relative path, byte size, and SHA-256 before directory publication. A small internal canonical integrity record binds the canonical JSON digest and generation-manifest digest. Cache reuse verifies the integrity record, canonical JSON, manifest, every referenced artifact, expected source hash, and preprocessing identity. Mismatch is a cache miss/rebuild and is never served.

The public `parsed_document.v1` schema does not gain storage-checksum fields. Documentation uses “integrity-verified,” not “authenticated.” Text artifacts are written as deterministic UTF-8/LF bytes so their digests do not vary by platform.

### 9. Make parser admission explicit and bounded

Long parser admission and short storage critical sections are separate. A process-shared slot mechanism limits concurrent different-Source-Document builds, defaults to one, and is deployment configurable. Per-source locking still converges duplicate content. Waiting happens off the event loop; expiration produces a distinct persisted `parser_capacity_timeout`.

A duplicate worker that cannot acquire the same task lock retries with bounded backoff, re-reads terminal state, and then defers to the lock owner. It never marks the task failed without ownership.

Task creation remains async because URL ingestion is async, but synchronous reservation/quota persistence moves into one threadpool helper. Document and Markdown handlers become synchronous FastAPI handlers so full filesystem/JSON/Pydantic work is offloaded. Tests prove event-loop progress without relying on production timing thresholds.

### 10. Coordinate cleanup with responses and public task state

Archive streaming holds the task lock from archive readiness until response completion, releasing it in a response background callback on success or error. Cleanup therefore cannot remove an archive in the pre-open window.

`GET /tasks/{id}` remains the only polling contract. Output routes called for non-completed tasks return a structured 409 containing a stable code and current task status, directing clients to the status endpoint.

### 11. Harden deployment, installation, and CI

The Docker image runs under a dedicated non-root account with only data/model locations writable. Compose is the hardened baseline, with pid limits and CPU/memory defaults selected after measuring peak use on the repository Source Document under CPU and GPU profiles; limits remain environment-overridable.

Plain root `pnpm install` performs profile-neutral Python synchronization. `pnpm install:cpu` and `pnpm install:gpu` remain the only selectors for mutually exclusive PaddleOCR profiles.

A required pull-request workflow runs the fast backend suite in the base profile. A nightly and manually dispatchable workflow runs real Docling integration and golden E2E with model caches and retained diagnostics. Model-backed nondeterminism therefore remains visible without blocking every pull request.

### 12. Promise process-crash atomicity, not host power-loss durability

Atomic replacement and generation publication guarantee process-level visibility. This change does not add fsync barriers. Documentation states that host power-loss durability depends on the mounted volume/filesystem; integrity mismatch causes rebuild where source bytes remain available.

## Risks / Trade-offs

- Pure-ASGI body limiting must avoid double responses after the receive limit is crossed; tests cover valid length, malformed/absent length, chunked messages, and exact boundaries.
- Conservative IPv6 policy may reject uncommon but legitimate institutional endpoints; standard public HTTP(S) remains available.
- Semantic Markdown changes canonical offsets and cache identity, so policy revision and golden review are mandatory.
- A default parser capacity of one favors memory safety over throughput; explicit slot metrics and timeout codes make the trade-off visible.
- Non-root bind mounts require documented ownership or named volumes.
- Internal unkeyed digests detect corruption but cannot defeat an actor able to rewrite both data and integrity metadata.
- Keeping v1 single-page tables means multi-page geometry stays absent until v2; the stable warning prevents silent misrepresentation.

## Migration

- Existing canonical entries are cache misses if they lack the new internal integrity records and rebuild from the content-addressed source.
- Existing terminal tasks without `expires_at` derive it once from their terminal `updated_at`; migration must not reset the retention clock.
- Existing clients continue polling `GET /tasks/{id}`. Output-route errors change from unstructured 400 to structured 409.
- Existing root installations become base-only after `pnpm install`; developers requiring OCR run the explicit CPU or GPU selector.
