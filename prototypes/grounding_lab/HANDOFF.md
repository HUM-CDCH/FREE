# Handoff — grounding lab audit (2026-09-04)

For a new session picking up `prototypes/grounding_lab` on branch
`experiment/radical-context-prune`. Never push or merge this branch.

## State

- Code frozen at tag `grounding-lab-freeze-2026-09-04` (commit `0af8ff0a`);
  one follow-up commit `d5b24e8b` adds a Spark result. Work tree clean apart
  from the root `tmp/` and `skills-lock.json`, which are not ours.
- `grounding_lab/pipeline.py` is unchanged since the freeze. Everything else
  added is listed under Files.
- Nothing is running locally or on the Spark.

## Verdict (details in `AUDIT.md`)

Policy E's 372/382 in `MODEL_REPORT.md` is a labeling artifact: claims were
verbatim anchor strings, 187/283 were unverified single lexical hits, only 35
claims could score wrong. Measured elsewhere:

| test | policy E |
|---|---|
| 40 single-hit traps (value present once, wrong field) | 34 wrong at confidence 1.0 |
| blind set `final_dataset_3`, 164 typed claims | 91/164 correct, 37 wrong, auto precision 72/109 |
| real extractor output, 597 raw claims | 3% zero-hit, 54% single-hit unverified, 42% multi-hit |

Also: 28 of the LLM baseline's 33 wrong links were a `dump-anchors` bug
(header cells carried the whole row in `context`), fixed; after the fix the
LLM makes 3 wrong on final_dataset_2 (Spark, original model). The LLM used as
E's scorer equals E-Nemotron on the original sets (372/382) and beats it on the
blind set (114/164) only because it can answer NONE inside a hit set.

## Files added or changed

| path | what |
|---|---|
| `AUDIT.md` | summary and verdict, start here |
| `TRAPS.md`, `<doc>/traps.json`, `TRAPS_*_NEMOTRON.md` | traps and E/H/LLM results |
| `RAW_EXTRACTION.md`, `scripts/extract-real.mts`, `grounding_lab/raw_claims.py`, `<doc>/template.json`, `extracted_raw.json`, `extracted_meta.json` | real extractor run and grounding of its output |
| `LLM_HITSET.md`, `grounding_lab/llm_hitset.py`, `scripts/dump-anchors.mts` (+ test), all `anchors.json` regenerated | rendering fix and LLM-as-scorer |
| `final_dataset_3/` (`LABELS.md`, per doc `schema.json`, `claims.json`, `anchors.json`, `document.md`, `parsed_document.json`), `BLIND_*.md` | blind set and results |
| `SPARK_LLM_BASELINE_final2.md` | Spark rerun with fixed anchors |
| `grounding_lab/harness.py`, `model_benchmark.py`, `llm_baseline.py`, `label_review.py` | `--claims file1,file2` merged loader; `--only doc1,doc2` on `llm_baseline` |
| `.gitignore` | ignores `final_sources_3/` (copyrighted scans) and `*.log` |

## Open decision for the user

`final_dataset_3/*/document.md`, `parsed_document.json` and `anchors.json`
are full-text derivatives of six copyrighted grave catalogues supplied by the
user. They are committed; the PDFs are not. If that is too much, drop the text
files and keep `schema.json`, `claims.json`, `LABELS.md`.

## How to run things

From `prototypes/grounding_lab`, python is `.venv/Scripts/python.exe -X utf8`.
`pnpm --filter grounding-lab <script>` paths are relative to the package dir,
not the repo root.

```bash
pnpm --filter grounding-lab test                     # 65 python + 2 node tests
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark final_dataset_3 --stage rerank --retriever mini --reranker nemotron-1b --split all --abstain-threshold -9.375 --accept-threshold 0.5625
.venv/Scripts/python.exe -X utf8 -m grounding_lab.model_benchmark dataset final_dataset final_dataset_2 ... --claims claims.json,traps.json
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_hitset final_dataset_3 qwen3.8:latest --think
.venv/Scripts/python.exe -X utf8 -m grounding_lab.llm_baseline final_dataset_3 qwen3.8:latest --think --only doc1,doc2
pnpm --filter grounding-lab extract-real -- dataset final_dataset final_dataset_2
```

Frozen thresholds `-9.375 / 0.5625` are fold 2–5 values from the Nemotron
5-fold run; fold 1 differs (−∞ / 0.75).

Parsing a new PDF: `prototypes/parsing_service/.venv/Scripts/python.exe -X utf8
scripts/parse-source.py SOURCE.pdf <root>/<doc>` then `pnpm --filter
grounding-lab dump-anchors <root>/<doc>/parsed_document.json
<root>/<doc>/anchors.json`. OCR of a 50-page scan takes 15–25 minutes.

## Infrastructure notes

- Local Ollama `http://127.0.0.1:11434` serves `qwen3.8:latest` (27B Q4) on
  one RTX 4090 24 GB. It granted only 16k–45k context to the extractor under
  load; large documents were windowed (see `RAW_EXTRACTION.md`). Nemotron 1B
  fits alongside it.
- DGX Spark Ollama: `OLLAMA_HOST=http://spark.cdch-dgxspark.lan.ku.dk:11434`,
  model `qwen3.8:27b`, 262k context. About 12 s per claim with thinking on the
  full-document baseline; the user stopped the long runs. Documents over 262k
  prompt tokens (desnz, us-census, the 9906-anchor `buchvaldek-1970` tables)
  fail with Ollama 500 "no user query found".
- `label_review` requires `expectedLexicalHitIds` on unsupported claims that
  have lexical hits; for the blind set these were filled mechanically after
  labeling, they are bookkeeping, not labels.
- Blind claims must be scalars; list-valued fields were split into one claim
  per element (production `populatedContentPaths` shape).

## Recommended next steps (from `AUDIT.md`)

1. Relabel `final_dataset_3` from real extractor output instead of hand
   values; retire the three original sets from headline numbers.
2. Add a sibling-context gate before any single-hit auto-accept and measure
   E, H and the gated variant on the blind set only.
3. Give the scorer an abstain option inside hit sets.
4. Check whether production `anchorText()` in `packages/extraction/src/grounding.ts`
   has the same row-context leak that `dump-anchors` had.

Memory note for future sessions: `grounding-lab-audit-2026-09` in the
project memory index.
