# Review brief: proposed 8th revision of the DBOS plan (kei scheduling and fairness)

You are an adversarial reviewer. **Read-only**: do not edit files, do not run
git commit/stash/reset/checkout, and do not run `pnpm` scripts or installs.
You may run Python with `uv run` from a scratch directory outside the repo.

## Goal (the user's, 2026-09-25)

FREE runs on one DGX Spark. The user wants DBOS to calibrate its workload:

- A big upload (a scanned book up to 2000 pages) is OCR'd with 4 concurrent
  vLLM calls.
- Meanwhile the same or another user must be able to ingest a small document
  and extract values from it without waiting for the book.
- Two users uploading books at once should share the machine fairly.
- Pausing or stopping running jobs is **not** a goal.

## Context you need

- Plan: `docs/plans/2026-09-24-unified-durable-execution.md` (7th revision,
  commit 2605692). Key places: the queue table (line ~639), the kei worker
  (~669-700), cancellation and physical exclusion (~540-567), `deleteRuns`
  (~598-607), non-goals (~1564: "kei lanes, page-class priority, fairness
  beyond explicit priority").
- Hardware: `compose.gpu.yaml` runs one vLLM server per role, each with a
  fixed KV-cache budget and `--max-num-seqs 4`: `ocr_model` (Surya, for
  ingestion), `nuextract_model` and `extraction_model` (Qwen, for extraction;
  Studio's schema chat and generation also call `extraction_model` directly,
  outside any kei queue).
- kei OCR today: `prototypes/parsing_service/src/kei_exp/cut.py:318`
  (`cut_pages`) cuts each page into regions with the layout model;
  `transcription/surya.py:280-296` (`SuryaOcr.transcribe`) sends every region
  of the whole document to one `RecognitionPredictor` call inside one step.
  Surya's thread count defaults to the server's max-num-seqs
  (`prototypes/parsing_service/.venv/lib/python3.13/site-packages/surya/inference/backends/vllm.py:101-104`,
  overridable with `SURYA_INFERENCE_PARALLEL`).
- DBOS Python source (3.0.0, for reading):
  `/tmp/claude-1000/-home-gennaro-projects-FREE/6ce6ecd0-5ad8-43bc-99c6-86dc980b8934/scratchpad/m0/py/.venv/lib/python3.13/site-packages/dbos/`.
  The plan pins 3.1.0; `uv run --with dbos==3.1.0` fetches it.

## Claims to verify

1. **Redis cannot be DBOS's system database.** Only Postgres (and compatibles)
   or SQLite.
2. **The plan's single `kei` queue (global 1, worker 1) serializes `convert`
   and `extract`**, so a small document's extraction waits for a book's
   conversion even though they use different vLLM servers.
3. **DBOS priority doesn't preempt.** It orders waiting jobs only. Cancel
   takes effect at the next step boundary. Per the DBOS skill reference,
   `resume_workflow` bypasses the queue's concurrency limit, while
   `rewind_workflow(..., queue_name=...)` respects it.
4. **Postgres load is fine** at ≤ 2000 page tasks per book. The real risk is
   payload size (OCR text or logprobs checkpointed as step outputs), which the
   plan's "no page content in workflow history" rule already forbids.
5. **Staying with DBOS beats Hatchet/Temporal** for FREE: in-process library,
   no extra service, and enqueue in the same Postgres transaction as domain
   rows. The alternatives are better only at strict fairness.
6. **DBOS partitions give per-user fair sharing.** On a partitioned queue,
   DBOS shuffles partitions randomly on each poll (`_queue.py:765` in 3.0.0).
   Setting `partition_concurrency` equal to the global limit partitions the
   queue without capping a lone user.

## Proposed fixes

A. Split `kei` into one queue per vLLM server: `kei-convert` (`ocr_model`) and
   `kei-extract` (both extraction servers).
B. `convert` fans out: a parent workflow queues one child workflow per scanned
   page on `kei-convert` (text-layer pages skip OCR). A page's regions run one
   after another inside it. Book pages get priority 10; small or interactive
   documents get priority 1.
C. Rule: queue concurrency × `SURYA_INFERENCE_PARALLEL` ≤ `max-num-seqs`.
   Here that means 4 × 1. Otherwise excess requests queue inside vLLM in
   arrival order and priorities stop mattering.
D. Partition `kei-convert` by researcher account with
   `global_concurrency=4, partition_concurrency=4`. Every enqueue carries a
   key, and `deleteRuns` uses a fixed key such as `system`.

## Evidence

`fair_queue_probe.py` (this folder), with dbos 3.1.0 on SQLite: 4 slots,
0.05 s polling, simulated pages of 0.15–0.35 s. User A queues a 60-page book,
then B queues a 30-page book, then C and A each queue a 2-page document at
priority 1. Three runs per mode:

| | Unpartitioned | Partitioned by user |
|---|---|---|
| B's first page starts after being queued | ~4.5 s (only after every page of A had started) | 0.4–0.5 s |
| Pages started while both books waited (A/B) | 0/0 | 25/30, 47/19, 18/30 |
| Small documents start after being queued | < 0.1 s | < 0.5 s |

## Known issue, found while writing this brief

`deleteRuns` (plan ~603-607) relies on the `kei` queue running one job at a
time: "Queue exclusion, not priority or elapsed age, prevents cleanup
overlapping a cancelled native step." With 4-slot queues, cleanup can run
beside a page task, including a cancelled one whose step is still running.
Fix A and fix D break this guarantee. Propose a replacement.

## Questions

1. Is any claim above wrong or overstated? Check the DBOS source rather than
   the docs where you can: partition shuffle, dequeue order, `resume` versus
   the queue, and whether `partition_concurrency == global_concurrency` has
   side effects on global or worker counting.
2. Does fair sharing across partitions defeat claim 4's priority goal? A small
   document from user C competes at equal odds with A's book pages instead of
   jumping ahead. Is there a DBOS-native way to get both cross-user priority
   and fairness?
3. What does the per-page fan-out break in kei? Consider the single writer per
   run directory, manifest publication and the generation pin, Surya's
   `KeptOutputs`/fallback per image, `ocr.resolve`, cancellation propagation
   (`cancel_children`), the `kei-convert` deadline (`workflowTimeoutMS` from
   dequeue: parent or child?), `hold_slot` and the flock, and recovery of a
   parent that waits on thousands of handles (`get_result` versus
   `DBOS.wait_first`).
4. What replaces queue exclusion for `deleteRuns`?
5. Is the probe valid evidence? What would a Postgres run with realistic page
   times (several seconds) and the default 1 s polling need to show before the
   plan adopts fix D?

## Output format

Findings ranked P1 (the design is wrong or unsafe), P2 (needs a change), P3
(nit). Each finding needs a file:line citation, a concrete failure scenario and
a proposed fix. Then list counter-arguments to the proposal as a whole, and the
live tests you would require before adopting it.
