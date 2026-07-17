# Port extraction pipeline verification

Date: 2026-07-17

## Deterministic red/green evidence

Focused tests were introduced before production changes.

- Canonical table matcher RED: `pnpm --filter studio exec vitest run api/_table_evidence.test.ts` failed because `api/_table_evidence.ts` did not exist. GREEN: table Evidence and traversal suites passed (19 tests), followed by endpoint coverage.
- Highlight projection/PDF matcher RED: `pnpm --filter studio exec vitest run src/EvidenceHighlightLayer.test.ts src/pdfTextMatching.test.ts` failed on both scalar-array cases and the missing matcher module. GREEN: 11 tests passed.
- Provider/metadata RED: `pnpm --filter studio exec vitest run api/_model.test.ts api/_catalog.test.ts api/_provider.test.ts` failed on `AI_NUM_CTX` serialization/validation and complete Catalog metadata propagation. GREEN: 41 tests passed.
- Combined focused repair regression: 8 files and 85 tests passed after adding
  regression coverage for Catalog coordinate-only Evidence, unresolved table
  pages, mixed scalar arrays, SequenceMatcher parity, Codex metadata-channel
  separation, and structural Article table inventory.

## Required deterministic checks

- `pnpm --filter studio lint` — passed.
- `pnpm --filter studio test` — passed: 17 files passed, 2 opt-in live files skipped; 117 tests passed, 2 skipped (re-run after review fixes, including two new Catalog grounding tests).
- `pnpm --filter studio build` — passed; Vite emitted only its existing chunk-size advisory.
- `openspec validate port-extraction-pipeline --strict` — passed: change is valid.

## Explicit live lanes (outside CI)

### Catalog — local Ollama Q4_K_M

Prerequisites found: Ollama reachable at `http://127.0.0.1:11434`; official `hf.co/numind/NuExtract3-GGUF:Q4_K_M` installed.

Command (no secrets):

```bash
RUN_NUEXTRACT_CATALOG_SMOKE=1 AI_PROVIDER=ollama AI_MODEL=hf.co/numind/NuExtract3-GGUF:Q4_K_M AI_NUM_CTX=32768 pnpm --filter studio exec vitest run api/extract.catalog.smoke.test.ts
```

Result: **passed** in 125.59 seconds on the current review-fix run. An earlier run failed the retained Evidence assertion because NuExtract inconsistently omitted the `Grav_id` snippet for one record (`snippets: []`) while extracting the value correctly. Root cause fixed in `api/_catalog.ts`: a deterministic per-section grounding pass now derives a verbatim snippet from the record's own section when the model omits or fails to ground one, and leaves snippets empty when the value is absent from the section (so hallucinated or metadata-leaked values never receive fabricated Evidence). The fix is covered offline by a captured-output fixture test (`api/test-fixtures/catalog-model-missing-evidence.json`) and specified in `specs/catalog-extraction/spec.md`; the passing live run confirmed source-ordered Grav IDs, no Grav 17 metadata leakage, and verbatim retained Evidence for every record.

### Article — authenticated Codex CLI

Prerequisites found: Codex CLI 0.144.5; authenticated with ChatGPT. Provider/model profile: `codex-cli` / `gpt-5.6-sol`.

Command:

```bash
RUN_ARTICLE_SMOKE=1 AI_PROVIDER=codex-cli AI_MODEL=gpt-5.6-sol pnpm --filter studio exec vitest run api/extract.article.smoke.test.ts
```

Result: **passed** in 15.77 seconds on the current repair-verification run. One Article call returned schema-shaped values and canonical table Evidence at page 1, table 1, row 1, column 1.

Spark Ollama was not attempted because no Spark endpoint configuration was available. It is an optional alternative Article lane, not a substitute for the required Catalog lane.

## Manual PDF-viewer QA

Not completed: this coding session has no interactive browser/PDF-viewer surface. No manual pass is claimed. Deterministic tests cover scalar-array page inheritance, complete numeric-token matching (`7` does not match `17`), and hyphenated collisions (`8-2` does not match `28-29` or `8-20`). Task 6.8 remains unchecked until interactive QA is performed.
