# Claude Code final sparring response — 2026-09-25

Historical review, not implementation instructions. Model usage confirmed
`claude-opus-5-5`; the invocation selected `--effort medium`, safe mode, no
tools/MCP and no persisted session. The response below is preserved verbatim
apart from trailing whitespace;
see the evidence README for corrections and accepted decisions. The briefing
predated the concurrent browser-key update; its credential-storage premise
was superseded, while the execution questions below were unchanged.

---

# Verdict

The plan is coherent and smaller: it removes ExtractionJob, BatchExtractionMember, ingestion keys, followers, the alias table, the custom chunk handler and the custom locks. I found no architectural contradiction. There are two likely bugs and four small edge-case gaps. Each needs a sentence in the plan, not a new feature.

# Must-fix

**M1. Chat dedup scope (item 1): "per-revision" is probably wrong.** Suppose admission advances the thread revision (to the question row). Then turn B arrives on the new revision and gets a different dedup id. B runs while A is still active, and the "second concurrent turn → 409" guarantee is lost. There are two consistent options:
- the dedup id is `chat:<threadId>`, released when the workflow finishes; or
- the revision is a compare-and-swap head that only moves when the turn completes.

State which one. As written, it reads like the first intent with the second option's key.

**M2. Same-turnId concurrent replay (item 1).** "Replay reads existing row" covers sequential replays. It does not cover two requests with the same turnId arriving together: both see no row and both open a transaction.
- Make the domain-row INSERT the first statement in the transaction. The loser then blocks on the unique index and gets 23505 after the winner commits.
- Map 23505 on the turn PK to rollback followed by the existing-row replay path, not to a 409 or 500.
- Do not rely on `enqueueInTransaction` behaviour for a same-ID collision inside an uncommitted transaction. That is unverified.

**M3. Deleted member mid-run (items 2 and 3).**
- **Batch extraction:** source delete cascades the pending Extraction row. The workflow's completion UPDATE then touches 0 rows, and its source read may throw. Specify that a 0-row update is a no-op, and that a missing source ends that member's step as skipped, not as a batch failure.
- **Stored batch status:** if batch status is stored rather than derived from `outcome IS NULL` rows, the delete transaction must recompute it.
- **Suggestions:** after a crash, recovery replays with the attempt-snapshot pins in the workflow input, including the deleted source. Each member step must first check that the attempt outcome is still null, and exit if it is not. Otherwise it reads a missing source and ends in ERROR.
- **All terminal writes:** failed, succeeded and interrupted must all use the same `outcome IS NULL AND attempt = n` predicate. Then a late failure can't overwrite "interrupted".

**M4. Ingestion staging orphans (item 4).** Two cases leave staging files behind:
- a crash after the staging write but before enqueue (there is no workflow to own the file);
- a failed attempt, if the workflow's failure path doesn't delete its own file.

Add one rule: GC deletes attempt staging paths whose attempt UUID has no active workflow, and that are older than the 30-minute request window. Keep a DB `unique(project, sha256)` on completed content (or confirm it exists). Dedup only covers active overlap and the in-workflow recheck is a read, so the constraint is the actual backstop.

**M5. Cancelled-history cutoff (item 6).** "Cancelled before this boot" needs a concrete predicate:
- Capture the boot time from the DB's `now()` at startup, not the host clock.
- Filter with `status = CANCELLED AND updated_at < boot_ts`.

Unverified: whether DBOS touches `updated_at` when a cancelled workflow's in-flight step later returns. If it does, the rule is still safe, because it only delays cleanup. The rule is unsafe only if some path cancels without bumping `updated_at`. Verify that once against 5.0.2.

**M6. Error `cause` chain (item 5).** You verified that sanitizing outside `durableCalls` leaks nested secrets. The thrown "sanitized error" must be a freshly constructed error with no `cause`, `errors` or attached response object. DBOS serializes whatever it receives.

# Checked and sound

- **Deleting BatchExtractionMember.** With targeted retry gone, its only job was membership before results existed. Pending Extraction rows with `unique(batch, sourceDocument)` and the composite pin FKs cover that. Rerun as a new batch keeps reviews on the old rows. The "real source deletion fails FK23503" finding stays open until the plan states the ON DELETE rules explicitly:
  - Extraction → source revision: CASCADE.
  - Review → Extraction: CASCADE.
  - Suggestion membership: CASCADE.
  - Proposal/draft: no FK to sources, or SET NULL.

  List these.
- **Live proposal deletion.** Ordering is conditional mark, commit, then cancel. Crash windows are covered by the conditional predicate plus startup repair. Preserving the draft and coverage metadata as original-generation facts is consistent with the immutable selection key.
- **Kei GC serialization.** It rests on verified facts: `worker_concurrency=1` physically holds the slot while a CANCELLED native step is blocked, and the flock guarantees one worker. Cleanup therefore can't overlap a zombie step. The cost is that cleanup stalls behind a hung native step. That is a liveness issue, not a correctness one, and acceptable.
- **Queue slots in Studio.** Don't let the plan claim `global1` is mutual exclusion there. In DB-counted concurrency, a cancelled TS workflow likely stops counting while its in-process LLM call finishes. Correctness still comes from the outcome predicate. Word it that way.

# Verified vs assumed

**Verified (per your list):**
- Transactional enqueue on a shared pg client.
- Active dedup.
- Return-existing rejected inside a caller transaction.
- Typed return → normal finish.
- Outer sanitizer leak.
- Python blocked-slot behaviour.
- FK23503.

**Assumed, worth one check each:**
- Non-transactional return-existing gives back the existing workflow ID usable for awaiting.
- Dedup release is atomic with a terminal status.
- `updated_at` semantics on cancel.
- "Never removes history referenced by live Studio parent": kei cleanup can read `dbos.workflow_status` across schemas and identify the child IDs. Plain same-database SQL should work, but the plan should name the query.
- A stream opened for a GC'd turn is read as "ended". Reload after the 24h retention window then rereads the transcript instead of erroring.

# Exact minimal modifications

1. Item 1: define the chat dedup id as `chat:<threadId>`, or define the revision as a CAS head that moves only on completion. Put the domain INSERT first in the transaction, and map 23505 on the turn PK to the replay read.
2. Items 2 and 3: a 0-row completion UPDATE and a missing member source are no-op or skip. Member steps check that the attempt is still open. Every terminal write uses the single conditional predicate. List the ON DELETE rule for each FK.
3. Item 4: add a staging-orphan sweep with a cutoff above 30 minutes. Keep or confirm `unique(project, sha256)`.
4. Item 5: throw a new error with no cause chain.
5. Item 6: use a DB-clock `boot_ts` with the predicate `CANCELLED AND updated_at < boot_ts`. Verify `updated_at` behaviour once.
6. Treat stream 404 or GC'd as ended, then reread the transcript.

Nothing else needs adding.
