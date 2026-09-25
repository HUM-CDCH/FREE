# Superseded Source Representation Admission Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Date: 2026-09-25. Status: **implemented on branch fix/superseded-revision-admission (8684e8a..6d4f508 plus this fix wave).**

**Goal:** A new interactive Extraction is admitted only on the document's current Source Representation Revision, decided under a Source Document row lock that reprocess publication also takes, and a stale request gets HTTP 409 `source_representation_superseded`.

**Architecture:** One helper in `packages/db` takes a transaction-held lock on a Source Document row (a no-op ORM update: the Prisma Next runtime executes only prepared builder statements and the builder has no `FOR UPDATE` clause). Reprocess publication, single-run admission and batch admission call it before they read the document's latest revision, so the two writers are serialized and the check-then-insert window under Read Committed closes. The rule runs only for a new Extraction identity, after ownership and replay resolution, so identical repeats still replay. The Studio API maps the new error code to 409; the client already shows run-creation errors.

**Tech Stack:** TypeScript, Prisma Next 0.16 ORM (`orm.public.<Model>`), PostgreSQL 17, `node:test` Postgres checks in `packages/db`, `node:test` integration tier in `packages/extraction`, Vitest in `prototypes/studio`.

**Spec:** `docs/plans/2026-09-25-superseded-revision-admission-design.md`

## Global Constraints

- **Branch and base:** `fix/superseded-revision-admission` from `feat/kei-exp-parser` (d44cf79). PR base is `feat/kei-exp-parser`.
- **No schema change:** do not touch any migration, `packages/db/src/prisma/contract.prisma` or `contract.d.ts`. "Current revision" is the highest `revisionNumber` per Source Document; no pointer column is added.
- **No compatibility aliases** for the new error code; no client change.
- **Suggested batches are exempt:** `packages/extraction/src/postgres-suggested-batch.ts` is not modified; the exception is documented (Task 4).
- **The lock is the no-op update** in `lockSourceDocumentRow` (Task 1). Never issue raw SQL text from product code; the runtime has no such API. Tests may use the `pg` client, as `packages/db/src/postgres-test-helpers.ts` does.
- **Error message (verbatim):** `This document has been reprocessed. No new Extraction was started. Open the document from the project's Sources list to run on its current source revision. You can continue reviewing this earlier Extraction.`
- **Disposable databases only:** user `postgres`, loopback, port 5432, database `free_test_*`. Export `PROJECT_STORE_POSTGRES_URL` for the db checks and `EXTRACTION_TEST_DATABASE_URL` (migrated) for the extraction integration tier. Never `pnpm install`, `uv sync`, or stop/reconfigure a container.
- **Tiers:** `pnpm --filter db typecheck`, `pnpm --filter db test`, `pnpm --filter db test:postgres`; `pnpm --filter extraction typecheck`, `pnpm --filter extraction test`, `pnpm --filter extraction test:postgres`; `pnpm --filter studio typecheck`, `pnpm --filter studio lint`, `pnpm --filter studio test`.
- **Commits:** one per task, conventional prefix, scoped `git add` of named files only, never `git add -A`; each message ends, after a blank line, with the committing agent's own attribution trailer as the harness gives it. Never delete a file; never `git rm`, `stash`, `reset`, `checkout -- <file>`, `clean` or `commit --amend`.

## Review Focus

1. **An identical repeat of an already admitted run, sent after a reprocess, must replay and never answer 409.** Task 2's test "replays an identical request after a reprocess" pins it.
2. **A run admitted before a reprocess must survive as a historical attempt with executable inputs.** Task 2's test "keeps a run admitted before a reprocess" pins it.
3. **A stale request must leave no row behind:** no `ExtractionJob`, and a repeat with a fresh ID must still be refused, not replayed from a phantom row. Task 2's first test asserts the missing row.
4. **Two documents locked in different orders must not deadlock:** the guard is `canonicalIds`' sorted order, in which batch admission locks its members (pinned by the batch ordering test "rejects duplicate members, atomically pins valid members…", which asserts sorted members, and by the comment on the member loop); a single run or a reprocess locks one row. Task 3's test that runs a batch and a reprocess of one of its members concurrently is a liveness smoke test: both finish, and the member pins either revision.
5. **A foreign or unknown document must still read as missing, not as superseded:** the lock helper's `false` return maps to the existing `missing` path. Task 2's test "conceals a foreign document" pins it.

---

### Task 1: Source Document row lock in `packages/db`, taken by reprocess publication

