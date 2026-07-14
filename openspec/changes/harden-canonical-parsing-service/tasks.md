<!-- markdownlint-disable MD013 -->

# Tasks: harden-canonical-parsing-service

## 1. PR #21 merge gate — four focused commits

- [x] 1.1 Add a failing producer→consumer round-trip using a real `docling_core` BOTTOMLEFT box; normalize `_bbox_inventory` to ordered coordinates; retain generic origin conversion; verify affected Camelot-area/dedup paths receive geometry
- [x] 1.2 Replace the ascending-BOTTOMLEFT fixture with producer-faithful data and run focused table/Docling tests
- [x] 1.3 Add pre-parser admission tests for exact 51 MiB request boundary, excessive `Content-Length`, absent length, chunked overflow, no handler/task creation on rejection, and an exact 50 MiB Source Document
- [x] 1.4 Add a route-aware pure-ASGI request limiter while retaining the exact post-parse 50 MiB source check
- [x] 1.5 Add reconciliation regressions proving one task-local quota/filesystem failure does not block later tasks or lifespan, shared-store failure remains fatal, and unchanged terminal metadata/mtime is not rewritten
- [x] 1.6 Refactor reconciliation into explicit task-local and shared-store error boundaries without introducing expiry/API changes yet
- [x] 1.7 Add a page-header-between-OTSL-fragments regression and ignore both page headers and footers only in the cross-page merge predicate
- [x] 1.8 Run focused regressions, `uv run --no-sync python -m unittest discover -s tests`, `RUN_GOLDEN_E2E=1`, `RUN_DOCLING_INTEGRATION=1`, and Python diagnostics; record results on PR #21

## 2. Parsing-fidelity batch

- [ ] 2.1 Specify and test that a successful Camelot call returning zero tables is a successful empty result without `completed_with_warnings`; implement the status correction
- [ ] 2.2 Split missing-value normalization by adapter; preserve literal Docling `NaN` and blank only non-string Camelot missing-value sentinels
- [ ] 2.3 Add minified/nested list, ordered/unordered list, code-fence collision, formula, page-span, and source-text preservation tests
- [ ] 2.4 Render standard Markdown list markers, adaptive fenced code, and separate-line `$$` formula blocks; bump the DocTags converter-policy revision and manually review golden changes
- [ ] 2.5 Produce/check in a small real Docling fixture with multi-page table Evidence; in v1 retain text/structure, suppress misleading geometry, and emit a stable warning
- [ ] 2.6 Unblock [`publish-parsed-document-v2`](../publish-parsed-document-v2/proposal.md) by attaching the proven fixture and producer-shape findings to its schema-gate tasks, including DocTags-slot/Docling-inventory correspondence and page-scoped geometry; preserve the v2 single-table-authority, role-specific parser attribution, and explicit-disagreement requirements without implementing them in this change
- [ ] 2.7 Write all canonical text artifacts as deterministic UTF-8/LF bytes and test byte digest stability independently of platform newline defaults
- [ ] 2.8 Update `docs/parsing-quality.md` with canonical Markdown semantics, table-less success, literal-value preservation, and the v1 multi-page fail-safe
- [ ] 2.9 Run focused parser tests, full backend tests, golden E2E, real Docling integration, and diagnostics

## 3. Security, deployment, and CI batch

