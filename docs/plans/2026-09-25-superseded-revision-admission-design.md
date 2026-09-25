# Superseded Source Representation admission rule — design

Date: 2026-09-25. Status: **implemented on branch fix/superseded-revision-admission.** Branch `fix/superseded-revision-admission` from `feat/kei-exp-parser` (d44cf79, after the DBOS M1 merge, PR #138).

## Context

M1's F6 fix (`fa62304`) stops the browser from offering a new Extraction run on a historical `?extractionId=` view whose Source Representation Revision is superseded. It is a client gate on a fact computed at reopen time (`sourceRepresentation.current`). Two limits were disclosed in PR #138:

1. `current` is fixed at reopen time: a pinned view on the current revision that is reprocessed afterwards keeps its runs. Cross-tab reprocesses are never seen.
2. The server accepts a run on a superseded revision: `resolveScheduledJob` (`packages/extraction/src/postgres-persistence.ts:341-380`) loads the revision row and checks ownership, but never compares it with the document's current revision.

A run admitted on a superseded revision produces a result that ordinary navigation never shows, because the document's latest attempt is chosen on its current revision only (`postgres-persistence.ts:449-464`).

A Codex (gpt-6-astra) read-only sparring round on 2026-09-25 (`.superpowers/sdd/2026-09-25-dbos-m1-dead-code/sparring-followup.md`, local) reviewed the first proposal. Its accepted findings shape this design; see the Review log.

## Decisions (user, 2026-09-25)

- Scope: **the server rule and its HTTP mapping only.** The client refresh on reprocess and the Prisma telemetry line are deferred.
- Guarantee: **lock the Source Document row.** Admission and reprocess publication take a transaction-held lock on the same row; batch admission locks member rows in stable order; there is a defined winner.
- Lock mechanism: the user chose **`SELECT … FOR UPDATE`** with a no-op ORM update as the fallback. Verified while planning: the Prisma Next 0.16 runtime executes only prepared builder statements (`RuntimeQueryable.executePrepared`), and the builder's `raw` is an expression fragment with no lock clause, so product code cannot issue `FOR UPDATE`. **The lock is therefore the no-op update** of the document row (`SourceDocument.originalName` set to its own value), which takes the same row-level lock. Tests hold `FOR UPDATE` from a second `pg` connection, as the existing helpers do.
- Suggested batches: **permitted.** Runs started from a Schema Suggestion keep the revisions saved with the suggestion, as a documented exception.

## The rule

A **new** interactive Extraction is admitted only if the posted `sourceRepresentationRevisionId` is the document's current revision when admission commits. "Current" is the revision with the highest `revisionNumber` for the Source Document (`packages/db/src/project-store.ts:1302`; the database uniquely constrains `(sourceDocumentId, revisionNumber)`, `contract.prisma:114`). There is no pointer column on `SourceDocument`, and none is added.

Where it lives: `scheduleInteractiveExtraction` (`postgres-persistence.ts:386-420`), inside its existing transaction, in this order:

1. Ownership and identity resolution, unchanged: an existing job with the same ID and identical inputs is **replayed** (even if its revision is superseded now); the same ID with different inputs still answers `extraction_id_conflict`; a foreign or unknown target still reads as missing.
2. Only when the identity is **new**: lock the Source Document row, read the current revision under the lock, and if it differs from the posted one, throw `ExtractionError('source_representation_superseded', message)` before `ExtractionJob.create` (`:408-411`). Nothing is written.

Message (shown to the researcher by the existing error path):

> This document has been reprocessed. No new Extraction was started. Open the document from the project's Sources list to run on its current source revision. You can continue reviewing this earlier Extraction.

The rule is enforced at admission, not at worker input loading: a correctly admitted job may become historical before it executes, and its immutable inputs must remain executable. M4 replaces `ExtractionJob.create` with an atomic Extraction/enqueue operation and "keeps PostgreSQL ownership and immutable-input replay checks in the admission" (`docs/plans/2026-09-24-unified-durable-execution.md:1104`); the rule and its tests move with the admission.

## Ordering: the document row lock

Under PostgreSQL's default Read Committed, a read inside the admission transaction leaves a window: admission reads R1, a reprocess commits R2, admission inserts a job on R1. The window closes by serializing the two writers on the Source Document row:

- **Single-run admission** locks the document row (`SELECT id FROM "sourceDocument" WHERE id = $1 FOR UPDATE`) before reading the current revision, only on the new-identity path.
- **Reprocess publication** (`reprocessSourceDocument`, `project-store.ts:1556-1600`) locks the same row before its expected-head read of the latest revision and its `SourceRepresentationRevision.create`.
- **Ordinary batch admission** (`postgres-persistence.ts`, the `canonicalIds` loop around `:1600-1625`) locks each member's document row in canonical sorted order before resolving that member's latest revision, so a batch and a reprocess, or two batches, never deadlock and never pin a revision that a concurrent reprocess supersedes before they commit.

Whichever transaction takes the lock first wins; the other blocks until it commits and then sees the committed state. Admission that commits before a reprocess keeps its job: the run was admitted while its revision was current. Artifact retention, model calls and other slow work stay outside these transactions, as today.

The helper lives in `packages/db` (`packages/db/src/row-lock.ts`, `lockSourceDocumentRow(orm, sourceDocumentId): Promise<boolean>`, exported from `db`), because both packages call it with the transaction's `orm`. It reads the row, returns `false` when the document does not exist (callers keep their missing path), and otherwise runs `orm.public.SourceDocument.where({ id }).update({ originalName: <the value just read> })`. Task 1 proves it blocks a concurrent locker inside a transaction.

## Suggested batches: the documented exception

`postgres-suggested-batch.ts` creates Extractions on the revisions saved with the Schema Suggestion (`:61`, `:118`). A suggestion prepared on R1 may run after a reprocess to R2, on R1. This is intentional: the suggestion's fields were derived from those pins. The exception is documented in the Studio README next to the reopen note and in the plan; no code changes there.

## HTTP and client

- `prototypes/studio/api/extractions.ts` maps `source_representation_superseded` to **409** next to `extraction_id_conflict` (`:51-53`). 409 because the request names valid inputs that conflict with the document's current state; 422 stays for invalid requests.
- The client already treats a run-creation error as a definite rejection and shows the server's message (`src/useExtraction.ts:415-419`). No client change.
- `POST /api/batch-extractions` carries `sourceDocumentIds` only; the server pins current revisions under the locks. No new batch error.

## Tests

Postgres integration tier, `packages/extraction/src/extraction-module.integration.test.ts`, beside the existing reprocess case (`:613`):

1. A fresh ID on a superseded revision is refused with `source_representation_superseded`, and no `ExtractionJob` row exists afterwards.
2. A fresh ID on the current revision is admitted.
3. An identical repeat of an Extraction admitted on R1, sent after R2 is published, is replayed: same Extraction, no new job.
4. The same ID with changed inputs still answers `extraction_id_conflict`.
5. Ordering, admission behind publication: a blocker connection holds the document row lock (pattern of `packages/db/src/postgres-test-helpers.ts`), admission is started and blocks, the blocker inserts R2 and commits, admission proceeds and refuses.
6. Ordering, batch behind publication: the same with ordinary batch admission; the batch pins R2 for that member.
7. Admission before publication: a run admitted on R1 survives a later reprocess as a historical attempt (extends the existing case).

`packages/db`: a unit test that the lock helper's statement blocks a second locker until commit. Studio: `api/extractions.test.ts` maps the new code to 409 with the message.

## Files

- `packages/extraction/src/errors.ts` (the code), `postgres-persistence.ts` (single and batch admission), `extraction-module.integration.test.ts`.
- `packages/db/src/row-lock.ts` (new), `project-store.ts` (publication lock), `postgres-test-helpers.ts` (a document-row blocker), and a db Postgres test.
- `prototypes/studio/api/extractions.ts`, `api/extractions.test.ts`, `README.md` (exception note).

## Constraints

- No schema change, no migration. No compatibility aliases. Every commit ends with the committing agent's own attribution trailer (`Co-Authored-By: Claude <model> <noreply@anthropic.com>`, as the harness gives it to that agent); scoped `git add`; no deletions.
- Tiers: `pnpm --filter extraction typecheck|test|test:postgres` (`EXTRACTION_TEST_DATABASE_URL`, disposable `free_test_*` only), `pnpm --filter db typecheck|test|test:postgres`, `pnpm --filter studio typecheck|lint|test`.
- Never `pnpm install` / `uv sync`; never stop or reconfigure a container.

## Out of scope

The client refresh of pinned routes on reprocess (a background refresh that keeps the workspace on failure); the Prisma Next telemetry env line in the e2e harness and in deployment; exposing the persisted `catalogRecipe` on failed attempts (M4); the four cosmetic notes on the M1 verification record.

## Review log

Codex gpt-6-astra, 2026-09-25, read-only sparring on the first proposal:

- Accepted: the check must not run before identity resolution (replay would break); a transactional read alone leaves the publication window (Read Committed, plain `BEGIN`); batch admission needs the same ordering protection; the rule belongs in admission and survives M4; 409 with a distinct code and a researcher-facing message; "current" is the highest `revisionNumber`.
- Accepted as a scope decision by the user: suggested batches are a separate entry point; they keep their saved pins (permitted).
- Deferred by the user: the client refresh (its failure path unmounts the workspace and needs more than one test); the telemetry line.
