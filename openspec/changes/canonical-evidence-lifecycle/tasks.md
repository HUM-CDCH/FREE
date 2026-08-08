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

- [x] 4.1 Reject unsafe occurrence geometry at the strict v2 boundary and
  render page-bounded displayed-page geometry, including normalized boxes on
  rotated pages.

## 5. Verification

- [x] 5.1 Run database, focused backend, Studio test/build, and deterministic
  Playwright checks.
- [x] 5.2 Pass canonical v2 source context to one local-Ollama extraction, return
  canonical anchor IDs, and run it through real Vite/Prisma/browser persistence;
  report the exact model tag.
  Model tag `hf.co/numind/NuExtract3-GGUF:Q4_K_M` (Ollama model ID
  `51cdf1189a0f`, raw NuExtract route) over `Beretning_Ellekilde_8_13.pdf` at
  runtime commit `d12567f`: the persisted `parsed_document.v2` had 6 pages, 98
  blocks, 13 tables, 328 anchors, and 328 occurrences. The tolerantly recovered
  result contained 7 distinct canonical anchor IDs; PostgreSQL stored one
  successful Extraction, 7 Review Decisions, and 7 reviewed occurrences against
  the pinned Schema and Source Representation revisions. A fresh Chrome tab
  reopened all 7 reviewed anchors, rendered the selected occurrence as one PDF
  highlight, and suppressed 0 reviewed geometries. The exact model response did
  not satisfy the requested extraction shape: it produced a nested 512-item
  payload with 7 grounded values, so lifecycle persistence passed while strict
  model-shape quality did not. Full evidence and execution-target limits are in
  `live-e2e-evidence.md`.