- [ ] 3.1 Restructure literal-IP validation so a forbidden literal raises before DNS; test that resolution and connection are never attempted
- [ ] 3.2 Enforce ports 80/443 on the initial URL and every redirect; add default/explicit/redirect port tests
- [ ] 3.3 Reject risky IPv4-mapped/embedded and transition IPv6 destinations, including non-global well-known NAT64 payloads, 6to4, and Teredo cases; document network-specific egress responsibility
- [ ] 3.4 Add redirect-to-private, redirect loop, missing `Location`, oversized `Content-Length`, streamed overflow, and fragmented PDF-magic tests without mocking away redirect validation
- [ ] 3.5 Add multipart invalid extension, disallowed MIME, empty MIME, octet-stream, bad PDF magic, exact source-size, and request-envelope tests
- [ ] 3.6 Replace string-matched upload exceptions with typed classification; redact raw filesystem details and return 413/400/507/500 by failure class
- [ ] 3.7 Create a dedicated non-root image account; make only data/model locations writable; add a container smoke test that parses as non-root and writes both volumes
- [ ] 3.8 Profile peak RSS, process count, CPU, and GPU behavior on the repository Source Document under CPU/GPU profiles; set overridable Compose memory/CPU/pid defaults from measurements
- [ ] 3.9 Change plain `install:python`/root `pnpm install` to base-only `uv sync`; retain explicit CPU/GPU selectors and extend operability tests/documentation
- [ ] 3.10 Add required pull-request CI for profile-neutral install, fast backend tests, and diagnostics
- [ ] 3.11 Add nightly plus `workflow_dispatch` real Docling/golden CI with dependency/model caches, retained artifacts/logs, and visible failure reporting

## 4. Storage, task lifecycle, and concurrency batch

- [ ] 4.1 Define an internal generation-integrity manifest and canonical-integrity record that bind relative paths, byte sizes, artifact digests, canonical JSON digest, and generation-manifest digest
- [ ] 4.2 Publish integrity metadata within the pending→generation→canonical commit sequence; verify all records, refs, source identity, and policy identity before cache reuse
- [ ] 4.3 Add corruption tests for canonical JSON, manifest, final Markdown, raw artifacts, missing files, symlinks, and digest mismatch; every case must rebuild or fail closed rather than serve altered content
- [ ] 4.4 Extract task reservation/quota persistence into a synchronous threadpool helper; make document/Markdown handlers synchronous; add event-loop progress tests
- [ ] 4.5 Separate long parser admission from short store locks; implement process-shared configurable slots defaulting to one and persist distinct `parser_capacity_timeout` failures
- [ ] 4.6 Add bounded retry/backoff for duplicate task-lock contention; re-read status and defer to the owner without writing a failure while unowned
- [ ] 4.7 Add immutable terminal `expires_at` to task metadata/status; derive legacy expiry once from terminal `updated_at` without sliding it
- [ ] 4.8 Apply a 24-hour grace to inactive unreconciled nonterminal tasks; delete only when inactive and unlocked; test restart and cleanup boundaries
- [ ] 4.9 Return a recovery report from startup, expose warning count/summary on `/status`, and emit structured task-scoped logs without internal paths
- [ ] 4.10 Hold the task lock through archive response completion with guaranteed background release; test cleanup cannot win the pre-open race
- [ ] 4.11 Return a structured 409 with stable code/current status from non-completed output routes; retain `GET /tasks/{id}` as the only polling contract
- [ ] 4.12 Document process-crash atomicity and integrity-triggered rebuild while explicitly excluding host power-loss durability
- [ ] 4.13 Run concurrency, corruption, retention, API, full backend, golden, and diagnostics checks

## 5. Cleanup and documentation batch

- [ ] 5.1 Move the sole production `read_text` helper to its owning module, delete production-dead normalization functions/module tests, and verify no imports remain
- [ ] 5.2 Replace generic `user`, `file`, and inappropriate `upload`/`PDF` wording with `Humanities Researcher` and `Source Document`; retain format-specific PDF terminology where technically required
- [ ] 5.3 Correct cache claims from “digest-authenticated” to “integrity-verified” and align request-limit, retention, parser-admission, CI, and deployment documentation with implemented behavior
- [ ] 5.4 Confirm output-route polling, NAT64 exploitability, all-geometry loss, forever-pending locks, mid-stream deletion, and `/markdown` newline claims are not repeated in overstated form
- [ ] 5.5 Validate OpenSpec artifacts, links, Markdown, full workspace tests/builds, backend real tiers, container smoke tests, and diagnostics before archiving this change
