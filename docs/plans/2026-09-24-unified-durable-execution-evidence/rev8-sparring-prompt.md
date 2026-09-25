# Sparring round: a simpler kei scheduling plan

You are a sparring partner, not a rubber stamp. Attack the proposal below,
argue the other side where it's stronger, and say what you would do instead.

**Rules:** read-only. Don't edit files. Don't run git commit, stash, reset or
checkout. Don't run `pnpm` scripts or installs. You may run Python with
`uv run` from a scratch directory under /tmp.

**Write for a busy human who found the last review too dense.** Use plain
words, short sentences and no unexplained jargon. Put a 5-line summary at the
top and keep the whole answer under about 700 words. Cite file:line only where
it proves a point.

## The user's goal

FREE runs on one DGX Spark. While a big scanned book (up to 2000 pages) is
being OCR'd, the same user or another user should be able to ingest a small
document and extract values from it without waiting for the book. Pausing or
stopping jobs is not a goal.

## Facts already checked against the code

- `compose.gpu.yaml`: one vLLM server per role, each with `--max-num-seqs 4`
  and a fixed KV-cache budget. `ocr_model` (Surya) serves ingestion.
  `nuextract_model` and `extraction_model` (Qwen) serve extraction. Studio's
  schema chat and generation call `extraction_model` directly, outside kei.
- kei OCR sends every region of a whole document to one Surya call inside one
  step (`prototypes/parsing_service/src/kei_exp/transcription/surya.py:280-296`).
  Surya's thread count is `min(_max_num_seqs, 96)`, and `_max_num_seqs` comes
  from a GPU-type table (default `VLLM_GPU_TYPE=4090`, giving 32), not from the
  server (`.venv/lib/python3.13/site-packages/surya/inference/backends/vllm.py:101-113`).
  FREE sets neither `VLLM_GPU_TYPE` nor `SURYA_INFERENCE_PARALLEL`, so a book
  sends up to 32 requests at once to a server that runs 4.
- The DBOS plan (`docs/plans/2026-09-24-unified-durable-execution.md`, 7th
  revision) has one kei queue with global and worker concurrency 1 for
  `convert`, `extract` and `deleteRuns` (line ~639). `deleteRuns` relies on
  that one-at-a-time rule to never overlap a cancelled step that's still
  running (~603-607).
- `write_result` mints a new result generation and deletes page files outside
  its selection (`src/kei_exp/result.py:237`).
- `has_native_text` is a whole-document decision (`transcription/native.py:33`).
- The browser uploads one file at a time per tab
  (`prototypes/studio/src/sourceIngestionMachine.ts:138-145`).
- DBOS 3.1.0: global and partition limits count PENDING rows in the database,
  so a cancelled job frees its slot at once while its thread may still run.
  Worker concurrency counts in-memory executions. The source is at
  `/home/gennaro/.cache/uv/archive-v0/Ioue0ILjYWbCsz5L/lib/python3.14/site-packages/dbos/`.

A previous review rejected a per-page fan-out design: page children would each
call `write_result`, a parent job would hold a slot in its own queue, and
cancel, deadlines and cleanup would need redesigning. That review also found
DBOS partitions give only random per-user fairness.

## The new proposal to attack

1. **Three kei queues, each with global and worker concurrency 1:**
   `kei-convert-big` (documents over N pages), `kei-convert-small` (N pages or
   fewer), and `kei-extract`. There is no per-page fan-out; `convert` stays one
   job per document.
2. **Set `SURYA_INFERENCE_PARALLEL=4`.** Claim: a book then never has more
   than 4 requests at `ocr_model`, all of them running. A small document's
   request waits in vLLM's first-come-first-served queue and gets the next free
   spot, about one book page later. The book slows down only while the small
   document runs.
3. **Cleanup** of cancelled or uncertain runs is deferred until the next kei
   process boot, reusing the plan's restart cutoff (~620). The per-process
   flock stays.
4. **Open decisions:** whether the browser allows two uploads at once or
   "use another tab" is acceptable, and the value of N.
5. **Accepted limitation:** two big books don't share. The second waits for
   the first.

## Questions

1. Does claim 2 hold? Consider vLLM's default scheduling policy, KV-cache
   pressure and preemption with a 4G KV budget and `--max-model-len 24576`,
   Surya's retries and layout fallback (extra requests per image), streaming,
   and the CPU work (cutting, layout, rendering) that runs before and between
   requests. How long could a small document really wait?
2. Where does the size decision happen? Studio queues `convert` before kei's
   `prepare` step counts pages. Is the page count available at admission, and
   what about reprocessing?
3. Is "big vs small by page count" the right split, or would
   "interactive vs background", or something else, serve the goal better?
4. What breaks when two conversions run at once in one kei process? Consider
   Surya's global mutable settings (`configure()` in `surya.py:215`), pdfium
   locks, memory, the run directory and the flock.
5. Is deferring cleanup to the next boot acceptable, or does it leak disk on a
   machine that rarely restarts?
6. Strongest argument **for** the per-page design over this one, and whether
   it's worth its cost now.
7. Your recommendation, and the 3–5 tests on the Spark that would decide it.
