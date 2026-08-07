## 1. Deterministic lifecycle test

- [x] 1.1 Add one deterministic intercepted browser fixture using the Ellekilde
  semantic golden and fixed accepted row `24-1`.

## 2. Canonical document boundary

- [x] 2.1 Make `/document` and `/source` return the same strict v2 payload and
  remove stale `/parsed-document` expectations.
- [x] 2.2 Give canonical text and table-cell occurrences deterministic owned
  IDs, retaining every table-cell producer observation.
- [x] 2.3 Pass the complete strict v2 DTO through Studio Source Representation
  and anchor projection without a v1 shape.

## 3. Persistence and reopen

- [x] 3.1 Add `ProjectStore`'s atomic successful Extraction plus Review Decision
  write with reviewed-occurrence ownership validation.
- [x] 3.2 Return Review Decision anchor selections from exact-revision reopen and
  verify them in a fresh browser session.
- [x] 3.3 Wire an explicit browser review action that posts the accepted result
  and the Schema Revision used for extraction.

## 4. Browser rendering

- [x] 4.1 Resolve reopened anchors and render only valid unrotated geometry,
  suppressing invalid or rotated boxes.

## 5. Verification

- [x] 5.1 Run database, focused backend, Studio test/build, and deterministic
  Playwright checks.
- [x] 5.2 Pass canonical v2 source context to one local-Ollama extraction, return
  canonical anchor IDs, and run it through real Vite/Prisma/browser persistence;
  report the exact model tag.
  Model tag `hf.co/numind/NuExtract3-GGUF:latest` (Ollama, raw NuExtract route)
  over `Beretning_Ellekilde_8_13.pdf` (328 canonical anchors, 6 pages): 33 of 33
  cited labels resolved to published anchors, one Extraction and 33 Review
  Decisions were written to PostgreSQL against the pinned Schema Revision, and a
  fresh browser session reopened all 33 anchors — the one reviewed occurrence
  with valid geometry rendered, the rest resolved without geometry.
