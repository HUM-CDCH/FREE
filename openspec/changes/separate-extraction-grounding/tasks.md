## 1. Three-example flow decision

- [x] 1.1 Extend the disposable benchmark to build current-combined, full-document two-pass, deterministic full-source record-batched, and deterministic retrieval-batched prompts for Ellekilde, `1790-06-17-1.pdf`, and Zhang 2024, reporting canonical-artifact readiness without unsafe fallback.
- [x] 1.2 Run bounded fixed-condition comparisons with the exact local Ollama model on every canonical-ready example, record peak and aggregate tokens/timing plus extraction/grounding quality, and stop production acceptance when no production-equivalent grounding scope passes.

## 2. Grounding module

- [x] 2.1 Add clean Extraction result, scalar result-path, Evidence-link, grounding issue, and two-step model-attribution contracts without a compatibility result shape.
- [x] 2.2 Implement deterministic `C*` claim enumeration, compact claim rendering, strict grounding-response decoding, exact `C*`/`E*` resolution, abstention, and fail-closed unknown/duplicate handling with focused tests.
- [x] 2.3 Render every logical table once in the canonical grounding projection while retaining exact anchor ownership and update projection tests.
- [x] 2.4 Add a semantically named grounding request adapter over the existing buffered provider-neutral model route and retain both stage attributions.

## 3. Browser orchestration and results

- [x] 3.1 Replace combined wrapper extraction with values-only extraction followed by the evaluated retrieval-batched grounding candidate; remove obsolete wrapper and recursive embedded-anchor paths.
- [x] 3.2 Represent extracting, grounding, ready-ungrounded, and grounding-failure states; retry grounding without rerunning extraction and ignore stale/aborted stage responses.
- [x] 3.3 Display clean values, grounding progress/issues, and grounded navigation while ensuring ungrounded or rejected values create no PDF highlight or Review Decision.
- [x] 3.4 Pin the Source Representation, Schema Revision, and run generation across both model stages and block acceptance after either pinned input changes.

## 4. Persistence and reopen

- [x] 4.1 Replace Extraction DTOs and JSON payloads with `{ result, evidenceLinks }` plus two-step model attribution, with no compatibility decoder or Prisma migration.
- [x] 4.2 Validate scalar result paths, path uniqueness, exact-generation anchor ownership, Review Decision completeness, and occurrence ownership in the existing atomic write.
- [x] 4.3 Reopen clean results, Evidence links, both stage attributions, Review Decisions, and reviewed occurrences against the exact pinned revisions.
- [x] 4.4 Update persistence, endpoint, reopen, ResultValue, EvidenceTab, and application tests for grounded, abstained, duplicate, unknown, foreign-generation, and invalid-path cases.
- [x] 4.5 Replace object-shaped Schema Revision JSON with validated recursive ordered `SchemaNode[]`, return nodes on reopen, initialize the browser without round-tripping through object keys, and reject obsolete stored objects.

## 5. Deterministic verification

- [x] 5.1 Extend the canonical lifecycle Playwright fixture to drive frozen values-only extraction and grounding responses through the UI, accept reviewed links, and verify ungrounded suppression plus fresh-context reopen.
- [x] 5.2 Run the focused Studio tests, deterministic Playwright test with one worker, Studio build, lint, architecture checks, OpenSpec strict validation, and whitespace review.
- [x] 5.3 Add and run a disposable PostgreSQL + real Vite + fresh-browser E2E proving non-alphabetical root and nested SchemaNode order survives JSONB reopen and reaches the values-only model request unchanged.

## 6. Live lifecycle evidence

- [ ] 6.1 Create a disposable PostgreSQL/Prisma and retained-artifact environment, ingest all three shipped examples through the live Parsing Service, and record Zhang as a fail-closed readiness result if strict canonical geometry still prevents publication.
- [ ] 6.2 Run both live model stages serially through real Vite handlers with the exact model tag on every canonical-ready example, capturing per-stage and aggregate performance and correctness evidence.
- [ ] 6.3 Persist one accepted grounded result per successful example and verify clean values, canonical links, review state, and safe highlights after fresh-browser reopen.
- [x] 6.4 Record commands, commits, model identity, raw artifacts, three-example outcomes, performance decision, and residual limits without calling deterministic fixtures full E2E.