**Files:**
- Create: `packages/db/src/row-lock.ts`
- Modify: `packages/db/src/index.ts` (export the helper)
- Modify: `packages/db/src/project-store.ts:1571-1600` (`reprocessSourceDocument`: lock before the expected-head read)
- Modify: `packages/db/src/postgres-test-helpers.ts` (add `withHeldSourceDocumentLock`)
- Modify: `packages/db/package.json` (`exports` gains `./postgres-test-helpers`; `test:postgres` also runs the reprocess check)
- Test: `packages/db/src/source-reprocessing.postgres.check.ts`

**Interfaces:**
- Produces: `lockSourceDocumentRow(orm: DatabaseOrm, sourceDocumentId: string): Promise<boolean>` exported from `db`; `false` when the document does not exist.
- Produces: `withHeldSourceDocumentLock<T>(databaseUrl, sourceDocumentId, operation: () => Promise<T>, whileBlocked: (run: (sql: string, params?: unknown[]) => Promise<void>) => Promise<void>): Promise<T>` exported from `db/postgres-test-helpers` (tests only). It holds `SELECT … FOR UPDATE` on the row from a second connection, starts `operation`, waits until one backend is blocked on an `UPDATE` of `"sourceDocument"`, runs `whileBlocked` on the holding connection, commits, and returns `operation`'s result.

- [ ] **Step 1: Write the failing publication test**

Append to `packages/db/src/source-reprocessing.postgres.check.ts`, after the existing test and using its `db`, `createResearcherProjectStore` and `url`:

```ts
import { withHeldSourceDocumentLock } from './postgres-test-helpers.js'

test('reprocess publication waits for a held Source Document row lock', async () => {
  const account = await db.orm.public.ResearcherAccount.create({
    tenantId: randomUUID(),
    objectId: randomUUID(),
    displayName: 'Reprocess lock validation',
  })
  const store = createResearcherProjectStore(account.id, db)
  const project = await store.createProjectContext('Lock evidence')
  const base = {
    ingestionKey: randomUUID(),
    contentSha256: 'd'.repeat(64),
    mediaType: 'application/pdf',
    originalName: 'locked.pdf',
    artifactReference: 'e'.repeat(64),
    artifactSha256: 'e'.repeat(64),
    contractVersion: 'parsed_document.v2',
    preprocessId: 'native-v5',
    parserName: 'kei-exp',
    parserVersion: '5',
    ensureRetained: async () => {},
  }
  const first = await store.ingestSourceDocument(project.projectContextId, base)
  assert.ok(first)
  let orderMarker = 'held'
  const revised = await withHeldSourceDocumentLock(
    url!,
    first.sourceDocumentId,
    () =>
      store.reprocessSourceDocument(project.projectContextId, first.sourceDocumentId, {
        ...base,
        ingestionKey: randomUUID(),
        expectedRepresentationId: first.sourceRepresentationId,
        requestFingerprint: 'f'.repeat(64),
      }),
    async () => {
      // Runs while publication is blocked on the row lock: it has not published yet.
      orderMarker = 'blocked-before-publish'
    },
  )
  assert.equal(orderMarker, 'blocked-before-publish')
  assert.equal(revised?.revisionNumber, 2)
})
```

- [ ] **Step 2: Run it to see it fail**

Run, from the worktree root with `PROJECT_STORE_POSTGRES_URL` exported:
`pnpm --filter db exec tsx --test src/source-reprocessing.postgres.check.ts`
Expected: FAIL. `withHeldSourceDocumentLock` is not exported (TypeScript/ESM error), or, once it exists, the wait for a blocked `UPDATE` times out because publication takes no lock yet.

- [ ] **Step 3: Write the lock helper**

Create `packages/db/src/row-lock.ts`:

```ts
import type { DatabaseOrm } from './prisma/db.js'

/**
 * Serializes writers on one Source Document for the rest of the current transaction.
 *
 * The Prisma Next runtime executes only prepared builder statements, and the builder has
 * no `FOR UPDATE` clause, so the lock is a no-op UPDATE of the document row: it takes the
 * same row-level lock, and any other transaction that updates or `FOR UPDATE`-selects the
 * row waits until this one commits or rolls back. Call it inside `database.transaction`
 * before reading the document's current Source Representation Revision.
 *
 * Returns false when the document does not exist, so callers keep their "missing" path.
 */
export async function lockSourceDocumentRow(
  orm: DatabaseOrm,
  sourceDocumentId: string,
): Promise<boolean> {
  const document = await orm.public.SourceDocument.select('id', 'originalName').first({
    id: sourceDocumentId,
  })
  if (!document) return false
  await orm.public.SourceDocument.where({ id: sourceDocumentId }).update({
    originalName: document.originalName,
  })
  return true
}
```

