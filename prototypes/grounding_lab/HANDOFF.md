# Handoff — grounding lab (2026-09-04)

For a new session picking up `prototypes/grounding_lab` on branch
`experiment/radical-context-prune`. Never push or merge this branch.

## State

- Tag `grounding-lab-freeze-2026-09-04` (commit `0af8ff0a`) is the audited
  state. Everything since is uncommitted in the work tree; `git status`
  lists it. The root `tmp/` and `skills-lock.json` are not ours.
- [`AUDIT.md`](AUDIT.md) is the only results document: verdict, the two
  blind sets, the reviewer's-view table, and the numbered steps toward
  production. Start there. [`README.md`](README.md) has the labeling
  protocol and the commands.
- Nothing is running locally or on the Spark.

## What exists

- `grounding_lab/pipeline.py`: lexical tier, sibling gate
  (`gated_lexical_tier`), cached `normalize`, cross-encoder and NLI scorers.
  Policy E reproduces with the gate off.
- `grounding_lab/model_benchmark.py`: `--sibling-gate`, `--cv`, `--claims`,
  `--dump`; whole-path latency with p95 and per-document index ms.
- `grounding_lab/raw_claims.py --sheet [--sample N]`,
  `grounding_lab/label_review.py` (abstention rule for typed-schema
  documents), `grounding_lab/llm_hitset.py --claims` (LLM under E's
  contract), `scripts/extract-real.mts` (uses `schema.json` when present).
- `final_dataset_3/<doc>/`: `schema.json`, hand labels `claims.json`,
  extractor labels `claims_extracted.json` with `labeling_notes.md`,
  `extracted_raw.json` and `extracted_meta.json`, the parsed document and
  anchors. `LABELS.md` documents both label sets.
- Reports kept: `EXTRACTED_*.md` (headline runs), `RAW_EXTRACTION_BLIND.md`,
  `outcomes/*.jsonl` (per-claim outcomes). Everything about the retired
  fixtures and rejected policies was deleted on 2026-09-04; the numbers that
  matter are in `AUDIT.md`, the files are in git history before that date.

## Open for the user

- Commit or not; nothing is staged.
- `final_dataset_3/*/document.md`, `parsed_document.json`, `anchors.json`
  are full-text derivatives of six copyrighted catalogues (PDFs in the
  git-ignored `final_sources_3/`). Drop them if that is too much; labels and
  schemas stand alone.
- Labeler conventions a stricter reading would flip are listed at the end of
  `final_dataset_3/LABELS.md`.

## Infrastructure

- From `prototypes/grounding_lab`, python is `.venv/Scripts/python.exe -X utf8`;
  `pnpm --filter grounding-lab <script>` paths are relative to the package.
- Local Ollama `http://127.0.0.1:11434` serves `qwen3.8:latest` (27B Q4) on
  one RTX 4090 24 GB and cuts every prompt at 16k tokens; large documents are
  windowed by `extract-real`. Nemotron 1B fits alongside it.
- DGX Spark Ollama: `OLLAMA_HOST=http://spark.cdch-dgxspark.lan.ku.dk:11434`,
  model `qwen3.8:27b`, 262k context, about 12 s per claim with thinking.
- Parsing a new PDF: `prototypes/parsing_service/.venv/Scripts/python.exe -X utf8
  scripts/parse-source.py SOURCE.pdf <root>/<doc>` then `pnpm --filter
  grounding-lab dump-anchors <root>/<doc>/parsed_document.json
  <root>/<doc>/anchors.json`. OCR of a 50-page scan takes 15–25 minutes.
- `label_review` needs `expectedLexicalHitIds` on unsupported claims with
  lexical hits; fill them mechanically after labeling.

Memory note for future sessions: `grounding-lab-audit-2026-09` in the
project memory index.
