# Grounding Lab

Prototype answering one design question: can a tiered non-LLM pipeline
(lexical containment, then a cross-encoder inside the lexical hit set) replace
LLM evidence grounding with comparable accuracy and an honest confidence per
link? Policy shapes are in [PIPELINES.md](PIPELINES.md), results in
[MODEL_REPORT.md](MODEL_REPORT.md).

Nothing here changes FREE. Productionizing a policy requires an explicit
contract and review-UI change.

## Setup

```
pnpm --filter grounding-lab install:python   # uv sync; torch (CUDA cu130 build, CPU works)
pnpm --filter grounding-lab test             # lexical-tier checks, no torch needed
```

Models download from Hugging Face on first run. Revisions are pinned in
`grounding_lab/model_benchmark.py`.

## Datasets

`dataset/` is the dev/validation split; `final_dataset/` and `final_dataset_2/`
are burned diagnostic inputs used only for cross-validation (provenance in
[FINAL_TEST_SOURCES.md](FINAL_TEST_SOURCES.md)). Each `<root>/<doc>/` needs
`anchors.json` and `claims.json`:

1. Parse with the Parsing Service's own environment (never add Docling here):

   ```powershell
   pnpm --filter parsing-service install:python
   prototypes/parsing_service/.venv/Scripts/python.exe -X utf8 prototypes/grounding_lab/scripts/parse-source.py SOURCE.pdf prototypes/grounding_lab/<root>/<doc>
   ```

2. Dump anchors in FREE's canonical reading order (table cells get row and
   column headers as context):

   ```
   pnpm --filter grounding-lab dump-anchors <root>/<doc>/parsed_document.json <root>/<doc>/anchors.json
   ```

3. Author `claims.json` by hand. Make ~25% unlinkable (`goldAnchorId: null`,
   including near-variant traps) so abstention is measured. `goldAnchorIds`
   lists every anchor a reviewer would accept, `context` holds sibling values,
   and `expectedLexicalHitIds` records an intentional lexical false positive
   without relabelling the claim as supported.

   ```json
   [
     { "value": "1591", "resultPath": ["records", 0, "free_port_year"], "goldAnchorId": "anchor-abc123", "context": "port: Livorno" },
     { "value": "not in the document", "resultPath": ["source"], "goldAnchorId": null }
   ]
   ```

4. Validate: `pnpm --filter grounding-lab label-review` fails on a gold id
   missing from `anchors.json` or an unexpected lexical hit.

## Running the benchmark

```bash
pnpm --filter grounding-lab model-benchmark -- dataset final_dataset final_dataset_2 \
  --stage rerank --retriever mini --reranker nemotron-1b --cv 5
```

The defaults are policy E (`--candidates hitset --claim-mode rich-hitset
--zero-hit abstain`). Without `--cv`, thresholds are tuned on the five dev
documents and reported on the five held-out validation documents. All results
are diagnostic; adoption needs a new frozen set evaluated once from committed
code.

The LLM comparison needs Ollama (`OLLAMA_HOST` for a remote server):

```bash
uv run --no-sync python -X utf8 -m grounding_lab.llm_baseline final_dataset_2 qwen3.8:27b --think
```

Jina models are non-commercial; Liquid models carry the LFM Open License v1.0
commercial-use threshold. Neither may be promoted without a license review.
