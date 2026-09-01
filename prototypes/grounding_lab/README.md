# Grounding Lab

Prototype answering one design question: can a tiered non-LLM pipeline
(lexical match → bi-encoder shortlist → cross-encoder / NLI scoring) replace
LLM evidence grounding with comparable accuracy and an *honest* confidence
score per link?

Nothing here touches FREE. Productionizing is NOT a one-line swap: the
current `GroundingModelRequest` carries only opaque labels and bare scalar
values, so the rich claim rendering (field name + sibling context) needs a
contract change (feasible — `grounding.ts` already holds `claim.path`), and
per-link confidence needs fields on `GroundingSelection`/`EvidenceLink` plus a
persistence/review-UI decision. The harness therefore reports `-bare` config
variants that use only what the contract carries today. Still open before a
production decision: tier-specific gates calibrated on held-out documents.

## Setup

```
pnpm --filter grounding-lab install:python   # uv sync — downloads torch (CUDA cu130 build; runs on CPU too)
pnpm --filter grounding-lab test             # lexical-tier self-check, no torch needed
```

Models (multilingual — documents include Danish/German and historical English)
download from the HF hub on first harness run; ids are constants at the top of
`grounding_lab/pipeline.py`.

## Building the dataset

Each `dataset/<doc-slug>/` needs `anchors.json` and `claims.json`.

1. Run the parsing service (`pnpm --filter parsing-service dev`), parse 2–3
   Source Documents from `examples/` (pick one Danish/German, one historical
   English), and
   save each result as `dataset/<doc-slug>/parsed_document.json`. Old fixtures
   under `.omo/worktrees/` are pre-v2 schema and will not decode.
2. Dump anchors (uses FREE's canonical reading order, avoiding the
   `anchorText()` table-cell quirk in `packages/extraction/src/grounding.ts`):

   ```
   pnpm --filter grounding-lab dump-anchors dataset/<doc>/parsed_document.json dataset/<doc>/anchors.json
   ```

3. Author `dataset/<doc>/claims.json` by hand (run one extraction in studio
   for realistic claims, or draft from the Source Document, then verify each
   gold anchor against the document). Make ~20% of claims unlinkable
   (`goldAnchorId: null`) so abstention is measured.

   ```json
   [
     {
       "value": "1.234,56",
       "resultPath": ["records", 0, "total_weight"],
       "goldAnchorId": "anchor-abc123",
       "note": "table cell, page 3"
     },
     { "value": "not in the document", "resultPath": ["source"], "goldAnchorId": null }
   ]
   ```

## Running

```
pnpm --filter grounding-lab harness
```

Prints a markdown report: per-config accuracy@1 / correct-abstain / latency,
a calibration table (score buckets × precision — the confidence question),
and a per-claim breakdown showing which tier resolved each claim.

```
pnpm --filter grounding-lab calibrate
```

Prints CALIBRATION.md content: dev/held-out split (dev = the five original
documents the policy constants were tuned on), a dev-only sweep of the
constants (shortlist K, abstain gate, containment cap, auto-accept), held-out
numbers at chosen vs incumbent constants, and shortlist recall@K.

Configs: `lexical`, `lexical+ce`, `lexical+nli`, their `-bare` variants
(claim rendered as the bare value only — what the production contract carries
today), and `ce-only` / `nli-only` (which skip tier 1 to measure what the
lexical tier is worth).

```
pnpm --filter grounding-lab label-review
```

Validates all evaluated documents (fails on a gold id missing from anchors.json
or a must-abstain value found in the document), reports every complete
containment/gold mismatch for human review, and prints the LABEL_REVIEW.md skim
sheet.

## Comparing neural models

`model-benchmark` loads exactly one pinned retriever and, when requested, one
pinned reranker per process. The existing five development documents tune the
score/auto-accept gates; the five documents named in `calibrate.py` are
validation only.

```bash
pnpm --filter grounding-lab model-benchmark -- dataset \
  --stage retrieval --retriever qwen-0.6b --split all

pnpm --filter grounding-lab model-benchmark -- dataset \
  --stage rerank --retriever qwen-0.6b --reranker qwen-0.6b \
  --claim-mode bare --split all --output MODEL_REPORT.md
```

Retriever keys: `mini`, `qwen-0.6b`, `qwen-4b`, `qwen-8b`, `jina-v5`, and
`jina-colbert`. Reranker keys: `bge`, `qwen-0.6b`, `qwen-4b`, `qwen-8b`, and
`jina-v3.5`. Jina models are diagnostic only under CC BY-NC; their pinned
revisions must not be promoted into FREE. The pinned Jina v3.5 `modeling.py`
was inspected before enabling custom code, and the runner injects a tokenizer
loaded from the same revision to prevent an unpinned fetch.

Select the top two retrievers by recall@30 (recall@10 then latency break ties),
compare their rerankers, and run `--claim-mode rich` only for the winning pair.
For a one-shot final dataset, pass `--split final` plus the frozen
`--abstain-threshold` and `--accept-threshold`; final runs never calibrate.
