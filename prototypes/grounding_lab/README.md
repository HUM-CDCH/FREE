# Grounding Lab

Prototype answering one design question: can a tiered non-LLM pipeline
(lexical containment, then a cross-encoder inside the lexical hit set) replace
LLM evidence grounding with comparable accuracy and an *honest* confidence
score per link?

Nothing here touches FREE. Productionizing needs a contract change: today
`GroundingModelRequest` carries opaque labels and bare values, so field-name
and sibling rendering needs `claim.path` (already in `grounding.ts`) and
per-link confidence needs a field on `EvidenceLink` plus a review-UI decision.
Production `anchorText()` also keeps only the first cell per table row; the
lab bypasses it through `canonicalAnchorInventory`.

## Setup

```
pnpm --filter grounding-lab install:python   # uv sync; torch (CUDA cu130 build, CPU works)
pnpm --filter grounding-lab test             # lexical-tier checks, no torch needed
```

Models download from the HF hub on first run; every revision is pinned in
`grounding_lab/model_benchmark.py` and listed in `MODEL_REPORT.md`. Jina
models are diagnostic only (CC BY-NC) and must not be promoted into FREE.

## Building a dataset

Each `<root>/<doc-slug>/` needs `anchors.json` and `claims.json`. Roots:
`dataset/` (10 docs, 177 claims; dev = the five original docs, validation =
the five added later), `final_dataset/` (100 claims, invalidated as a
one-shot test, `FINAL_TEST_SOURCES.md`) and `final_dataset_2/` (100 claims,
completed one-shot set, now used and diagnostic only,
`FINAL_TEST_SOURCES_2.md`).

1. Parse with the Parsing Service's own environment (never add Docling here):

   ```powershell
   pnpm --filter parsing-service install:python
   prototypes/parsing_service/.venv/Scripts/python.exe -X utf8 prototypes/grounding_lab/scripts/parse-source.py SOURCE.pdf prototypes/grounding_lab/<root>/<doc>
   ```

2. Dump anchors with FREE's canonical reading order (adds table-row context):

   ```
   pnpm --filter grounding-lab dump-anchors <root>/<doc>/parsed_document.json <root>/<doc>/anchors.json
   ```

3. Author `claims.json` by hand. Make ~25% unlinkable (`goldAnchorId: null`,
   including near-variant traps) so abstention is measured; `goldAnchorIds`
   lists every anchor a reviewer would accept; `context` holds sibling values.

   ```json
   [
     { "value": "1591", "resultPath": ["records", 0, "free_port_year"], "goldAnchorId": "anchor-abc123", "context": "port: Livorno" },
     { "value": "not in the document", "resultPath": ["source"], "goldAnchorId": null }
   ]
   ```

4. Validate: `uv run --no-sync python -X utf8 -m grounding_lab.label_review <root>`
   fails on a gold id missing from `anchors.json` or a must-abstain value
   found verbatim, and prints every containment/gold mismatch for review.

## Current policy

`lexical_tier` scans the anchors once. One verbatim hit links with confidence
1.0; zero hits abstain with no neural pass (3/279 linkable claims across the
three datasets remain zero-hit PDF text artifacts); several hits are disambiguated by
`Qwen/Qwen3-Reranker-0.6B` inside that hit set, the claim rendered as
`field name: value`. Confidence is best minus runner-up; a pick whose own
cell text does not contain the value is capped at 0.25 and always reviewed.
The bi-encoder is never loaded. Results: `MODEL_REPORT.md`.

All recorded results are diagnostic. The exact runner used for the second
one-shot set was not preserved in committed code, and that set was later reused
for cross-validation. A production decision requires a new frozen set evaluated
once from committed code; the current datasets also contain no true extractor
paraphrases.

## Running the current policy on dev/validation

```bash
pnpm --filter grounding-lab model-benchmark -- dataset --stage rerank \
  --retriever mini --reranker qwen-0.6b --candidates hitset \
  --claim-mode rich-hitset --zero-hit abstain --split all
```

The five development documents tune thresholds; the five validation documents
report held-out results. Existing final-set and cross-validation runs are
diagnostic reproductions only, not final or adoption evidence.

Older tools, still runnable: `harness` (the Qwen/NLI configs on `dataset`),
`calibrate` (dev sweep of the `lexical+ce` constants) and
`smoke:qwen-0.6b` (resource-gated pinned-model smoke), all via
`pnpm --filter grounding-lab <script>`.
