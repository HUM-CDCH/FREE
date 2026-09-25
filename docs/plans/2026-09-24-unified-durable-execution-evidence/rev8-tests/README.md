# Rev-8 scheduling tests on the Spark (2026-09-25)

Run on baratheon against the live production vLLM servers (`ocr_model`, `nuextract_model`, `extraction_model`,
each `--max-num-seqs 4`). Each run used a throwaway container of the `free-parsing_worker` image on `free_app`,
with the model cache read-only, `HF_HUB_OFFLINE=1`, and kei's own code (`ocr.resolve` + `kie.runner.convert`;
`extract()` routed through `chats_for`). No production container was restarted or changed. The OCR server
was idle before every run. The Spark ran kei at 36d9f50, identical to 2605692 for `parsing_service/src`.

Files: `ocr_contention.py` / `run.sh` (OCR), `extract_contention.py` / `run_extract.sh` (extraction),
`make_catalogues.py` (synthetic catalogues), `analyze.py` (phase breakdown), `compare_records.py` (record
diffs), `results/` (reports; `*.samples.json` hold the 0.5 s metric samples).

Documents:
- The book is `book40.pdf`: 20 real scans (Hojbakkegaard) plus the same 20 padded by a few pixels so vLLM
  cannot reuse cached image prefixes. It has 40 pages and 73 crops.
- The small document is `small3.pdf` (3 scanned pages, 3 crops).
- The first synthetic book, with rasterized text pages, failed kei's cut ("layout gap … has no ink-free run"
  on page 23) and was discarded.

## OCR (Studio's settings: surya, cut=auto, page_source=pdf)

| Scenario | Small doc | Book | vLLM waiting during OCR (mean/max) |
|---|---|---|---|
| small alone | 32.8 s | – | 0 / 0 |
| book alone, Surya default | – | 254 s (cut 108, OCR 146) | 20.5 / 28 |
| book alone, `SURYA_INFERENCE_PARALLEL=4` | – | 250 s (cut 108, OCR 142) | 0 / 0 |
| book alone, parallel 3 / 2 / 1 | – | 290 / 365 / 688 s | 0 / 0 |
| small injected 30 s into book OCR, default | **99.8 s** | 306 s | 21.6 / 31 |
| small injected 30 s into book OCR, parallel 4 | **40.8 s** | 275 s | 0.55 / 3 |
| small injected 30 s into book OCR, parallel 3 | 38.7 s | 307 s | – / 2 |
| small injected 5 s into book *cut*, parallel 4 | **33.8 s** | 269 s (cut 124) | 0 / 0 |

- Surya's default thread count is 32: `_gpu_settings("4090")`, since FREE sets neither `VLLM_GPU_TYPE` nor
  `SURYA_INFERENCE_PARALLEL`. Setting it to 4 costs the book nothing, and it cuts a small document's added
  wait from +67 s to +8 s.
- No KV-cache pressure: peak 10%, no preemptions.
- Two conversions in one process didn't collide during cutting. The document-wide pdfium lock
  (`surya.py:236`) belongs to the `cut=none` path; `cut=auto` renders page by page.
- Cutting runs serially on the CPU at about 2.7 s per page before any OCR request, which is about 90 min for
  a 2000-page book.

## Extraction (synthetic Catalog: 200 entries, 25 spreads; small: `continuations`, 4 entries)

| Scenario | Small | Big Catalog | Server concurrency |
|---|---|---|---|
| small Catalog alone | 8.5 s | – | NuExtract 1 |
| small Article alone | 13.8 s | – | Qwen/NuExtract 1 |
| big Catalog alone | – | 434 s, 200/200 records | NuExtract mean 0.97, max 1 |
| small Catalog injected 60 s into big | 7.75 s | 433 s | NuExtract max 2 |
| small Article injected 60 s into big | 22.2 s | 443 s | NuExtract max 2 |
| big split into 4 parallel chunks | – | **106 s** (4.1×) | NuExtract mean 3.82 |
| big split into 4 chunks, sequential | – | 434 s | NuExtract max 1 |

A Catalog extraction sends one request at a time (`grounded.py:190-195`), so it leaves 3 of NuExtract's 4
slots idle.

Records compared by `entry_no` over five fields:

| Pair | Entries differing |
|---|---|
| unsplit vs unsplit (3 runs, pairwise) | 0–1 |
| unsplit vs sequential split | **0** |
| unsplit vs parallel split | 19–21 |
| parallel split vs parallel split | 7 |

- Splitting preserves the prompts: headings and glossary stay whole, and every `bezirk`/`kreis` matched.
- The harness's split (`extract_contention.py split`) takes two shortcuts that the M3 design removes. It
  restarts entry numbering in each chunk, which affects only issue/call record indexes. It also runs the
  document-level call once per chunk; the test schema has no document fields, so that call made no
  request and did not affect the results.
- The differences come from vLLM batching several requests together. They are all borderline `fundart`
  values: trailing dots, or null against a value, in both directions.
- Any concurrency on one server can therefore change borderline answers.
- `VLLM_BATCH_INVARIANT=1` was tried on a second NuExtract server beside production, from the same image and
  arguments, with a lower memory cap (`rev8-nuextract-bi`, removed afterwards). vLLM 0.29.1rc1 failed at startup
  with `RuntimeError: VLLM batch_invariant mode is not supported for GDN_ATTN`. Both extraction models are
  `Qwen3_5ForConditionalGeneration` with gated-delta-net (linear attention) layers: NuExtract3-FP8 24 of 32,
  Qwen3.8-27B-FP8 48 of 64. Neither can use the mode, so the variation stays; the user accepts it.

## Not tested

- Mixed OCR recipes in one process. Only one Surya record exists, so `configure()` can't conflict today.
- `page_source=ingest` spreads.
- Studio chat and schema generation hitting `extraction_model` during kei extraction.
- Failures, deadlines, cancellation and cleanup. These need the DBOS implementation.
- Books near 2000 pages.