Add to `packages/db/src/index.ts`:

```ts
export { lockSourceDocumentRow } from './row-lock.js'
```

- [ ] **Step 4: Take the lock in reprocess publication**

In `packages/db/src/project-store.ts`, inside `reprocessSourceDocument`'s `database.transaction` callback (`:1571`), immediately after the `ownsProjectContext` check returns and before `const document = await orm.public.SourceDocument.select(...)`, add:

```ts
          // Serialize with run admission: both decide on the latest revision under this lock.
          if (!(await lockSourceDocumentRow(orm, sourceDocumentId))) return null
```

Import it at the top of `project-store.ts`: `import { lockSourceDocumentRow } from './row-lock.js'`.

- [ ] **Step 5: Write the held-lock test helper**

In `packages/db/src/postgres-test-helpers.ts`, add after `withBlockedUpdates`:

```ts
/**
 * Hold `SELECT … FOR UPDATE` on one Source Document row from a second connection, start
 * `operation`, wait until one backend is blocked on an UPDATE of "sourceDocument" (the
 * product lock is a no-op update), run `whileBlocked` on the holding connection, then
 * commit and return the operation's result.
 */
export async function withHeldSourceDocumentLock<T>(
  databaseUrl: string,
  sourceDocumentId: string,
  operation: () => Promise<T>,
  whileBlocked: (run: (sql: string, params?: unknown[]) => Promise<void>) => Promise<void>,
): Promise<T> {
  validateDisposableTestDatabaseTarget(databaseUrl)
  const holder = new Client({ connectionString: databaseUrl })
  await holder.connect()
  let result: Promise<T> | undefined
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM "sourceDocument" WHERE id = $1 FOR UPDATE', [sourceDocumentId])
    result = operation()
    void result.catch(() => {})
    const deadline = Date.now() + 10_000
    while (true) {
      await holder.query('SELECT pg_stat_clear_snapshot()')
      const waiting = await holder.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE $1
      `, ['%UPDATE%"sourceDocument"%'])
      if (waiting.rows[0]!.count >= 1) break
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for a blocked Source Document update.')
      await setTimeout(10)
    }
    await whileBlocked(async (sql, params) => { await holder.query(sql, params) })
    await holder.query('COMMIT')
    return await result
  } finally {
    try {
      await holder.query('ROLLBACK')
    } finally {
      await holder.end()
      await result?.catch(() => {})
    }
  }
}
```

- [ ] **Step 6: Run the check to see it pass**

Run: `pnpm --filter db exec tsx --test src/source-reprocessing.postgres.check.ts`
Expected: PASS, both tests. Then `pnpm --filter db typecheck` and `pnpm --filter db test`: clean.

- [ ] **Step 7: Wire the reprocess check into the tier and export the helper**

In `packages/db/package.json`, change line 13 to:

```json
    "test:postgres": "tsx --test src/project-store.postgres.check.ts src/source-reprocessing.postgres.check.ts",
```

and add to its `exports` map, after `"./database-url"`:

```json
    "./postgres-test-helpers": "./src/postgres-test-helpers.ts"
```

so Tasks 2 and 3 can import `withHeldSourceDocumentLock` from `db/postgres-test-helpers`.

Run: `pnpm --filter db test:postgres`. Expected: PASS (both files).

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/row-lock.ts packages/db/src/index.ts packages/db/src/project-store.ts packages/db/src/postgres-test-helpers.ts packages/db/src/source-reprocessing.postgres.check.ts packages/db/package.json
git commit -m "feat(db): lock the Source Document row before publishing a reprocess"
```

---

### Task 2: Single-run admission refuses a superseded revision

**Files:**
- Modify: `packages/extraction/src/errors.ts:1-21` (the code)
- Modify: `packages/extraction/src/postgres-persistence.ts:386-425` (`scheduleInteractiveExtraction`)
- Test: `packages/extraction/src/extraction-module.integration.test.ts` (beside the reprocess case at `:613`)

**Interfaces:**
- Consumes: `lockSourceDocumentRow` from `db` (Task 1); `withHeldSourceDocumentLock` from `db/postgres-test-helpers` (Task 1).
- Produces: `ExtractionErrorCode` gains `'source_representation_superseded'`; `scheduleInteractiveExtraction` throws `ExtractionError('source_representation_superseded', SUPERSEDED_MESSAGE)` for a new identity on a superseded revision. Task 4 maps the code.

