# Grounding Lab

Answers one design question: can a tiered non-LLM pipeline (lexical
containment, then a cross-encoder inside the lexical hit set) replace LLM
evidence grounding when the aim is to catch extractor errors for a reviewer?
Results, verdict and the steps toward production are in
[AUDIT.md](AUDIT.md). Nothing here changes FREE.

## Setup

```
pnpm --filter grounding-lab install:python   # uv sync; torch (CUDA cu130 build, CPU works)
pnpm --filter grounding-lab test             # lexical-tier checks, no torch needed
```

Models download from Hugging Face on first run; revisions are pinned in
`grounding_lab/model_benchmark.py`.

## Datasets

Headline numbers come only from typed-schema sets labeled blind from real
extractor output (`final_dataset_3/`, protocol below). `dataset/`,
`final_dataset/` and `final_dataset_2/` are regression fixtures: their claims
were copied verbatim out of the anchors, so 248 of their 283 linkable claims
cannot produce a wrong link (provenance in
[FINAL_TEST_SOURCES.md](FINAL_TEST_SOURCES.md)). Each `<root>/<doc>/` needs
`anchors.json` and a claims file:

1. Parse with the Parsing Service's own environment (never add Docling here):

   ```powershell
   pnpm --filter parsing-service install:python
   prototypes/parsing_service/.venv/Scripts/python.exe -X utf8 prototypes/grounding_lab/scripts/parse-source.py SOURCE.pdf prototypes/grounding_lab/<root>/<doc>
   ```

2. Dump anchors in FREE's canonical reading order (data cells get row and
   column headers as context, header cells only their own text):

   ```
   pnpm --filter grounding-lab dump-anchors <root>/<doc>/parsed_document.json <root>/<doc>/anchors.json
   ```

3. Write a realistic `schema.json` for the document (example-shaped:
   `"string"`, `0`, `0.0`, `true`, `"1900-01-01"`, `["string"]`), run the real
   extractor with it and turn the output into an unlabeled sheet:

   ```
   pnpm --filter grounding-lab extract-real -- <root> --only <doc>
   .venv/Scripts/python.exe -X utf8 -m grounding_lab.raw_claims <root> --sheet --sample 60
   ```

   `claims_extracted.json` holds one claim per emitted leaf, typed as the
   extractor emitted it, with the record's other scalars as `context` (the
   sibling shape production carries) and `goldAnchorIds: null`.

4. Have someone who has not read this package label the sheet against
   `document.md` and `anchors.json`. `goldAnchorIds` lists every anchor a
   reviewer would accept; `[]` marks an unsupported value, with a note naming
   its kind: (a) never stated, (b) stated under another meaning, (c) computed
   or paraphrased. The labeler never sees the grounding code, its reports or
   earlier labels: the first blind set moved policy E from 97% to 55%, and
   that gap sat in code, not thresholds. Hand-written `claims.json` files
   (`goldAnchorId`, `context`, `expectedLexicalHitIds`) still load.

5. Validate: `pnpm --filter grounding-lab label-review -- <root> --claims claims_extracted.json`
   fails on a gold id missing from `anchors.json`, an unexpected lexical hit on
   a must-abstain claim, and a typed-schema document where fewer than half of
   the unsupported claims occur in the text (a never-stated value only
   measures string inequality).

## Running

```bash
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark final_dataset_3 \
  --stage rerank --retriever mini --reranker nemotron-1b --cv 6 --sibling-gate \
  --claims claims_extracted.json --dump outcomes/run.jsonl
```

Defaults are policy E (`--candidates hitset --claim-mode rich-hitset
--zero-hit abstain`). `--sibling-gate` adds the field check before any
auto-accept; `--cv N` tunes thresholds per fold, `--abstain-threshold` and
`--accept-threshold` fix them; `--dump` writes one outcome per claim
(link-correct, link-wrong, review, abstain) for the reviewer's-view table.
Latency columns are the whole per-claim path after a one-off anchor
normalization per document.

The LLM comparison under the same contract (field name, siblings, hit set)
needs Ollama (`OLLAMA_HOST` for a remote server):

```bash
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_hitset final_dataset_3 qwen3.8:latest --think --claims claims_extracted.json
```

Jina models are non-commercial; Liquid models carry the LFM Open License v1.0
commercial-use threshold. Neither may be promoted without a license review.
