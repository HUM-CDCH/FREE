One P1 race still blocks approval.  
A cancelled Studio handoff can race kei cleanup.  
Two P2 gaps remain: page-count failure and recovery exhaustion.  
The queue limits and Compose wiring otherwise check out.  
The measurements support the lanes, not a general waiting-time guarantee.

1. **P1 — A late handoff can create a reader after cleanup’s checks.**  
   [Plan:664](/home/gennaro/projects/FREE/docs/plans/2026-09-24-unified-durable-execution.md:664) says an eligible run gets no new reader. But [plan:588](/home/gennaro/projects/FREE/docs/plans/2026-09-24-unified-durable-execution.md:588) explicitly allows `submitToKei` to finish after cancellation.

   **Failure:** an extraction is admitted against an existing revision, but its enqueue stalls. The source is deleted and the Studio parent becomes `CANCELLED`. GC sees an old, unreferenced run with only completed kei workflows. After `deleteRuns` checks statuses, the stalled enqueue completes. Extraction and deletion can now touch the same directory. A later cancellation sweep cannot prevent this race.

   **Fix:** require proof that cancelled Studio parents cannot finish another handoff before making their runs eligible. Extending Studio’s existing boot boundary to this eligibility check is a conservative solution. Then recheck kei children. Add a test that holds an enqueue across cancellation, deletion and GC.

2. **P2 — Page counting introduces an unspecified PDF rejection path.**  
   [Plan:325](/home/gennaro/projects/FREE/docs/plans/2026-09-24-unified-durable-execution.md:325) requires pdf.js counting before ingestion admission. Today, kei validates readability using PDFium ([api.py:203](/home/gennaro/projects/FREE/prototypes/parsing_service/src/kei_exp/api.py:203)). Studio’s existing pdf.js helper awaits opening outside its error handler, and its public helper rasterizes every page ([`_pdf.ts:73`](/home/gennaro/projects/FREE/prototypes/studio/api/_pdf.ts:73)).

   **Failure:** a PDF that kei accepts but pdf.js cannot open fails before reaching kei. The plan gives no fallback or explicit product decision for this regression.

   **Fix:** specify a count-only helper with resource cleanup and a failure policy. Prefer counting with the same parser as kei, outside the conversion queues. An unknown-count fallback to the large lane is simpler, but must explicitly weaken the small-document promise. Test parser disagreement. Reprocessing can read the stored package count; today’s route already does so ([source_reprocess.ts:89](/home/gennaro/projects/FREE/prototypes/studio/api/source_reprocess.ts:89)).

3. **P2 — Recovery exhaustion has no cleanup eligibility rule.**  
   [Plan:658](/home/gennaro/projects/FREE/docs/plans/2026-09-24-unified-durable-execution.md:658) covers `SUCCESS`, `ERROR` and `CANCELLED`, but omits `MAX_RECOVERY_ATTEMPTS_EXCEEDED`. DBOS writes that distinct status when recovery attempts run out ([`_core.py:1221`](/home/gennaro/.cache/uv/archive-v0/Ioue0ILjYWbCsz5L/lib/python3.14/site-packages/dbos/_core.py:1221)).

   **Failure:** repeated worker crashes exhaust recovery. Studio reports failure, but the run never satisfies either documented cleanup branch—even after further restarts.

   **Fix:** define eligibility for recovery exhaustion explicitly. Tie it to proof that the previous executor exited, and add an exhaustion/restart/GC test. Do not silently treat every terminal status as proof that a step returned.

4. **P3 — The current-settings description contradicts the shipped change.**  
   [Plan:711](/home/gennaro/projects/FREE/docs/plans/2026-09-24-unified-durable-execution.md:711) says FREE sets neither Surya width nor GPU type, although [compose.gpu.yaml:46](/home/gennaro/projects/FREE/compose.gpu.yaml:46) now sets the width.

   **Failure:** an implementer cannot tell whether this describes today’s deployment or the measurement baseline.

   **Fix:** say “Before this change, FREE set neither,” and label the 32-thread result as the baseline.

Checked and correct:

- Explicit cancellation and deadline cancellation both write `CANCELLED` with database-clock `updated_at`: [`_sys_db.py:1169`](/home/gennaro/.cache/uv/archive-v0/Ioue0ILjYWbCsz5L/lib/python3.14/site-packages/dbos/_sys_db.py:1169), [`:4608`](/home/gennaro/.cache/uv/archive-v0/Ioue0ILjYWbCsz5L/lib/python3.14/site-packages/dbos/_sys_db.py:4608).
- For the proposed synchronous, joined steps, ordinary `SUCCESS`/`ERROR` follows completion or exception unwinding, including exhausted step retries.
- Worker limits retain cancelled, still-running workflows’ slots on all four queues, including `kei-gc`; restart recovery re-enqueues through the original queue. This matches the [DBOS queue contract](https://docs.dbos.dev/python/reference/queues).
- Development and production Compose rendered successfully at default width 4 and overridden width 2; API, worker and OCR server matched, and database settings survived merging.
- The anchor rename has no dangling consumers; Playwright Compose rendered independently.
- Active queue names are consistent. Remaining single-queue/exclusion references describe superseded history.
- Reported timings match the evidence README. Large-book memory, spreads and Studio/model contention remain explicitly pending.

This was read-only source review and Compose rendering. I ran no pnpm scripts, DBOS runtime probes or live-model tests.