- [ ] **Step 1: Write the failing tests**

In `extraction-module.integration.test.ts`, inside the same `describe` as the reprocess case, add:

```ts
    it('refuses a new Extraction on a superseded Source Representation Revision and writes no job', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      await addRepresentation(document, 'article-v2.pdf')
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)
      await assert.rejects(module.runSingle(input), rejectsWithCode('source_representation_superseded'))
      assert.equal(await db.orm.public.ExtractionJob.select('id').first({ id: input.extractionId }), null)
      await assert.rejects(module.runSingle(freshInput(project)), rejectsWithCode('source_representation_superseded'))
    })

    it('admits a new Extraction on the current Source Representation Revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const revisionTwo = await addRepresentation(project.documents[0]!, 'article-v2.pdf')
      const { module } = createRuntime(project.researcherAccountId)
      const admitted = await module.runSingle({ ...freshInput(project), sourceRepresentationRevisionId: revisionTwo })
      assert.equal(admitted.disposition, 'created')
      assert.equal(admitted.extraction.sourceRepresentationRevisionId, revisionTwo)
    })

    it('replays an identical request after a reprocess instead of refusing it', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)
      const first = await module.runSingle(input)
      await addRepresentation(project.documents[0]!, 'article-v2.pdf')
      const again = await module.runSingle(input)
      assert.equal(again.disposition, 'replayed')
      assert.equal(again.extraction.extractionId, first.extraction.extractionId)
      await assert.rejects(module.runSingle({ ...input, strategy: 'CATALOG' }), rejectsWithCode('extraction_id_conflict'))
    })

    it('keeps a run admitted before a reprocess as a historical attempt', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const completed = await module.runSingle(freshInput(project))
      await addRepresentation(document, 'article-v2.pdf')
      const historical = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId, extractionId: completed.extraction.extractionId })
      assert.equal(historical?.latestAttempt?.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
    })

    it('refuses a run that was admitted while a reprocess published a newer revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)
      await assert.rejects(
        withHeldSourceDocumentLock(
          process.env.EXTRACTION_TEST_DATABASE_URL!,
          document.sourceDocumentId,
          () => module.runSingle(input),
          async (run) => {
            await run(
              `INSERT INTO "sourceRepresentationRevision"
                 (id, "sourceDocumentId", "revisionNumber", "artifactReference", "artifactSha256",
                  "contractVersion", "preprocessId", "parserName", "parserVersion")
               VALUES ($1, $2, 2, $3, $3, 'parsed_document.v2', $4, 'test', '1')`,
              [randomUUID(), document.sourceDocumentId, 'c'.repeat(64), `race-${randomUUID()}`],
            )
          },
        ),
        rejectsWithCode('source_representation_superseded'),
      )
      assert.equal(await db.orm.public.ExtractionJob.select('id').first({ id: input.extractionId }), null)
    })

    it('conceals a foreign document behind the same missing answer', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const foreign = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      assert.equal(await module.runSingle({ ...freshInput(project), sourceRepresentationRevisionId: foreign.documents[0]!.sourceRepresentationRevisionId }), null)
    })
```

Add `import { withHeldSourceDocumentLock } from 'db/postgres-test-helpers'` next to the existing `db/database-url` import (Task 1 exported that subpath).

- [ ] **Step 2: Run them to see them fail**

