# Live lifecycle evidence — 2026-08-08

## Execution target

- Runtime code commit: `d12567fe8c1b4c3d6639b453067acb5ec7648ebf`
- Branch: `codex/issue-72-canonical-evidence-lifecycle-core`
- Host: Windows; local Parsing Service, Vite Studio, Docker PostgreSQL, and
  Ollama. Spark was intentionally not used for this run.
- Exact model tag: `hf.co/numind/NuExtract3-GGUF:Q4_K_M`
- Ollama model ID: `51cdf1189a0f`
- Disposable database: `free_issue72_d12567f_q4km_20260808_0955`
- Source: `Beretning_Ellekilde_8_13.pdf`

## Real parse and canonical source

The PDF was ingested through the live Parsing Service and the resulting Source
Representation Revision was stored in PostgreSQL with contract
`parsed_document.v2`, artifact reference
`b6311be2-07fa-429a-9b4c-e4e4f26def1a`, and artifact SHA-256
`418b66f954aa27ee93ff409760ad7e22e9ca0b5d498ef72a15a1d9e8d44d910b`.

| Measure | Result |
| --- | ---: |
| Physical pages | 6 |
| Canonical blocks | 98 |
| Logical tables | 13 |
| Evidence anchors | 328 |
| Evidence occurrences | 328 |
| Invalid published geometries | 0 |
| Rotated-page occurrences | 0 |

Parser diagnostics were 14 `camelot_candidate_rejected`, 12
`continuation_rejected`, and 1 `continuation_reviewed`.

## Extract, persist, reopen, and render

Studio routed extraction through local Ollama with the exact model tag above.
The explicit browser review action wrote Extraction
`5a2368db-1376-43ea-807c-882dd7c22417` as `SUCCEEDED`, pinned to Schema Revision
`52000000-0000-4000-8005-000000000001` and Source Representation Revision
`51000000-0000-4000-8002-000000000001`.

PostgreSQL contained exactly:

- 1 successful Extraction with model attribution
  `ollama / hf.co/numind/NuExtract3-GGUF:Q4_K_M`;
- 7 distinct result anchor references;
- 7 Review Decision rows for 7 distinct canonical anchors; and
- 7 reviewed occurrence IDs, all owned by those anchors.

The generation tab changed to `Review saved`. After closing it, a new Chrome tab
loaded the document route from scratch and showed `Status: ready`, `Review
saved`, and 328 source anchors. It reopened all 7 reviewed anchors. Selecting a
reviewed anchor rendered exactly 1 `.parsed-evidence-focus` overlay on the PDF.
All 7 reviewed occurrences had safe geometry, so reviewed geometry suppression
was 0.

## Honest limits

- The exact Q4_K_M response did not satisfy the requested extraction schema. It
  produced a nested 512-item payload; Studio's tolerant recovery reported 3,065
  fields, 3,051 missing fields, and 7 grounded values. The lifecycle contract
  passed for those 7 canonical references, but strict model-shape and extraction
  quality did not pass.
- The seed ingested 2 Source Representations and rejected 1. The Zhang source
  failed closed with `v2_evidence_geometry_unavailable` because one text block
  had no producer geometry. No unsafe or geometry-less v2 occurrence was
  published.
- This run proves the local Windows/Ollama execution target requested here. It
  does not prove Spark or another crossed provider/host target.
- Chrome completed the live UX flow and visual geometry check. The separate
  Windows computer-use controller could not enumerate windows and returned
  `EnumWindows failed: Impossibile trovare il percorso specificato.
  (0x80070003)`; it is not counted as a successful gate.

## Verification gates

- Parsing Service: 154 passed, 3 skipped, 15 subtests passed.
- Database package: 5 passed.
- Studio changed-test set: 177 passed, 2 skipped.
- Studio full suite: 335 passed, 2 skipped, 1 pre-existing Windows-only failure
  in `_model_config.test.ts` (`0600` expected, `0666` observed); the same focused
  test fails on untouched `dev`.
- Studio lint and production build: passed.
- Deterministic Playwright lifecycle: 1 passed.
- Strict OpenSpec validation for `canonical-evidence-lifecycle`: passed.
- Repository-wide strict OpenSpec validation: 21 passed, 2 unrelated existing
  changes failed (`multi-color-schema-fields`, `schema-node-persistence`).
