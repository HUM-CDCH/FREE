# Tasks: simplify-source-ingestion

## 1. Delete URL ingestion

- [x] 1.1 Make `POST /tasks` require an upload, keep `source_kind: "upload"`, and remove new `submitted_url` metadata/API output
- [x] 1.2 Delete the URL ingestion module and URL-only tests; remove URL handling from the local control page and benchmark CLI
- [x] 1.3 Update parsing-service documentation and focused service/OpenAPI tests for upload-only behavior

## 2. Replace leases with mtime grace

- [ ] 2.1 Remove source lease paths, functions, parameters, and upload/task-route choreography
- [ ] 2.2 Prune only unreferenced source blobs at least one hour old and mark the single-process ponytail
- [ ] 2.3 Cover young, old, and referenced source-pruning behavior

## 3. Simplify source publication

- [ ] 3.1 Reduce `store_source_by_hash` to input digest verification, existing-blob reuse, temporary copy, and atomic rename
- [ ] 3.2 Preserve same-digest convergence and add hash-mismatch and failed-publication cleanup coverage

## 4. Remove quota accounting while retaining cleanup

- [ ] 4.1 Remove source, document, task, and archive byte constants, accounting functions, and call sites
- [ ] 4.2 Make unreferenced document cleanup depend only on the seven-day retention clock
- [ ] 4.3 Preserve stale-task cleanup, active-task locks, archive atomicity, and out-of-scope canonical-generation cleanup tests

## 5. Collapse request admission

- [ ] 5.1 Retain only route-aware declared `Content-Length` rejection above 51 MiB
- [ ] 5.2 Remove receive wrapping, streamed-overflow state, and mechanism-only tests while preserving exact boundary, unrelated-route, preemption, and CORS coverage

## 6. Simplify task creation

- [ ] 6.1 Reduce `create_task` to upload persistence, metadata persistence, worker scheduling, and path-free error cleanup
- [ ] 6.2 Remove the route-level global task-store lock, capacity reservation, lease cleanup, and defensive optional-digest narrowing

## 7. Complete trust-boundary coverage and verification

- [ ] 7.1 Cover invalid extension, disallowed and accepted MIME hints, bad PDF magic, filename sanitization, exact/overflow upload bytes, hash deduplication, and atomic publication failure
- [ ] 7.2 Cover one-hour source grace, seven-day document retention, stale-task locking, declared 413 CORS, archive behavior, and generation cleanup
- [ ] 7.3 Validate OpenSpec, Ruff, diagnostics, the full backend suite, golden E2E, real Docling integration, and a live upload-to-Markdown smoke test