Run, with `EXTRACTION_TEST_DATABASE_URL` exported and migrated: `pnpm --filter extraction test:postgres`
Expected: the first, fourth-ordering and replay tests FAIL (a stale run is admitted today; the replay test's conflict assertion may already pass), the others PASS.

- [ ] **Step 3: Add the error code**

In `packages/extraction/src/errors.ts`, add to the `ExtractionErrorCode` union, after `'invalid_source_representation'`:

```ts
  | 'source_representation_superseded'
```

- [ ] **Step 4: Decide under the lock in admission**

In `packages/extraction/src/postgres-persistence.ts`, add near the top:

```ts
import { lockSourceDocumentRow } from 'db'   // extend the existing `from 'db'` import list at :12

const SUPERSEDED_MESSAGE =
  "This document has been reprocessed. No new Extraction was started. Open the document from the project's Sources list to run on its current source revision. You can continue reviewing this earlier Extraction."
```

In `scheduleInteractiveExtraction`, replace the block from `if (existingJob) {` through `return 'created' as const` with:

```ts
      if (existingJob) {
        const project = await orm.public.ProjectContext.select('researcherAccountId').first({
          id: existingJob.projectContextId,
        })
        if (project?.researcherAccountId !== researcherAccountId) return 'missing' as const
        return jobIdentityMatches(existingJob, job) ? 'replayed' as const : 'conflict' as const
      }
      // A new identity is admitted only on the document's current revision, decided under the
      // Source Document row lock that reprocess publication also takes: Read Committed would
      // otherwise let a reprocess commit between this read and the insert.
      if (!(await lockSourceDocumentRow(orm, job.sourceDocumentId))) return 'missing' as const
      const current = await orm.public.SourceRepresentationRevision.where({
        sourceDocumentId: job.sourceDocumentId,
      })
        .select('id')
        .orderBy((revision) => revision.revisionNumber.desc())
        .first()
      if (current?.id !== job.sourceRepresentationRevisionId) return 'superseded' as const
      await orm.public.ExtractionJob.create({
        ...job,
        kind: 'INTERACTIVE',
      })
      return 'created' as const
```

After the transaction, next to the existing `conflict` mapping:

```ts
    if (status === 'superseded')
      throw new ExtractionError('source_representation_superseded', SUPERSEDED_MESSAGE)
```

Keep the order: `missing` → `null`, `conflict` → throw, `superseded` → throw, then `disposition = status`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `pnpm --filter extraction test:postgres`. Expected: PASS, every test in the file.
Run: `pnpm --filter extraction typecheck` and `pnpm --filter extraction test`. Expected: clean, PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extraction/src/errors.ts packages/extraction/src/postgres-persistence.ts packages/extraction/src/extraction-module.integration.test.ts
git commit -m "feat(extraction): admit a new run only on the document's current source revision"
```

---

### Task 3: Batch admission pins current revisions under the document locks

**Files:**
- Modify: `packages/extraction/src/postgres-persistence.ts:1561-1625` (`scheduleBatch`: lock each member row before resolving its latest revision)
- Test: `packages/extraction/src/extraction-module.integration.test.ts`

**Interfaces:**
- Consumes: `lockSourceDocumentRow` (Task 1), `withHeldSourceDocumentLock` (Task 1), the `scheduleBatch` input shape used by the existing test at `:847`.
- Produces: nothing new; `scheduleBatch` keeps its result shape.

- [ ] **Step 1: Write the failing test**

```ts
    it('a batch admitted behind a reprocess pins the newly published revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const revisionTwo = randomUUID()
      const scheduled = await withHeldSourceDocumentLock(
        process.env.EXTRACTION_TEST_DATABASE_URL!,
        document.sourceDocumentId,
        () => module.scheduleBatch({
          projectContextId: project.projectContextId,
          schemaRevisionId: project.schemaRevisionId,
          sourceDocumentIds: [document.sourceDocumentId],
          strategy: 'ARTICLE',
          repetition: 'create-new',
        }),
        async (run) => {
          await run(
            `INSERT INTO "sourceRepresentationRevision"
               (id, "sourceDocumentId", "revisionNumber", "artifactReference", "artifactSha256",
                "contractVersion", "preprocessId", "parserName", "parserVersion")
             VALUES ($1, $2, 2, $3, $3, 'parsed_document.v2', $4, 'test', '1')`,
            [revisionTwo, document.sourceDocumentId, 'c'.repeat(64), `race-${randomUUID()}`],
          )
        },
      )
      assert.ok(scheduled)
      assert.equal(scheduled.batch.members[0]?.sourceRepresentationRevisionId, revisionTwo)
    })

    it('a batch and a reprocess of one of its members both finish', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const [one, two] = project.documents as [SeededDocument, SeededDocument]
      const { module } = createRuntime(project.researcherAccountId)
      const store = createResearcherProjectStore(project.researcherAccountId, db)
      const [scheduled, revised] = await Promise.all([
        module.scheduleBatch({
          projectContextId: project.projectContextId,
          schemaRevisionId: project.schemaRevisionId,
          sourceDocumentIds: [two.sourceDocumentId, one.sourceDocumentId],
          strategy: 'ARTICLE',
          repetition: 'create-new',
        }),
        store.reprocessSourceDocument(project.projectContextId, two.sourceDocumentId, {
          ingestionKey: randomUUID(), expectedRepresentationId: two.sourceRepresentationRevisionId,
          requestFingerprint: 'f'.repeat(64), contentSha256: sha256(strToU8(two.filename)),
          mediaType: 'application/pdf', originalName: two.filename, ...two.storedPackage,
          contractVersion: 'parsed_document.v2', preprocessId: 'reprocessed', parserName: 'test', parserVersion: '5',
          ensureRetained: async () => {},
        }),
      ])
      assert.ok(scheduled)
      assert.ok(revised)
    })
