# Review: the eighth revision of the DBOS plan

You are an adversarial reviewer. Rules: **read-only**. Don't edit files. Don't run git commit, stash, reset or
checkout. Don't run `pnpm` scripts or installs. You may run Python with `uv run` from a scratch directory under /tmp.

**Write for a busy human who found an earlier review too dense.** Put a 5-line summary at the top. Use plain words
and short sentences. Stay under about 900 words. Cite file:line for each finding.

## What to review

`docs/plans/2026-09-24-unified-durable-execution.md` (working copy), eighth revision. It sizes kei's scheduling
for the DGX Spark (decision 14):

- kei's single queue becomes `kei-convert-large`, `kei-convert-small` (split at `SMALL_DOCUMENT_PAGES` = 30),
  `kei-extract` (2 slots) and `kei-gc`, each with worker concurrency equal to its global limit.
- Studio counts pages at admission (pdf.js for ingestion, the stored count for reprocessing) and fixes the lane
  in the workflow input.
- `SURYA_INFERENCE_PARALLEL` was shipped in `compose.gpu.yaml`, tied to `ocr_model`'s `--max-num-seqs` through
  `OCR_MAX_NUM_SEQS`, and asserted in `tests/safety.test.mjs`.
- `deleteRuns` uses a kei boot boundary instead of queue exclusion.
- New M0R 4 and M0R 6 items, M3/M4/M6 tests, Risks, Out of scope, revision history and review-log entries.

The sections that changed:
- Status;
- decision 14 and *Settled* / *Open decision*;
- the target architecture;
- the workflows table;
- *Studio → kei handoff*;
- `runExtraction` step 2;
- `ingestSource`;
- *Cancellation → Physical capacity*;
- *Deletion* (kei runs, and the closing paragraph);
- *Queues, deadlines and upgrades*;
- *kei worker*;
- M0R intro, M0R 4 and M0R 6;
- M3, M4 and M6;
- *Verification*, *Risks* and *Out of scope*;
- the revision history;
- the last five review-log entries.

The evidence for the numbers:
- `docs/plans/2026-09-24-unified-durable-execution-evidence/rev8-tests/README.md` and the scripts beside it;
- `fair_queue_probe.py`;
- `rev8-sparring-answer.md`.

**Out of scope for this review.** The working copy also holds another session's uncommitted edits, which are
not part of revision 8:
- the "2026-09-25 risk probes" link in Status;
- the "Recovery saves to an existing schema" text;
- "Check parent terminality before reading fresh domain references";
- the authenticatedFetch "before starting new model work" line;
- "M2–M4 form one integration boundary";
- the M5 "A reloaded page saves a finished generation only onto its base" text;
- `source-inbox` in the backup set.

Ignore them unless revision 8 contradicts them.

## Check in particular

1. **Is the kei boot boundary for `deleteRuns` sound?** Look at DBOS 3.1.0 Python: does a cancel, and a
   `workflow_timeout` deadline, set `CANCELLED` with `updated_at` from the database clock? The source is under
   `/home/gennaro/.cache/uv/archive-v0/Ioue0ILjYWbCsz5L/lib/python3.14/site-packages/dbos/`. Is "a run whose kei
   workflows all ended SUCCESS or ERROR is eligible, because their steps returned" true, including step retries
   and `MAX_RECOVERY_ATTEMPTS_EXCEEDED`? Does "an eligible run gets no new reader" hold?
2. **Worker concurrency.** Is "worker concurrency equal to global limit, one process under the flock" enough for
   the capacity claims on every queue? Include `kei-gc`, and recovery after a restart.
3. **Admission.** Can Studio count pages at admission as described? Check `prototypes/studio/api/_pdf.ts`,
   `api/source_reprocess.ts` and `api/source_documents.ts`. What happens to a PDF pdf.js can't open, but kei can?
4. **Consistency.** Do stale references to the single `kei` queue, queue exclusion, or `kei-convert` as a queue
   remain? Do the plan's numbers match the rev8-tests README?
5. **The Compose change.** Check `compose.gpu.yaml` with `tests/safety.test.mjs`. Can the anchor rename break
   any other Compose file or overlay (`compose.override.yaml`, `compose.prod.yaml`, `e2e/playwright.compose.yaml`,
   scripts)?
6. **Anything this revision gets wrong or leaves out** for the goal: while a big book converts, a small document's
   ingestion and extraction don't wait for it.

## Output

Findings ranked P1 (wrong or unsafe), P2 (needs a change) and P3 (nit), each with a concrete failure scenario and
a proposed fix. Then list anything you checked and found correct, one line each.