```

Copy the exact `scheduleBatch` input fields from the existing test at `:847` if they differ (for example a `models` field); the shape above is the minimum the persistence layer reads.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter extraction test:postgres`
Expected: the first new test FAILS (the batch pins revision 1, resolved before the lock holder published revision 2); the second passes or fails only by timeout.

- [ ] **Step 3: Lock member rows in canonical order**

In `scheduleBatch`'s member loop (`for (const sourceDocumentId of canonicalIds(input.sourceDocumentIds))`, `:1608`), replace the existence check so the lock doubles as it:

```ts
          if (!(await lockSourceDocumentRow(orm, sourceDocumentId))) return 'missing' as const
          if (
            !(await orm.public.SourceDocument.select('id').first({
              id: sourceDocumentId,
              projectContextId: input.projectContextId,
            }))
          )
            return 'missing' as const
```

`canonicalIds` already sorts, so two batches sharing members lock in the same order, and a single run or a reprocess locks one row. Leave the latest-revision read that follows unchanged: it now runs under the lock.

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter extraction test:postgres`. Expected: PASS.
Run: `pnpm --filter extraction typecheck` and `pnpm --filter extraction test`. Expected: clean, PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extraction/src/postgres-persistence.ts packages/extraction/src/extraction-module.integration.test.ts
git commit -m "feat(extraction): pin batch members to their current revisions under the document locks"
```

---

### Task 4: HTTP mapping, Studio test, and the documented exception

**Files:**
- Modify: `prototypes/studio/api/extractions.ts:51-53`
- Test: `prototypes/studio/api/extractions.test.ts` (beside the conflict case at `:483-497`)
- Modify: `prototypes/studio/README.md:81` (reopen note)
- Modify: `docs/plans/2026-09-25-superseded-revision-admission-design.md` (Status line)

**Interfaces:**
- Consumes: `'source_representation_superseded'` from `packages/extraction/src/errors.ts` (Task 2).

- [ ] **Step 1: Write the failing test**

In `api/extractions.test.ts`, inside `'uses bounded cancellation and domain-error HTTP mappings'` after the conflict assertions:

```ts
    vi.mocked(module.runSingle).mockRejectedValueOnce(
      new ExtractionError(
        'source_representation_superseded',
        'This document has been reprocessed. No new Extraction was started.',
      ),
    )
    const superseded = await handle(request(fresh))
    expect(superseded.status).toBe(409)
    expect(await superseded.json()).toEqual({
      error: {
        code: 'source_representation_superseded',
        message: 'This document has been reprocessed. No new Extraction was started.',
      },
    })
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter studio test -- api/extractions.test.ts`
Expected: FAIL: the default branch maps the unknown code to 500 (or whatever the `default:` case returns).

- [ ] **Step 3: Map the code**

In `api/extractions.ts`, extend the 409 case list:

```ts
    case 'extraction_id_conflict':
    case 'invalid_extraction_pins':
    case 'review_conflict':
    case 'source_representation_superseded':
      return new ApiError(409, error.code, error.message, { cause: error })
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `pnpm --filter studio test -- api/extractions.test.ts`. Expected: PASS.
Run: `pnpm --filter studio typecheck`, `pnpm --filter studio lint`, `pnpm --filter studio test`. Expected: clean, 0 errors (3 pre-existing warnings), all files pass.

- [ ] **Step 5: Document the rule and the exception**

In `prototypes/studio/README.md`, after the sentence ending `opening a historical Extraction uses its original source.` (line 81), add:

```markdown
A new Extraction can be started only on the document's current source revision: the server
answers 409 `source_representation_superseded` for a superseded one, and the historical view
offers no run. Runs started from a Schema Suggestion keep the revisions saved with the
suggestion; they are the one exception.
```

In the design document, change the Status line to `Status: **implemented on branch fix/superseded-revision-admission.**`.

- [ ] **Step 6: Commit**

```bash
git add prototypes/studio/api/extractions.ts prototypes/studio/api/extractions.test.ts prototypes/studio/README.md docs/plans/2026-09-25-superseded-revision-admission-design.md
git commit -m "feat(studio): answer 409 for a run on a superseded source revision"
```
