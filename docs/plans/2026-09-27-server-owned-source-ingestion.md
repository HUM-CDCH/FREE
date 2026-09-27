# Server-owned Source Ingestion Implementation Plan

Date: 2026-09-27 · Status: **Part A implemented; Part B deferred** · Drafted by Claude (Opus 5.5) and Codex (gpt-6-astra) independently, merged by Claude, then reviewed adversarially by Codex; see the Review log.

Part A was authorized and implemented in thread `dbf0b382-615b-4f13-b346-0b990052f56f`.
Its commits through `07d7e58` were integrated into PR #141 on 2026-09-27, with
the Article cancellation and service-test follow-up. The step checklists below
remain the original implementation instructions, not a current completion ledger.
See [the reconciliation record](../validation/2026-09-27-ingestion-pr141-reconciliation.md)
for scope, verification and remaining boundaries. Part B (Task 10) remains a
separate follow-up.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An upload that Studio has accepted stays visible on the Project page (queued, parsing, failed) through reloads, other tabs and navigation, until it becomes a Source Document or the researcher dismisses its failure — with one queue, the server's.

**Architecture:** The upload `POST` answers **202 `{ workflowId }`** as soon as the `ingestSource` workflow is admitted (a completed-content replay still answers 201 with the document), so the browser sends every selected file straight away and only tracks the seconds it takes to send the bytes. `GET …/source-ingestions` projects DBOS's own `ingestSource` records into live attempts, recent successes (synchronization metadata only) and undismissed failures, and also answers for any workflow IDs the tab names explicitly (its admitted uploads, and the attempts it last saw live), whatever their age, so nothing a tab is waiting on can fall out of a window. Failures are checked against published content first, so a crash after publication never shows a failure beside the Source Document. `ProjectContextsProvider` polls that listing per observed Project Context, renders its rows, and re-reads the branch (branch-scoped fence) until every listed success is in it. Dismissing a failure deletes the failed attempts of that content from DBOS history, under M6's quiescence rule. Part B moves reprocessing to the same model.

**Tech Stack:** TypeScript, React 19, XState v5 (`sourceIngestionMachine`), zod 4, DBOS TypeScript SDK (`DBOSClient.listWorkflows`, `deleteWorkflows`), vitest 4, Testing Library, Playwright.

**Spec:** this document. It supersedes, for Source Document uploads, the thirty-minute upload wait in `docs/plans/2026-09-24-unified-durable-execution.md` (*Source ingestion*, lines 439–441) and that plan's out-of-scope line "Asynchronous ingestion (202, status URLs, hydration) and listing in-flight ingestions after a reload" (line 1835); Task 11 records the pointers.

## Background (read before Task 1)

- **Symptom.** A PDF being parsed vanishes from the Project page when the page reloads, and never appears in a second tab. It reappears as a Source Document once the parse ends.
- **Cause.** The browser's `sourceIngestionMachine` (`prototypes/studio/src/sourceIngestionMachine.ts`, created in `src/projectContexts/ProjectContextsProvider.tsx:296`) sends one `POST` at a time and holds it open until the workflow finishes (`api/source_documents.ts:233-251`, up to 30 min). Files behind it exist only in browser memory. Meanwhile the server already queues every attempt durably: `ingestSource` on the `studio` queue (`server/dbos.ts:116`, no concurrency limit) with active deduplication `ingest:<project>:<sha256>` (`api/source_documents.ts:216-225`); kei's lanes by page count do the real GPU ordering. The browser queue is redundant and defeats the lanes (a 3-page PDF waits in the browser behind a 400-page one).
- **Already in the working tree (uncommitted, reused here):** `api/source_ingestions.ts` + test (`GET …/source-ingestions`, live attempts only), its route in `server/api-dispatcher.ts`, `sourceIngestionSchema`/`sourceIngestionListingSchema` in `shared/sourceDocumentIngestion.contract.ts`, `listSourceIngestions` in `src/projectContexts/transport.ts`, `src/projectContexts/useServerIngestions.ts` (a polling hook with an unfinished `serverOnlyIngestions` TODO), rendering in `ProjectContextPage.tsx`, and two tests at the end of `src/ProjectNavigation.test.tsx`. This plan replaces the hook and deletes `serverOnlyIngestions`: with one queue there is nothing to reconcile by name.
- **Typed failures end in `SUCCESS`.** A refusal (`IngestionFailure`, `api/_ingestion_workflow.ts:61`) is the workflow's output with `ok: false` and DBOS status `SUCCESS` (`api/source_ingestion.postgres.test.ts:299`). Only `ERROR`, `CANCELLED` and `MAX_RECOVERY_ATTEMPTS_EXCEEDED` are stopped executions.

## Decisions

1. **202 `{ workflowId }` on admission; 201 replay unchanged.** The handler returns right after `admission.enqueue`, with the workflow ID the enqueue returned (the joined attempt's on a deduplicated join, `source_documents.ts:226`). No status read after the enqueue. `RESULT_TIMEOUT_MS`, `resultTimeoutMs`, `resultPollIntervalMs`, the `awaitWorkflowOutcome` call and the 504 `source_ingestion_timeout` branch leave this handler (`awaitWorkflowOutcome` itself stays; model operations and reprocess use it). The conversion deadline inside the workflow is unchanged. *Rejected:* a 202 body carrying `status: 'queued'` (the attempt may already be running or finished when the response lands); the candidate ID on a join (it names an attempt that was never admitted); keeping 201-after-wait with hydration (two queues again).
2. **The listing is the queue.** `GET …/source-ingestions` returns, oldest first by `createdAt` then `workflowId`:
   - live attempts (`ENQUEUED`/`DELAYED` → `queued`, `PENDING` → `parsing`), at any age;
   - successes completed in the last **15 minutes** (`status: 'succeeded'`, with `sourceDocumentId`) — not rendered, only there so a completion between two reads (or before the first) is never missed;
   - failures completed in the last **30 days** (M6's background-history retention, `docs/plans/2026-09-26-dbos-m6-gc-docs-cutover.md:53`): `SUCCESS` with `ok: false` keeps its typed `{ code, message }`; `ERROR`, `CANCELLED`, `MAX_RECOVERY_ATTEMPTS_EXCEEDED` and malformed output become `INTERRUPTED_FAILURE` from `db`.
   A failure is **not listed** when its content is now a Source Document in the project (a crash between publication and the workflow's outcome, `api/_ingestion_workflow.ts:211-223`, or a later replay) — it is listed as `succeeded` with that document instead — or when a newer attempt of the same `sourceSha256` appears in the same read (**superseded**).
   **Explicit IDs.** `?workflowId=<id>` (repeatable, at most 50) adds those workflows to the read whatever their age or status, through one `listWorkflows({ workflowIDs })`; a named ID that is absent or outside this account's project comes back in `absent: string[]` (never as an error, never with details). The tab names its admitted uploads and the attempts it saw live in its previous listing, so a completion is never missed because of a window, a dismissal in another tab, or the read order.
   **Reads are sequential:** live first, then terminal (with `completedAfter`), then the named IDs; a workflow that settles between two reads is caught by the later one, never lost between two snapshots. At most three `listWorkflows` calls and one batched store read (`findSourceDocumentIdsByContent`) per request, never one per workflow. An outcome is classified once, by one validating function shared with dismissal (`classifyOutcome`); a record whose input or output does not validate is skipped with one `console.warn` (a broken row must not blank the whole listing forever), and a `succeeded` row is only emitted with a canonical `sourceDocumentId`. *Rejected:* live-only (cannot tell success from failure; the original bug returns as "failures vanish"); disappearance-only completion detection (misses completions before the first read); parallel reads (a completion between two concurrent snapshots is in neither); a Studio table of attempts (duplicates DBOS ownership).
3. **Dismiss deletes the failed attempts of that content.** `DELETE …/source-ingestions/<workflowId>` (the ID URL-encoded) checks that the Project Context is owned (PostgreSQL) and the workflow is `ingestSource` with `authenticatedUser` equal to the account and `attributes.projectContextId` equal to the route's project. Live or succeeded (by `classifyOutcome`) → 409 `ingestion_not_dismissible`. It then reads every failed `ingestSource` attempt of the same `sourceSha256` in the project (one `listWorkflows`, terminal statuses, `loadInput`) — the chain this row superseded — and deletes them all in one `deleteWorkflows`, so dismissing the newest failure cannot resurrect an older one (the Model Operation Discard deletes older finished proposals for the same reason, `api/model_operations.ts:110-126`). **Quiescence, M6's exact predicate:** `SUCCESS` and `ERROR` rows may go at once; `CANCELLED` and `MAX_RECOVERY_ATTEMPTS_EXCEEDED` rows only with a *present* `updatedAt` earlier than this process's `bootTimestampMs` (`docs/plans/2026-09-26-dbos-m6-gc-docs-cutover.md:820-829`). If any row of the chain fails the predicate, nothing is deleted and the answer is 409 `ingestion_stopping`. An absent workflow → 204 (idempotent; an absent foreign ID discloses nothing). This is an explicit, researcher-initiated exception to M6's 30-day background-history retention; deleting a quiescent parent alone strands nothing (M6's staged-source sweep derives identities from filenames and checks the kei child separately; kei cleanup accepts an absent parent; packages are kept by domain references). *Rejected:* a dismissal-preference table and forward migration (Codex, both passes: a new table for a UI preference, against the DBOS plan's "no new table" decision 15; the only case the table would add is dismissing a failure stopped in this very process, which for uploads needs a project deletion — which removes the listing anyway — or repeated crash recovery; a 409 asking to retry later covers it); browser-only dismissal (reappears in another tab).
4. **Retrying a failed upload means sending the bytes again.** A listed failure offers **Upload again** (opens the file chooser) and **Dismiss**. The workflow removes its staged file on a typed failure (`_ingestion_workflow.ts:158`), so there is nothing to resume server-side. A local send failure (network, 4xx before admission, 502/503/504) keeps its `File` and offers **Retry**; re-sending the same bytes either replays the document (201) or joins the live attempt (202, same `workflowId`).
5. **The browser machine only sends.** Upload items move `waiting → sending → admitted` (or `failed` with `uncertain`), sequentially. An `admitted` item holds its `workflowId` and renders as *Queued* until the provider's listing for that project contains that `workflowId` in any status **or reports it `absent`**, then it leaves the machine — identity-based, no filename matching, no gap between the 202 and the next read, no item stranded by a dismissal elsewhere. A second item admitted with a `workflowId` another admitted item already holds (the same bytes selected twice) leaves at once. A listing that answers `gone` (404) sends `project.deleted` for that project, as a local deletion does. A 201 replay acknowledges the document as today. Local filename validation failures stay item-scoped and non-retryable. **Reprocess items move to their own parallel region** so a reprocess waiting on its parse can never hold an upload back; their behavior is otherwise unchanged until Part B.
6. **The provider observes; the page renders.** `ProjectContextsProvider` owns `ingestions: Record<projectContextId, ProjectIngestions>` and one poller per observed project (`src/projectContexts/ingestionPolling.ts`, framework-free). A project is observed while its Project page is routed (any tab) or while the machine holds `admitted` items for it. Cadence: an immediate read on start, on a 202, and on `visibilitychange` to visible; every **3 s** while the listing has live rows or the machine has admitted items; every **30 s** otherwise (so an open second tab discovers work admitted elsewhere); no reads while `document.hidden`. A failed read keeps the last rows, marks `stale: true`, and retries after 3, 6, 12, then 30 s; it never counts as "nothing in flight". A 404 stops the poller and drops the project's rows. Each read names, as explicit IDs, the project's admitted uploads plus the IDs that were live in the previous successful listing; a poller never stops while any such ID is unresolved. `readNow()` during a read in flight schedules one more read right after it, never drops the request.
7. **Completion is reconciled by containment, not by bookkeeping.** A `succeeded` row is reconciled when the ready branch contains its `sourceDocumentId`. After every listing, if some `succeeded` row is not in the branch and no branch refresh for that project is in flight, the provider fences **only that branch** (bump `branchGenerations[id]`, as `acknowledgeSourceDocument` does at `ProjectContextsProvider.tsx:254-259`; the global `generation` is left alone so other projects' reads are not re-issued), re-reads it (`loadBranch(id, true)`) and calls `reloadList()` once. A failed refresh simply leaves the row unreconciled, so the next listing tries again — no success is "used up" by a transient error. When a Project page starts observing a project whose branch is already cached, the provider re-reads the branch once, which covers work that finished elsewhere while nothing observed it. The branch read stays the authority for Source Documents; the listing never writes documents into the branch.
8. **Deletion.** Deleting a Project Context stops its poller and drops its rows (the listing then answers 404). Deleting a Source Document does not touch upload attempts. Scope cancellation (`api/_scope_cancellation.ts`) is unchanged.
9. **Vocabulary.** CONTEXT.md gains **Source Ingestion**: one attempt to turn a document a Humanities Researcher provides into a Source Document; queued, parsing, then a Source Document or a failure. (`upload` stays out of domain language per CONTEXT.md:21; UI copy may still say "Upload again".) ADR `docs/adr/0012-server-owned-source-ingestion.md` records decisions 1–5.
10. **Two PRs.** Part A (Tasks 1–9, 11) ships uploads end to end. Part B (Task 10) moves reprocessing to 202 + listing, removing the last browser-held parse; it is stacked on Part A.

## Global Constraints

- Keep upload validation exactly: ownership, MIME `application/pdf`, `%PDF-` magic, 100 MiB, 180-scalar filenames, the `file`/`layout` form fields and the `ingestionKey` refusal (`api/source_documents.ts:131-156`).
- Keep admission exactly: completed-content replay before staging, staging before enqueue, deduplication ID `ingest:<projectContextId>:<sha256>` with `duplicationPolicy: 'return-existing'`, removal of only a losing request's staged file, an uncertain enqueue leaves its file for GC (`api/source_documents.ts:177-232`).
- No change to `ingestSourceWorkflow`'s steps, names or order (`api/_ingestion_workflow.ts:152`); recovery of in-flight workflows across the deploy depends on it.
- Only PostgreSQL authorizes; DBOS `authenticatedUser`/`attributes` only locate the scope (`api/model_operations.ts:68-70`).
- Every response of the new and changed routes carries `Cache-Control: no-store` (`noStore`, `api/_http.ts:51`).
- Public failure text is bounded: `code` ≤ 128 characters, `message` ≤ 512; never raw DBOS errors, stacks, staged paths or full workflow inputs.
- Dismissal is the one exception to M6's 30-day background-history retention, and it keeps M6's quiescence predicate exactly (Decision 3); no other code path deletes `ingestSource` history.
- Timestamps are ISO strings ending in `Z` (the contract's `timestamp`, `shared/sourceDocumentIngestion.contract.ts:4`).
- Polling constants live in one place: `INGESTION_ACTIVE_POLL_MS = 3000`, `INGESTION_IDLE_POLL_MS = 30000`, backoff `[3000, 6000, 12000, 30000]`.
- Listing windows live in one place: `RECENT_SUCCESS_MS = 15 * 60 * 1000`, `FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000`.
- Work on a new branch `fix/server-owned-source-ingestion` from the commit the Studio work sits on (`6e641b6`), carrying over only the uncommitted Studio files listed in Background; the Parsing Service changes staged on `feat/modular-extraction-ablation` stay there.
- Commands run from `prototypes/studio` unless stated: unit `pnpm exec vitest run <files>`, PostgreSQL `pnpm test:postgres <files>`, typecheck `pnpm typecheck`, lint `pnpm lint`.

## Review Focus

1. **Same bytes selected twice, or in two tabs, while the first is live.** Expect one card: both POSTs answer 202 with the same `workflowId`, one listing row. Pinned in Task 3 (`a deduplicated join answers the winning workflow ID`) and Task 7 (`two admissions of one workflow render one card`).
2. **A failure, then a successful re-upload of the same content; or two failures, then Dismiss.** Expect the failure card to go away without Dismiss in the first case, and no older failure to reappear in the second. Pinned in Task 2 (`a newer attempt of the same content supersedes a failure`) and Task 3 (`dismisses the whole failed chain of that content…`).
3. **Completion while the researcher is on another project, the home page, or a hidden tab for longer than the success window.** Expect the rail and the Source Document count to be right when they return, with no duplicate document and no card stuck on *Queued*. Pinned in Task 6 (`an admitted upload keeps its project observed after navigating away`, `a completion missing from the windows is still found through its named ID`, `opening a cached project re-reads its branch once`).
4. **The listing is unavailable (DBOS or database down) for a while.** Expect the last cards to stay, a quiet "status unavailable" note, and recovery without a reload. Pinned in Task 5 (`a failed read keeps the rows, marks them stale and backs off`) and Task 7 (`an unavailable listing keeps the cards`).
5. **Twenty PDFs dropped at once, one of them huge.** Expect every file sent in turn, each card *Queued* within seconds, and a small PDF finishing before the huge one. Pinned in Task 4 (`sends the next file after a 202 while the first is still parsing`) and Task 9 (`two selected PDFs are admitted before the held conversion finishes`).

---

## Part A — uploads

### Task 1: Contracts for admission and the listing

**Files:**
- Modify: `prototypes/studio/shared/sourceDocumentIngestion.contract.ts`
- Create: `prototypes/studio/shared/sourceDocumentIngestion.contract.test.ts`

**Interfaces:**
- Produces: `sourceIngestionAdmittedSchema`, `SourceIngestionAdmitted = { workflowId: string }`; `sourceIngestionSchema` (discriminated on `status`), `SourceIngestion`; `sourceIngestionListingSchema`, `SourceIngestionListing = { ingestions: SourceIngestion[]; absent: string[] }`; `isLiveIngestion(ingestion): boolean`; `MAX_NAMED_INGESTIONS = 50`. `sourceDocumentIngestionResponseSchema` is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// shared/sourceDocumentIngestion.contract.test.ts
import { describe, expect, it } from 'vitest'
import {
  isLiveIngestion,
  sourceDocumentIngestionResponseSchema,
  sourceIngestionAdmittedSchema,
  sourceIngestionListingSchema,
} from './sourceDocumentIngestion.contract'

const common = {
  workflowId: 'ingest:51000000-0000-4000-8000-000000000001:51000000-0000-4000-8005-000000000001',
  name: 'Beretning.pdf',
  createdAt: '2026-09-27T10:00:00.000Z',
}
const at = { completedAt: '2026-09-27T10:05:00.000Z' }

describe('source ingestion contracts', () => {
  it('admits with a workflow identity and nothing that claims a document exists', () => {
    expect(sourceIngestionAdmittedSchema.parse({ workflowId: common.workflowId })).toEqual({ workflowId: common.workflowId })
    expect(() => sourceIngestionAdmittedSchema.parse({ workflowId: common.workflowId, status: 'queued' })).toThrow()
  })

  it('keeps the completed upload response unchanged', () => {
    expect(Object.keys(sourceDocumentIngestionResponseSchema.shape).sort()).toEqual(
      ['createdAt', 'name', 'pageCount', 'revisionNumber', 'sourceDocumentId', 'sourceRepresentationId'],
    )
  })

  it('lists live, succeeded and failed attempts, each with the fields its status needs, and the absent IDs', () => {
    const listing = sourceIngestionListingSchema.parse({
      ingestions: [
        { ...common, status: 'queued' },
        { ...common, status: 'parsing' },
        { ...common, status: 'succeeded', ...at, sourceDocumentId: '51000000-0000-4000-8001-000000000001' },
        { ...common, status: 'failed', ...at, failure: { code: 'source_ingestion_failed', message: 'kei refused the PDF.' } },
      ],
      absent: ['ingest:gone'],
    })
    expect(listing.ingestions.map(isLiveIngestion)).toEqual([true, true, false, false])
    expect(listing.absent).toEqual(['ingest:gone'])
  })

  it('refuses a failure without its reason, a success without a canonical document, extra fields and oversized text', () => {
    for (const ingestion of [
      { ...common, status: 'failed', ...at },
      { ...common, status: 'succeeded', ...at },
      { ...common, status: 'succeeded', ...at, sourceDocumentId: 'not-a-uuid' },
      { ...common, status: 'queued', failure: null },
      { ...common, status: 'failed', ...at, failure: { code: 'x'.repeat(129), message: 'm' } },
      { ...common, status: 'failed', ...at, failure: { code: 'c', message: 'm'.repeat(513) } },
      { ...common, createdAt: '2026-09-27T10:00:00.000+02:00', status: 'queued' },
    ])
      expect(sourceIngestionListingSchema.safeParse({ ingestions: [ingestion], absent: [] }).success).toBe(false)
    expect(sourceIngestionListingSchema.safeParse({ ingestions: [] }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run shared/sourceDocumentIngestion.contract.test.ts`
Expected: FAIL — `sourceIngestionAdmittedSchema` and `isLiveIngestion` are not exported.

- [ ] **Step 3: Replace the uncommitted listing schemas with the full contract**

Replace everything below `SourceDocumentIngestionResponse`'s type export in `shared/sourceDocumentIngestion.contract.ts` with (import `canonicalUuidSchema` is already there):

```ts
/** What the upload POST answers once Studio admitted the attempt. The attempt may already be running or finished. */
export const sourceIngestionAdmittedSchema = z.object({ workflowId: z.string() }).strict()
export type SourceIngestionAdmitted = z.output<typeof sourceIngestionAdmittedSchema>

/** How many workflow IDs one listing request may name explicitly. */
export const MAX_NAMED_INGESTIONS = 50

const ingestionFailureSchema = z.object({ code: z.string().max(128), message: z.string().max(512) }).strict()
const common = { workflowId: z.string(), name: z.string(), createdAt: timestamp }

/**
 * One Source Ingestion as the Project page sees it. `succeeded` rows are synchronization metadata (a completion the
 * page must not miss), never cards: the branch read shows the Source Document.
 */
export const sourceIngestionSchema = z.discriminatedUnion('status', [
  z.object({ ...common, status: z.literal('queued') }).strict(),
  z.object({ ...common, status: z.literal('parsing') }).strict(),
  z.object({ ...common, status: z.literal('succeeded'), completedAt: timestamp, sourceDocumentId: canonicalUuidSchema }).strict(),
  z.object({ ...common, status: z.literal('failed'), completedAt: timestamp, failure: ingestionFailureSchema }).strict(),
])
export type SourceIngestion = z.output<typeof sourceIngestionSchema>

/** `absent`: the named workflow IDs Studio does not hold for this project (dismissed, collected, or never this project's). */
export const sourceIngestionListingSchema = z
  .object({ ingestions: z.array(sourceIngestionSchema), absent: z.array(z.string()) })
  .strict()
export type SourceIngestionListing = z.output<typeof sourceIngestionListingSchema>

export function isLiveIngestion(ingestion: SourceIngestion): boolean {
  return ingestion.status === 'queued' || ingestion.status === 'parsing'
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run shared/sourceDocumentIngestion.contract.test.ts`
Expected: PASS (4 tests). `pnpm typecheck` fails in `api/source_ingestions.ts` and the page until Tasks 2 and 7; that is expected inside this PR.

- [ ] **Step 5: Commit**

```bash
git add prototypes/studio/shared/sourceDocumentIngestion.contract.ts prototypes/studio/shared/sourceDocumentIngestion.contract.test.ts
git commit -m "feat(studio): define admission and Source Ingestion listing contracts"
```

### Task 2: The listing reports live work, recent successes, failures and named attempts

**Files:**
- Modify: `packages/db/src/project-store.ts` (new `findSourceDocumentIdsByContent` on `ResearcherProjectStore`, next to `findSourceDocumentByContent` at line 689/1592), `packages/db/src/project-store.postgres.check.ts`
- Modify: `prototypes/studio/api/source_ingestions.ts` (uncommitted), `prototypes/studio/api/source_ingestions.test.ts` (uncommitted)
- Create: `prototypes/studio/api/_source_ingestion_outcome.ts`, `prototypes/studio/api/_source_ingestion_outcome.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas; `INGEST_SOURCE`, `IngestionInput` from `api/_ingestion_workflow.ts`; `executionOf`, `INTERRUPTED_FAILURE` from `db`.
- Produces:
  - `ResearcherProjectStore.findSourceDocumentIdsByContent(projectContextId: string, contentSha256s: readonly string[]): Promise<ReadonlyMap<string, string>>` — content hash → Source Document ID, only for an owned project (an unowned one answers an empty map), one query.
  - `_source_ingestion_outcome.ts`: `type IngestionAttempt = { status: WorkflowStatus; input: IngestionInput }`; `attemptOf(status, projectContextId): IngestionAttempt | null`; `type ClassifiedOutcome = { kind: 'live'; status: 'queued' | 'parsing' } | { kind: 'succeeded'; sourceDocumentId: string } | { kind: 'failed'; failure: { code: string; message: string } }`; `classifyOutcome(status: WorkflowStatus): ClassifiedOutcome`; `isQuiescent(status: WorkflowStatus, bootTimestampMs: number): boolean`.
  - `source_ingestions.ts`: `createSourceIngestionListing(store, admission?, now?)`; exported `RECENT_SUCCESS_MS`, `FAILURE_RETENTION_MS`; exported pure `projectIngestions(input: { projectContextId: string; attempts: readonly IngestionAttempt[]; named: ReadonlySet<string>; published: ReadonlyMap<string, string>; nowMs: number }): SourceIngestion[]`.

- [ ] **Step 1: Write the failing store check**

In `packages/db/src/project-store.postgres.check.ts`, inside the existing ownership test (or a new `test(...)` using its setup helpers), add:

```ts
await t.test('finds Source Documents by content in one owned project only', async () => {
  // Arrange with the file's existing helpers: account A owns project P with a document of content 'a'.
  const found = await storeA.findSourceDocumentIdsByContent(projectP, ['a', 'missing'])
  assert.deepEqual([...found], [['a', documentA]])
  assert.equal((await storeB.findSourceDocumentIdsByContent(projectP, ['a'])).size, 0)
  assert.equal((await storeA.findSourceDocumentIdsByContent(projectP, [])).size, 0)
})
```

Run: `pnpm -C packages/db test:postgres` — Expected: FAIL (`findSourceDocumentIdsByContent` is not a function).

- [ ] **Step 2: Implement the store method**

Declare it on `ResearcherProjectStore` next to `findSourceDocumentByContent` (line 689), and implement next to line 1592, in the `where(… .in([...]))` idiom of line 413:

```ts
    async findSourceDocumentIdsByContent(projectContextId, contentSha256s) {
      if (contentSha256s.length === 0) return new Map()
      if (!(await ownsProjectContext(database.orm, researcherAccountId, projectContextId))) return new Map()
      const rows = (await database.orm.public.SourceDocument
        .where((document) => document.contentSha256.in([...new Set(contentSha256s)]))
        .where({ projectContextId })
        .select('id', 'contentSha256')
        .all()) as { id: string; contentSha256: string }[]
      return new Map(rows.map((row) => [row.contentSha256, row.id]))
    },
```

Run: `pnpm -C packages/db test:postgres` — Expected: PASS. Add the method to every `ResearcherProjectStore` fake that TypeScript flags (`pnpm typecheck` lists them).

- [ ] **Step 3: Write the failing classifier tests** (`api/_source_ingestion_outcome.test.ts`)

```ts
import type { WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { INTERRUPTED_FAILURE } from 'db'
import { describe, expect, it } from 'vitest'
import { attemptOf, classifyOutcome, isQuiescent } from './_source_ingestion_outcome.js'

const PROJECT = '52000000-0000-4000-8000-000000000001'
const DOC = '52000000-0000-4000-8002-000000000001'
const BOOT = 1_700_000_000_000
const status = (overrides: Partial<WorkflowStatus>): WorkflowStatus => ({
  workflowID: `ingest:${PROJECT}:a`, status: 'SUCCESS', workflowName: 'ingestSource', workflowClassName: '',
  createdAt: BOOT - 10, priority: 0, attributes: { projectContextId: PROJECT },
  input: [{ projectContextId: PROJECT, originalName: 'a.pdf', sourceSha256: 'sha' }], ...overrides,
})

describe('classifyOutcome', () => {
  it('reads live statuses, a validated success and a typed refusal', () => {
    expect(classifyOutcome(status({ status: 'ENQUEUED' }))).toEqual({ kind: 'live', status: 'queued' })
    expect(classifyOutcome(status({ status: 'DELAYED' }))).toEqual({ kind: 'live', status: 'queued' })
    expect(classifyOutcome(status({ status: 'PENDING' }))).toEqual({ kind: 'live', status: 'parsing' })
    expect(classifyOutcome(status({ output: { ok: true, pageCount: 1, sourceDocument: { sourceDocumentId: DOC } } }))).toEqual({ kind: 'succeeded', sourceDocumentId: DOC })
    expect(classifyOutcome(status({ output: { ok: false, status: 422, code: 'source_ingestion_failed', message: 'No.' } })))
      .toEqual({ kind: 'failed', failure: { code: 'source_ingestion_failed', message: 'No.' } })
  })

  it('treats stopped executions and any output that does not validate as interrupted', () => {
    for (const recorded of [
      status({ status: 'ERROR' }), status({ status: 'CANCELLED' }), status({ status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' }),
      status({ output: { ok: true } }), status({ output: { ok: true, sourceDocument: { sourceDocumentId: 'nope' } } }),
      status({ output: { ok: false, code: 1 } }), status({ output: undefined }),
    ])
      expect(classifyOutcome(recorded)).toEqual({ kind: 'failed', failure: { ...INTERRUPTED_FAILURE } })
  })

  it('bounds a typed failure to 128 and 512 characters', () => {
    const long = classifyOutcome(status({ output: { ok: false, status: 422, code: 'c'.repeat(200), message: 'm'.repeat(900) } }))
    expect(long).toEqual({ kind: 'failed', failure: { code: 'c'.repeat(128), message: 'm'.repeat(512) } })
  })
})

describe('attemptOf', () => {
  it("accepts only this project's ingestSource records with a readable input", () => {
    expect(attemptOf(status({}), PROJECT)?.input.sourceSha256).toBe('sha')
    for (const recorded of [
      status({ workflowName: 'reprocessSource' }), status({ attributes: { projectContextId: 'other' } }),
      status({ input: undefined }), status({ input: [{ originalName: 'a.pdf' }] }),
    ]) expect(attemptOf(recorded, PROJECT)).toBeNull()
  })
})

describe('isQuiescent (M6: history may go)', () => {
  it('lets SUCCESS and ERROR go, and stopped rows only when updated before this boot', () => {
    expect(isQuiescent(status({ status: 'SUCCESS' }), BOOT)).toBe(true)
    expect(isQuiescent(status({ status: 'ERROR' }), BOOT)).toBe(true)
    for (const stopped of ['CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED']) {
      expect(isQuiescent(status({ status: stopped, updatedAt: BOOT - 1 }), BOOT)).toBe(true)
      expect(isQuiescent(status({ status: stopped, updatedAt: BOOT }), BOOT)).toBe(false)
      expect(isQuiescent(status({ status: stopped, updatedAt: undefined }), BOOT)).toBe(false)
    }
    expect(isQuiescent(status({ status: 'PENDING' }), BOOT)).toBe(false)
  })
})
```

Run: `pnpm exec vitest run api/_source_ingestion_outcome.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: Implement the classifier** (`api/_source_ingestion_outcome.ts`)

```ts
import type { WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { executionOf, INTERRUPTED_FAILURE } from 'db'
import { z } from 'zod'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { INGEST_SOURCE, type IngestionInput } from './_ingestion_workflow.js'

export type IngestionAttempt = { status: WorkflowStatus; input: IngestionInput }
export type ClassifiedOutcome =
  | { kind: 'live'; status: 'queued' | 'parsing' }
  | { kind: 'succeeded'; sourceDocumentId: string }
  | { kind: 'failed'; failure: { code: string; message: string } }

const inputSchema = z.object({ originalName: z.string(), sourceSha256: z.string() }).loose()
const outcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), sourceDocument: z.object({ sourceDocumentId: canonicalUuidSchema }).loose() }).loose(),
  z.object({ ok: z.literal(false), code: z.string(), message: z.string() }).loose(),
])

/** This project's `ingestSource` attempt with a readable input, or null. */
export function attemptOf(status: WorkflowStatus, projectContextId: string): IngestionAttempt | null {
  if (status.workflowName !== INGEST_SOURCE || status.attributes?.projectContextId !== projectContextId) return null
  const input = inputSchema.safeParse(status.input?.[0])
  return input.success ? { status, input: input.data as unknown as IngestionInput } : null
}

/** One reading of an attempt's DBOS record, shared by the listing and dismissal. */
export function classifyOutcome(status: WorkflowStatus): ClassifiedOutcome {
  const execution = executionOf(status.status)
  if (execution === 'QUEUED') return { kind: 'live', status: 'queued' }
  if (execution === 'RUNNING') return { kind: 'live', status: 'parsing' }
  const output = status.status === 'SUCCESS' ? outcomeSchema.safeParse(status.output) : null
  if (output?.success && output.data.ok) return { kind: 'succeeded', sourceDocumentId: output.data.sourceDocument.sourceDocumentId }
  if (output?.success && !output.data.ok)
    return { kind: 'failed', failure: { code: output.data.code.slice(0, 128), message: output.data.message.slice(0, 512) } }
  return { kind: 'failed', failure: { ...INTERRUPTED_FAILURE } }
}

/** M6's rule for when history may be deleted: settled, or stopped and last updated before this process booted. */
export function isQuiescent(status: WorkflowStatus, bootTimestampMs: number): boolean {
  if (status.status === 'SUCCESS' || status.status === 'ERROR') return true
  if (status.status === 'CANCELLED' || status.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
    return status.updatedAt !== undefined && status.updatedAt < bootTimestampMs
  return false
}
```

Run: `pnpm exec vitest run api/_source_ingestion_outcome.test.ts` — Expected: PASS.

- [ ] **Step 5: Write the failing listing tests**

Replace the uncommitted `api/source_ingestions.test.ts` body after its helpers with these tests. Extend `row()` so the input carries `sourceSha256` (default `sha-<n>`) and a status can carry `output` and `completedAt`:

```ts
const NOW = Date.parse('2026-09-27T12:00:00.000Z')
function row(n: number, status: string, overrides: Partial<WorkflowStatus> & { sha?: string } = {}): WorkflowStatus {
  const { sha, ...rest } = overrides
  return {
    workflowID: `ingest:${PROJECT}:${attempt(n)}`, status, workflowName: 'ingestSource', workflowClassName: '',
    authenticatedUser: ACCOUNT,
    input: [{ projectContextId: PROJECT, attemptId: attempt(n), owner: ACCOUNT, originalName: `paper-${n}.pdf`, sourceSha256: sha ?? `sha-${n}` }],
    createdAt: NOW - 60_000 + n, priority: 0, attributes: { projectContextId: PROJECT }, ...rest,
  }
}
const doc = (n: number) => `52000000-0000-4000-8002-0000000000${String(n).padStart(2, '0')}`
const ok = (n: number) => ({ ok: true, pageCount: 3, sourceDocument: { sourceDocumentId: doc(n), name: `paper-${n}.pdf`, createdAt: '2026-09-27T11:59:00.000Z', sourceRepresentationId: '52000000-0000-4000-8003-000000000001', revisionNumber: 1 } })
const refused = { ok: false, status: 422, code: 'source_ingestion_failed', message: 'kei refused the PDF.' }
const attempts = (...statuses: WorkflowStatus[]) => statuses.map((status) => attemptOf(status, PROJECT)!)
const project = (input: Partial<Parameters<typeof projectIngestions>[0]> & { attempts: IngestionAttempt[] }) =>
  projectIngestions({ projectContextId: PROJECT, named: new Set(), published: new Map(), nowMs: NOW, ...input })

type Reads = { live?: WorkflowStatus[]; terminal?: WorkflowStatus[]; named?: WorkflowStatus[]; published?: Map<string, string> }
function handlers(reads: Reads = {}, owns = async () => true) {
  const calls: string[] = []
  const client = {
    listWorkflows: vi.fn(async (input: { status?: unknown; workflowIDs?: unknown }) => {
      const which = input.workflowIDs ? 'named' : Array.isArray(input.status) && input.status.includes('PENDING') ? 'live' : 'terminal'
      calls.push(which)
      return reads[which] ?? []
    }),
  }
  const store = {
    researcherAccountId: ACCOUNT,
    modelOperationScopeExists: vi.fn(owns),
    findSourceDocumentIdsByContent: vi.fn(async () => reads.published ?? new Map()),
  }
  return { client, store, calls, GET: createSourceIngestionListing(store, () => client as never, () => NOW) }
}
const get = (projectContextId: string, named: string[] = []) =>
  new Request(`http://local.test/api/project-contexts/${projectContextId}/source-ingestions${named.length ? `?${named.map((id) => `workflowId=${encodeURIComponent(id)}`).join('&')}` : ''}`)

it('reads live work, then terminal work of the last thirty days, then the named IDs, in that order', async () => {
  const named = `ingest:${PROJECT}:${attempt(9)}`
  const { GET, client, calls } = handlers({ live: [row(1, 'PENDING')] })
  expect((await GET(get(PROJECT, [named]))).status).toBe(200)
  const scope = { workflowName: 'ingestSource', attributes: { projectContextId: PROJECT }, authenticatedUser: ACCOUNT, loadInput: true }
  expect(calls).toEqual(['live', 'terminal', 'named'])
  expect(client.listWorkflows).toHaveBeenNthCalledWith(1, { ...scope, status: ['ENQUEUED', 'DELAYED', 'PENDING'], loadOutput: false })
  expect(client.listWorkflows).toHaveBeenNthCalledWith(2, {
    ...scope, status: ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'], loadOutput: true,
    completedAfter: new Date(NOW - FAILURE_RETENTION_MS).toISOString(),
  })
  expect(client.listWorkflows).toHaveBeenNthCalledWith(3, { workflowIDs: [named], loadInput: true, loadOutput: true })
})

it('a workflow that completes between the live and terminal reads is still listed once, as its terminal record', async () => {
  const { GET } = handlers({ live: [], terminal: [row(1, 'SUCCESS', { output: ok(1), completedAt: NOW - 10 })] })
  const body = sourceIngestionListingSchema.parse(await (await GET(get(PROJECT))).json())
  expect(body.ingestions.map((ingestion) => ingestion.status)).toEqual(['succeeded'])
})

it('answers a named ID at any age, and names absent or foreign IDs in absent', async () => {
  const old = row(1, 'SUCCESS', { output: ok(1), completedAt: NOW - 40 * 24 * 3600_000 })
  const foreign = row(2, 'ERROR', { authenticatedUser: 'someone-else' })
  const { GET } = handlers({ named: [old, foreign] })
  const gone = `ingest:${PROJECT}:${attempt(3)}`
  const body = sourceIngestionListingSchema.parse(await (await GET(get(PROJECT, [old.workflowID, foreign.workflowID, gone]))).json())
  expect(body.ingestions).toEqual([expect.objectContaining({ workflowId: old.workflowID, status: 'succeeded' })])
  expect(body.absent.sort()).toEqual([foreign.workflowID, gone].sort())
})

it('refuses more than fifty named IDs with 422', async () => {
  const ids = Array.from({ length: 51 }, (_, n) => `ingest:${PROJECT}:${n}`)
  expect((await handlers().GET(get(PROJECT, ids))).status).toBe(422)
})

it('maps each DBOS record to one listed state, oldest first', () => {
  const at = NOW - 1000
  const listed = project({ attempts: attempts(
    row(1, 'ENQUEUED'), row(2, 'DELAYED'), row(3, 'PENDING'),
    row(4, 'SUCCESS', { output: ok(4), completedAt: at }),
    row(5, 'SUCCESS', { output: refused, completedAt: at }),
    row(6, 'ERROR', { completedAt: at }),
    row(7, 'CANCELLED', { completedAt: at }),
    row(8, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', { completedAt: at }),
  ) })
  expect(listed.map((ingestion) => [ingestion.name, ingestion.status])).toEqual([
    ['paper-1.pdf', 'queued'], ['paper-2.pdf', 'queued'], ['paper-3.pdf', 'parsing'], ['paper-4.pdf', 'succeeded'],
    ['paper-5.pdf', 'failed'], ['paper-6.pdf', 'failed'], ['paper-7.pdf', 'failed'], ['paper-8.pdf', 'failed'],
  ])
  expect(listed[3]).toMatchObject({ sourceDocumentId: doc(4), completedAt: new Date(at).toISOString() })
})

it('drops an unnamed success older than fifteen minutes but keeps an old failure and old live work', () => {
  const listed = project({ attempts: attempts(
    row(1, 'PENDING', { createdAt: NOW - 40 * 24 * 3600_000 }),
    row(2, 'SUCCESS', { output: ok(2), completedAt: NOW - RECENT_SUCCESS_MS - 1 }),
    row(3, 'SUCCESS', { output: refused, completedAt: NOW - 29 * 24 * 3600_000 }),
  ) })
  expect(listed.map((ingestion) => ingestion.name)).toEqual(['paper-1.pdf', 'paper-3.pdf'])
})

it('a newer attempt of the same content supersedes a failure', () => {
  const listed = project({ attempts: attempts(
    row(1, 'SUCCESS', { output: refused, completedAt: NOW - 5000, sha: 'same' }),
    row(2, 'ERROR', { completedAt: NOW - 4000, sha: 'other' }),
    row(3, 'PENDING', { sha: 'same' }),
  ) })
  expect(listed.map((ingestion) => ingestion.name)).toEqual(['paper-2.pdf', 'paper-3.pdf'])
})

it('a stopped attempt whose content was published is listed as the success it was', () => {
  const listed = project({
    attempts: attempts(row(1, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', { completedAt: NOW - 1000, sha: 'published' })),
    published: new Map([['published', doc(7)]]),
  })
  expect(listed).toEqual([expect.objectContaining({ status: 'succeeded', sourceDocumentId: doc(7) })])
})
```

Keep the uncommitted tests `answers 404 without listing when the account does not own the project` and `answers 422 for a non-canonical project ID and 503 when DBOS is unavailable`, adapted to `handlers(reads, owns)`; also assert `findSourceDocumentIdsByContent` is not called for an unowned project. Delete `lists the owner's live uploads … in one listWorkflows call` and `skips a workflow that settled between the filter and the read` (superseded above).

Run: `pnpm exec vitest run api/source_ingestions.test.ts` — Expected: FAIL.

- [ ] **Step 6: Implement the listing**

In `api/source_ingestions.ts`, replace `sourceIngestionOf` and the handler body with:

```ts
import { MAX_NAMED_INGESTIONS, type SourceIngestion } from '../shared/sourceDocumentIngestion.contract.js'
import { attemptOf, classifyOutcome, type IngestionAttempt } from './_source_ingestion_outcome.js'

export const RECENT_SUCCESS_MS = 15 * 60 * 1000
export const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const LIVE = ['ENQUEUED', 'DELAYED', 'PENDING'] as const
const TERMINAL = ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'] as const

/**
 * Live attempts at any age, successes of the last fifteen minutes, failures of the last thirty days that neither a
 * published document nor a newer attempt of the same content resolved, and every named attempt whatever its age.
 * Oldest first.
 */
export function projectIngestions(input: {
  projectContextId: string
  attempts: readonly IngestionAttempt[]
  named: ReadonlySet<string>
  published: ReadonlyMap<string, string>
  nowMs: number
}): SourceIngestion[] {
  const attempts = [...input.attempts].sort((a, b) =>
    a.status.createdAt - b.status.createdAt || a.status.workflowID.localeCompare(b.status.workflowID))
  const newestOfContent = new Map<string, string>()
  for (const attempt of attempts) newestOfContent.set(attempt.input.sourceSha256, attempt.status.workflowID)
  return attempts.flatMap(({ status, input: recorded }): SourceIngestion[] => {
    const common = { workflowId: status.workflowID, name: recorded.originalName, createdAt: new Date(status.createdAt).toISOString() }
    const outcome = classifyOutcome(status)
    if (outcome.kind === 'live') return [{ ...common, status: outcome.status }]
    const completedMs = status.completedAt ?? status.updatedAt ?? status.createdAt
    const completedAt = new Date(completedMs).toISOString()
    const named = input.named.has(status.workflowID)
    const published = outcome.kind === 'succeeded' ? outcome.sourceDocumentId : input.published.get(recorded.sourceSha256)
    if (published)
      return named || input.nowMs - completedMs <= RECENT_SUCCESS_MS
        ? [{ ...common, status: 'succeeded', completedAt, sourceDocumentId: published }]
        : []
    if (outcome.kind !== 'failed') return []
    if (!named && newestOfContent.get(recorded.sourceSha256) !== status.workflowID) return []
    return [{ ...common, status: 'failed', completedAt, failure: outcome.failure }]
  })
}
```

and the handler, after the ownership check (parse `named` from `url.searchParams.getAll('workflowId')`, 422 `invalid_request` when more than `MAX_NAMED_INGESTIONS`):

```ts
const client = admission()
const scope = {
  workflowName: INGEST_SOURCE, attributes: { projectContextId: projectId },
  authenticatedUser: store.researcherAccountId, loadInput: true,
}
const read = <T>(promise: Promise<T>) => promise.catch((cause) => { throw unavailable(cause) })
// Sequential on purpose: a workflow that settles between two reads is caught by the later one.
const live = await read(client.listWorkflows({ ...scope, status: [...LIVE], loadOutput: false }))
const terminal = await read(client.listWorkflows({
  ...scope, status: [...TERMINAL], loadOutput: true, completedAfter: new Date(now() - FAILURE_RETENTION_MS).toISOString(),
}))
const namedStatuses = named.length ? await read(client.listWorkflows({ workflowIDs: named, loadInput: true, loadOutput: true })) : []
const byId = new Map<string, IngestionAttempt>()
let skipped = 0
for (const status of [...live, ...terminal, ...namedStatuses]) {
  // A named record is checked like any other: this account's, this project's, an ingestSource attempt.
  const attempt = status.authenticatedUser === store.researcherAccountId ? attemptOf(status, projectId) : null
  if (attempt) byId.set(status.workflowID, attempt)            // later reads win: they are newer
  else if (!named.includes(status.workflowID)) skipped += 1
}
if (skipped) console.warn(`Skipped ${skipped} unreadable Source Ingestion record(s).`)
const unresolved = [...byId.values()]
  .filter((attempt) => classifyOutcome(attempt.status).kind === 'failed')
  .map((attempt) => attempt.input.sourceSha256)
const published = await store.findSourceDocumentIdsByContent(projectId, unresolved).catch((cause) => { throw unavailable(cause) })
const ingestions = projectIngestions({ projectContextId: projectId, attempts: [...byId.values()], named: new Set(named), published, nowMs: now() })
const absent = named.filter((id) => !byId.has(id))
return json({ ingestions, absent }, { headers: noStore })
```

Add `'findSourceDocumentIdsByContent'` to `SourceIngestionStore`'s `Pick`.

- [ ] **Step 7: Run and see them pass**

Run: `pnpm exec vitest run api/_source_ingestion_outcome.test.ts api/source_ingestions.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/project-store.ts packages/db/src/project-store.postgres.check.ts prototypes/studio/api/_source_ingestion_outcome.ts prototypes/studio/api/_source_ingestion_outcome.test.ts prototypes/studio/api/source_ingestions.ts prototypes/studio/api/source_ingestions.test.ts
git commit -m "feat(studio): list live, recently succeeded, failed and named Source Ingestions"
```

### Task 3: Dismiss a failure; the upload POST answers on admission

**Files:**
- Modify: `prototypes/studio/api/source_ingestions.ts`, `prototypes/studio/api/source_ingestions.test.ts`, `prototypes/studio/server/api-dispatcher.ts` (route), `prototypes/studio/server/api-dispatcher.test.ts`
- Modify: `prototypes/studio/api/source_documents.ts:39-66, 158-257`, `prototypes/studio/api/source_documents.test.ts`
- Modify: `prototypes/studio/server/researcher-project-ownership.test.ts` (register `../api/source_ingestions.ts`; add denial cases)
- Modify: `prototypes/studio/test/support/scenarios/ingestion-publish.ts:65-70`

**Interfaces:**
- Consumes: Task 2's `attemptOf`, `classifyOutcome`, `isQuiescent`.
- Produces: `createSourceIngestionDismissal(store, admission?, bootTimestampMs?)` → `DELETE` handler; `createResearcherApiHandlers(store)` returns `{ GET, DELETE }`. Upload POST answers `202 SourceIngestionAdmitted` or `201 SourceDocumentIngestionResponse`. `Dependencies.admission` narrows to `Pick<DBOSClient, 'enqueue'>`; `resultTimeoutMs` and `resultPollIntervalMs` are removed.

- [ ] **Step 1: Write the failing dismissal tests** (append to `api/source_ingestions.test.ts`)

```ts
describe('DELETE /api/project-contexts/:id/source-ingestions/:workflowId', () => {
  const BOOT = NOW - 3_600_000
  function dismissal(recorded: WorkflowStatus | undefined, chain: WorkflowStatus[] = recorded ? [recorded] : [], owns = async () => true) {
    const client = {
      getWorkflow: vi.fn(async () => recorded),
      listWorkflows: vi.fn(async () => chain),
      deleteWorkflows: vi.fn(async () => {}),
    }
    const store = { researcherAccountId: ACCOUNT, modelOperationScopeExists: vi.fn(owns) }
    return { client, DELETE: createSourceIngestionDismissal(store, () => client as never, () => BOOT) }
  }
  const del = (workflowId: string, project = PROJECT) =>
    new Request(`http://local.test/api/project-contexts/${project}/source-ingestions/${encodeURIComponent(workflowId)}`, { method: 'DELETE' })
  const id = (n: number) => `ingest:${PROJECT}:${attempt(n)}`

  it('deletes the history of an owned, quiescent failed attempt and answers 204', async () => {
    for (const recorded of [
      row(1, 'SUCCESS', { output: refused }), row(1, 'ERROR'),
      row(1, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', { updatedAt: BOOT - 1 }), row(1, 'CANCELLED', { updatedAt: BOOT - 1 }),
    ]) {
      const { DELETE, client } = dismissal(recorded)
      const response = await DELETE(del(id(1)))
      expect(response.status).toBe(204)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(client.deleteWorkflows).toHaveBeenCalledExactlyOnceWith([id(1)])
    }
  })

  it('dismisses the whole failed chain of that content, so an older failure cannot reappear', async () => {
    const newest = row(2, 'ERROR', { sha: 'same' })
    const chain = [row(1, 'SUCCESS', { output: refused, sha: 'same' }), newest, row(3, 'ERROR', { sha: 'other' }), row(4, 'SUCCESS', { output: ok(4), sha: 'same' })]
    const { DELETE, client } = dismissal(newest, chain)
    expect((await DELETE(del(id(2)))).status).toBe(204)
    expect(client.listWorkflows).toHaveBeenCalledExactlyOnceWith({
      workflowName: 'ingestSource', attributes: { projectContextId: PROJECT }, authenticatedUser: ACCOUNT,
      status: ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'], loadInput: true, loadOutput: true,
    })
    expect(client.deleteWorkflows).toHaveBeenCalledExactlyOnceWith([id(1), id(2)])
  })

  it('refuses live and succeeded attempts, and deletes nothing when any failure of the chain is not quiescent', async () => {
    for (const [recorded, chain, code] of [
      [row(1, 'PENDING'), [], 'ingestion_not_dismissible'],
      [row(1, 'SUCCESS', { output: ok(1) }), [], 'ingestion_not_dismissible'],
      [row(1, 'CANCELLED', { updatedAt: BOOT }), undefined, 'ingestion_stopping'],
      [row(1, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', { updatedAt: undefined }), undefined, 'ingestion_stopping'],
      [row(2, 'ERROR', { sha: 'same' }), [row(1, 'CANCELLED', { updatedAt: BOOT + 1, sha: 'same' }), row(2, 'ERROR', { sha: 'same' })], 'ingestion_stopping'],
    ] as const) {
      const { DELETE, client } = dismissal(recorded, chain ? [...chain] : [recorded])
      const response = await DELETE(del(recorded.workflowID))
      expect(response.status).toBe(409)
      expect((await response.json()).error.code).toBe(code)
      expect(client.deleteWorkflows).not.toHaveBeenCalled()
    }
  })

  it('answers 204 for an absent attempt and 404 for a foreign, misnamed or cross-project one, deleting nothing', async () => {
    expect((await dismissal(undefined).DELETE(del(id(1)))).status).toBe(204)
    for (const recorded of [row(1, 'ERROR', { authenticatedUser: 'someone-else' }), row(1, 'ERROR', { workflowName: 'reprocessSource' }), row(1, 'ERROR', { attributes: { projectContextId: 'other' } })]) {
      const { DELETE, client } = dismissal(recorded)
      expect((await DELETE(del(id(1)))).status).toBe(404)
      expect(client.deleteWorkflows).not.toHaveBeenCalled()
    }
    const unowned = dismissal(row(1, 'ERROR'), undefined, async () => false)
    expect((await unowned.DELETE(del(id(1)))).status).toBe(404)
    expect(unowned.client.getWorkflow).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Write the failing POST tests and adapt the existing ones**

In `api/source_documents.test.ts`:

1. **Delete** the tests at lines 331–418: `waits for the workflow and answers 201 with the document and page count`, `answers a typed workflow failure with its own status, code and message`, `a 504 detaches without cancelling the workflow`, `a DBOS status-read outage after admission answers 503 and leaves the workflow staged`, `a request abort after admission detaches without reporting a persistence outage`, `a workflow that vanished answers 502, not a hang`, `a workflow that stopped with an error answers 502`.
2. **Adapt** (these assert a 201 or a status read today): `accepts exactly 180 Unicode scalars and rejects 181 before staging` (line 185: the accepted upload now answers 202), `stages the upload, counts its pages and enqueues ingestSource…` (line 227: 202 with the enqueued ID), `admits a PDF of more than 30 pages or of no count to the large lane` (line 261: 202), `a joined attempt removes this request's unused staged file` (lines 287–289: drop the status-read expectation; assert 202 with the winner's ID). Remove `resultTimeoutMs`/`resultPollIntervalMs` from the file's dependency helper.
3. **Add**, using the helper the tests at lines 213–256 already call (add `enqueueReturns` to it if absent):

```ts
it('answers 202 with the admitted workflow ID and reads no status after the enqueue', async () => {
  const { response, admission } = await postPdf()
  expect(response.status).toBe(202)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const body = sourceIngestionAdmittedSchema.parse(await response.json())
  expect(body.workflowId).toMatch(new RegExp(`^ingest:${ids.project}:[0-9a-f-]{36}$`))
  expect(admission).not.toHaveProperty('listWorkflows')
})

it('a deduplicated join answers the winning workflow ID', async () => {
  const winner = `ingest:${ids.project}:52000000-0000-4000-8005-000000000009`
  const { response } = await postPdf({ enqueueReturns: winner })
  expect(response.status).toBe(202)
  expect(await response.json()).toEqual({ workflowId: winner })
})
```

Keep `replays completed content before parsing: no staged file, no workflow` (201) and every other validation, staging and lane test.

4. `test/support/scenarios/ingestion-publish.ts:65-70` raises an error on any response before the intended kill; with 202 the response now arrives before publication. Change the scenario to POST, assert 202, then wait for the commit-before-checkpoint hook it already uses before the kill; keep its exactly-once publication assertion.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm exec vitest run api/source_ingestions.test.ts api/source_documents.test.ts server/api-dispatcher.test.ts`
Expected: FAIL — no `createSourceIngestionDismissal`; the POST still waits and answers 201.

- [ ] **Step 4: Implement the dismissal**

In `server/api-dispatcher.ts` replace the uncommitted route with `[/^\/api\/project-contexts\/[^/]+\/source-ingestions(?:\/[^/]+)?$/, 'source_ingestions']`; in `server/api-dispatcher.test.ts` move `'/api/project-contexts/project/source-ingestions/anything'` from the unmatched list to the matched list (`'source_ingestions'`) and add `'/api/project-contexts/project/source-ingestions/a/b'` to the unmatched list.

In `api/source_ingestions.ts`, make the path parser return `{ projectId, workflowId: string | null }` (decode the tail with `decodeURIComponent`, 404 on a broken escape, as `decodedTail` in `api/model_operations.ts:52-60`; `GET` answers 404 when `workflowId` is not null), and add:

```ts
export function createSourceIngestionDismissal(
  store: Pick<ResearcherProjectStore, 'researcherAccountId' | 'modelOperationScopeExists'>,
  admission: () => Pick<DBOSClient, 'getWorkflow' | 'listWorkflows' | 'deleteWorkflows'> = () => studioDbos().admission,
  bootTimestampMs: () => number = () => studioDbos().bootTimestampMs,
) {
  const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Source Document ingestion status is unavailable.')
  const notFound = () => new ApiError(404, 'not_found', 'Source Ingestion was not found.')
  const done = () => new Response(null, { status: 204, headers: noStore })
  return async function dismissSourceIngestion(request: Request): Promise<Response> {
    try {
      const { projectId, workflowId } = route(new URL(request.url).pathname)
      if (!workflowId) throw notFound()
      const owned = await store.modelOperationScopeExists(projectId, null).catch((cause) => { throw unavailable(cause) })
      if (!owned) throw notFound()
      const client = admission()
      const recorded = await client.getWorkflow(workflowId).catch((cause) => { throw unavailable(cause) })
      if (!recorded) return done()
      const attempt = recorded.authenticatedUser === store.researcherAccountId ? attemptOf(recorded, projectId) : null
      if (!attempt) throw notFound()
      if (classifyOutcome(recorded).kind !== 'failed')
        throw new ApiError(409, 'ingestion_not_dismissible', 'Only a failed Source Ingestion can be dismissed.')
      // The failures this row superseded go with it, or the next read would show the older one again.
      const terminal = await client.listWorkflows({
        workflowName: INGEST_SOURCE, attributes: { projectContextId: projectId }, authenticatedUser: store.researcherAccountId,
        status: ['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'], loadInput: true, loadOutput: true,
      }).catch((cause) => { throw unavailable(cause) })
      const chain = [recorded, ...terminal.filter((status) => status.workflowID !== workflowId)]
        .filter((status) => attemptOf(status, projectId)?.input.sourceSha256 === attempt.input.sourceSha256)
        .filter((status) => classifyOutcome(status).kind === 'failed')
      // M6: a stopped attempt's history goes only once nothing in this process can still write it.
      const boot = bootTimestampMs()
      if (chain.some((status) => !isQuiescent(status, boot)))
        throw new ApiError(409, 'ingestion_stopping', 'This Source Ingestion is still stopping. Try again shortly.')
      await client.deleteWorkflows(chain.map((status) => status.workflowID).sort()).catch((cause) => { throw unavailable(cause) })
      return done()
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export function createResearcherApiHandlers(store: ResearcherProjectStore) {
  return { GET: createSourceIngestionListing(store), DELETE: createSourceIngestionDismissal(store) }
}
```

- [ ] **Step 5: Implement the 202 admission**

In `api/source_documents.ts`: delete `RESULT_TIMEOUT_MS` (lines 40–41), the `resultTimeoutMs`/`resultPollIntervalMs` dependency fields, the `awaitWorkflowOutcome` import, and replace lines 232–251 with:

```ts
      // Another attempt won: this request's file was never handed to a workflow.
      if (workflowId !== ours) await removeStagedSource(root, source).catch(() => undefined)
      // Admitted: the Source Ingestion listing reports the attempt from here on.
      return json({ workflowId }, { status: 202, headers: noStore })
```

Narrow `Dependencies.admission` to `Pick<DBOSClient, 'enqueue'>` and update the handler's doc comment (lines 158–162) to say it answers once the attempt is admitted.

- [ ] **Step 6: Ownership coverage**

In `server/researcher-project-ownership.test.ts`, register `'../api/source_ingestions.ts': researcherModule((store) => ({ GET: createSourceIngestionListing(store, () => fixture.dbos as never), DELETE: createSourceIngestionDismissal(store, () => fixture.dbos as never, () => 0) }))` with a `fixture.dbos` whose `listWorkflows`, `getWorkflow` and `deleteWorkflows` are `vi.fn`s, and add next to the upload denial checks (around line 1032):

```ts
it("refuses another account's Source Ingestions without reading DBOS or its documents", async () => {
  for (const request of [
    get(`/api/project-contexts/${ids.projectB}/source-ingestions`, 'accountA'),
    get(`/api/project-contexts/${ids.projectB}/source-ingestions?workflowId=${encodeURIComponent(`ingest:${ids.projectB}:x`)}`, 'accountA'),
    del(`/api/project-contexts/${ids.projectB}/source-ingestions/${encodeURIComponent(`ingest:${ids.projectB}:x`)}`, 'accountA'),
  ]) expect((await fixture.app.fetch(request)).status).toBe(404)
  expect(fixture.dbos.listWorkflows).not.toHaveBeenCalled()
  expect(fixture.dbos.getWorkflow).not.toHaveBeenCalled()
  expect(fixture.dbos.deleteWorkflows).not.toHaveBeenCalled()
})
```

Use the file's existing request helpers and account IDs; the names above are the roles to map (`ids.projectB`, `cookies`).

- [ ] **Step 7: Run and see them pass**

Run: `pnpm exec vitest run api/source_ingestions.test.ts api/source_documents.test.ts server/api-dispatcher.test.ts server/researcher-project-ownership.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add prototypes/studio/api/source_ingestions.ts prototypes/studio/api/source_ingestions.test.ts prototypes/studio/api/source_documents.ts prototypes/studio/api/source_documents.test.ts prototypes/studio/server/api-dispatcher.ts prototypes/studio/server/api-dispatcher.test.ts prototypes/studio/server/researcher-project-ownership.test.ts prototypes/studio/test/support/scenarios/ingestion-publish.ts
git commit -m "feat(studio)!: answer Source Document uploads on admission and dismiss failed Source Ingestions"
```

### Task 4: Transport and the send-only machine

**Files:**
- Modify: `prototypes/studio/src/projectContexts/transport.ts`, `prototypes/studio/src/projectContexts/transport.test.ts`
- Modify: `prototypes/studio/src/sourceIngestionMachine.ts`, `prototypes/studio/src/sourceIngestionMachine.test.ts`

**Interfaces:**
- Produces (transport): `type UploadAdmission = { kind: 'admitted'; workflowId: string } | { kind: 'replayed'; document: SourceDocumentIngestionResponse }`; `ingestSourceDocument(projectContextId, file, layout?, signal?): Promise<UploadAdmission>` (by HTTP status: 202 → admitted, 201 → replayed, anything else 2xx → throws); `listSourceIngestions(projectContextId, workflowIds: readonly string[], signal?): Promise<SourceIngestionListing>` (sends each ID as a repeated `workflowId` query parameter); `dismissSourceIngestion(projectContextId, workflowId): Promise<void>`.
- Produces (machine): upload item `status: 'waiting' | 'sending' | 'admitted' | 'failed'`, `workflowId?: string` when admitted; reprocess item `status: 'queued' | 'parsing' | 'failed'` (unchanged); events `sources.added`, `source.retry`, `project.deleted` (unchanged) and new `ingestions.observed { projectContextId: string; workflowIds: readonly string[]; absent: readonly string[] }`; input gains `onReplayed(item, document)` and `onAdmitted(item, workflowId)`, loses nothing for reprocess (`onIngested` stays for reprocess results).

- [ ] **Step 1: Write the failing machine tests** (new `describe` in `src/sourceIngestionMachine.test.ts`; rewrite `queues uploads…`, `processes sequentially…` and `retries an upload…` to the new statuses)

```ts
describe('sending uploads', () => {
  function actor(ingest: (item: SourceIngestionItem) => Promise<UploadAdmission>, reprocess = vi.fn(() => new Promise<never>(() => {}))) {
    const onAdmitted = vi.fn(); const onReplayed = vi.fn(); const onIngested = vi.fn()
    const running = createActor(sourceIngestionMachine, { input: { ingest, reprocess, onAdmitted, onReplayed, onIngested, toFailureMessage: String, isUncertain } }).start()
    return { running, onAdmitted, onReplayed, onIngested }
  }

  it('sends the next file after a 202 while the first is still parsing', async () => {
    const ingest = vi.fn(async (item: SourceIngestionItem) => ({ kind: 'admitted' as const, workflowId: `wf-${sourceName(item)}` }))
    const { running, onAdmitted } = actor(ingest)
    running.send({ type: 'sources.added', items: [item('A.pdf', 'a'), item('B.pdf', 'b')] })
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2))
    expect(running.getSnapshot().context.items.map((i) => [sourceName(i), i.status, i.kind === 'reprocess' ? null : i.workflowId]))
      .toEqual([['A.pdf', 'admitted', 'wf-A.pdf'], ['B.pdf', 'admitted', 'wf-B.pdf']])
    expect(onAdmitted).toHaveBeenCalledTimes(2)
  })

  it('an admitted item leaves once the listing shows its workflow, and not before', async () => {
    const { running } = actor(async () => ({ kind: 'admitted', workflowId: 'wf-1' }))
    running.send({ type: 'sources.added', items: [item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(running.getSnapshot().context.items[0]?.status).toBe('admitted'))
    running.send({ type: 'ingestions.observed', projectContextId, workflowIds: ['wf-other'], absent: [] })
    expect(running.getSnapshot().context.items).toHaveLength(1)
    running.send({ type: 'ingestions.observed', projectContextId, workflowIds: ['wf-1'], absent: [] })
    expect(running.getSnapshot().context.items).toHaveLength(0)
  })

  it('an admitted item the listing names absent leaves too (dismissed or collected elsewhere)', async () => {
    const { running } = actor(async () => ({ kind: 'admitted', workflowId: 'wf-1' }))
    running.send({ type: 'sources.added', items: [item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(running.getSnapshot().context.items[0]?.status).toBe('admitted'))
    running.send({ type: 'ingestions.observed', projectContextId, workflowIds: [], absent: ['wf-1'] })
    expect(running.getSnapshot().context.items).toHaveLength(0)
  })

  it('a second admission of a workflow another item already holds leaves at once', async () => {
    const { running } = actor(async () => ({ kind: 'admitted', workflowId: 'wf-same' }))
    running.send({ type: 'sources.added', items: [item('A.pdf', 'a'), item('A copy.pdf', 'b')] })
    await vi.waitFor(() => expect(running.getSnapshot().context.items.filter((i) => i.status === 'admitted')).toHaveLength(1))
    expect(running.getSnapshot().context.items).toHaveLength(1)
  })

  it('a replayed upload acknowledges its document and leaves at once', async () => {
    const document = result('51000000-0000-4000-8001-000000000009', 'A.pdf')
    const { running, onReplayed } = actor(async () => ({ kind: 'replayed', document }))
    running.send({ type: 'sources.added', items: [item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(onReplayed).toHaveBeenCalledOnce())
    expect(running.getSnapshot().context.items).toHaveLength(0)
  })

  it('a send failure keeps the File for Retry and the queue continues', async () => {
    const ingest = vi.fn()
      .mockRejectedValueOnce(new Uncertain('network'))
      .mockResolvedValue({ kind: 'admitted', workflowId: 'wf-B' })
    const { running } = actor(ingest)
    running.send({ type: 'sources.added', items: [item('A.pdf', 'a'), item('B.pdf', 'b')] })
    await vi.waitFor(() => expect(running.getSnapshot().context.items.map((i) => i.status)).toEqual(['failed', 'admitted']))
    expect(running.getSnapshot().context.items[0]).toMatchObject({ uncertain: true })
    running.send({ type: 'source.retry', itemId: 'a' })
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(3))
    expect((ingest.mock.calls[2]![0] as SourceIngestionItem & { file: File }).file.name).toBe('A.pdf')
  })

  it('a reprocess waiting on its parse never holds an upload back', async () => {
    const ingest = vi.fn(async () => ({ kind: 'admitted' as const, workflowId: 'wf-A' }))
    const { running } = actor(ingest)
    running.send({ type: 'sources.added', items: [reprocess('r', 'key-1'), item('A.pdf', 'a')] })
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledOnce())
    expect(running.getSnapshot().context.items.find((i) => i.itemId === 'r')?.status).toBe('parsing')
  })
})
```

Keep, adapted to the `reprocess` input, the reprocess key tests (`a reprocess retry re-sends its request key…`, `a terminal server timeout starts a new reprocess key…`), `drops a deleted project without cancelling or applying its late result` (for both regions), `ignores retry unless the source is failed` and `holds client validation failures as item-scoped non-retryable errors`.

- [ ] **Step 2: Write the failing transport tests** (in `src/projectContexts/transport.test.ts`)

```ts
it('reads a 202 as an admission and a 201 as a replayed document', async () => {
  const admitted = `ingest:${PROJECT}:52000000-0000-4000-8005-000000000001`
  stubFetch(() => Response.json({ workflowId: admitted }, { status: 202 }))
  expect(await ingestSourceDocument(PROJECT, pdf('A.pdf'))).toEqual({ kind: 'admitted', workflowId: admitted })
  stubFetch(() => Response.json(completedDocument, { status: 201 }))
  expect(await ingestSourceDocument(PROJECT, pdf('A.pdf'))).toEqual({ kind: 'replayed', document: completedDocument })
})

it('refuses a document body under 202 and an admission body under 201', async () => {
  stubFetch(() => Response.json(completedDocument, { status: 202 }))
  await expect(ingestSourceDocument(PROJECT, pdf('A.pdf'))).rejects.toThrow()
  stubFetch(() => Response.json({ workflowId: 'x' }, { status: 201 }))
  await expect(ingestSourceDocument(PROJECT, pdf('A.pdf'))).rejects.toThrow()
})

it('names workflow IDs as repeated query parameters when listing', async () => {
  const fetch = stubFetch(() => Response.json({ ingestions: [], absent: [] }))
  await listSourceIngestions(PROJECT, ['ingest:p:a', 'ingest:p:b'])
  expect(String(fetch.mock.calls[0]![0])).toBe(`/api/project-contexts/${PROJECT}/source-ingestions?workflowId=ingest%3Ap%3Aa&workflowId=ingest%3Ap%3Ab`)
})

it('dismisses a Source Ingestion by its encoded workflow ID', async () => {
  const fetch = stubFetch(() => new Response(null, { status: 204 }))
  await dismissSourceIngestion(PROJECT, 'ingest:p:a')
  expect(String(fetch.mock.calls[0]![0])).toBe(`/api/project-contexts/${PROJECT}/source-ingestions/ingest%3Ap%3Aa`)
  expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' })
})
```

Use the file's existing fetch stub and fixtures; `stubFetch`, `pdf` and `completedDocument` are the roles to map them onto.

- [ ] **Step 3: Run and see them fail**

Run: `pnpm exec vitest run src/sourceIngestionMachine.test.ts src/projectContexts/transport.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the transport**

In `transport.ts`, split `read` so the status is available:

```ts
async function readResponse(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await authenticatedFetch(url, init)
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const error = projectContextErrorResponseSchema.safeParse(body)
    throw new ProjectContextRequestError(response.status, error.success ? error.data.error : null,
      response.headers.get(REPROCESS_TERMINAL_HEADER) === '1')
  }
  return { status: response.status, body }
}
async function read(url: string, init?: RequestInit): Promise<unknown> {
  return (await readResponse(url, init)).body
}

export type UploadAdmission =
  | { kind: 'admitted'; workflowId: string }
  | { kind: 'replayed'; document: SourceDocumentIngestionResponse }

/** Sends one PDF. Studio answers once the attempt is admitted (202); content it already holds replays (201). */
export async function ingestSourceDocument(projectContextId: string, file: File, layout: SourceLayout = 'pages', signal?: AbortSignal): Promise<UploadAdmission> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('layout', layout)
  const { status, body } = await readResponse(`/api/project-contexts/${projectContextId}/source-documents`, { method: 'POST', body: form, signal })
  if (status === 202) return { kind: 'admitted', workflowId: sourceIngestionAdmittedSchema.parse(body).workflowId }
  if (status === 201) return { kind: 'replayed', document: sourceDocumentIngestionResponseSchema.parse(body) }
  throw new ProjectContextRequestError(status, null)
}

export async function listSourceIngestions(projectContextId: string, workflowIds: readonly string[], signal?: AbortSignal): Promise<SourceIngestionListing> {
  const query = new URLSearchParams(workflowIds.map((id) => ['workflowId', id])).toString()
  return request(`/api/project-contexts/${projectContextId}/source-ingestions${query ? `?${query}` : ''}`, sourceIngestionListingSchema, signal)
}

export async function dismissSourceIngestion(projectContextId: string, workflowId: string): Promise<void> {
  await read(`/api/project-contexts/${projectContextId}/source-ingestions/${encodeURIComponent(workflowId)}`, { method: 'DELETE' })
}
```

- [ ] **Step 5: Implement the machine**

Restructure `sourceIngestionMachine` into a parallel machine. Keep `AddedSource`, `sourceName`, `retried` and the reprocess key rules. The item type becomes:

```ts
export type UploadItem = Extract<AddedSource, { file: File }> & {
  status: 'waiting' | 'sending' | 'admitted' | 'failed'
  workflowId?: string
  failure?: string
  uncertain?: boolean
}
export type ReprocessItem = Extract<AddedSource, { kind: 'reprocess' }> & {
  status: 'queued' | 'parsing' | 'failed'
  failure?: string
  uncertain?: boolean
}
export type SourceIngestionItem = UploadItem | ReprocessItem
```

Machine shape (XState v5 `type: 'parallel'`):

```ts
createMachine({
  id: 'sourceIngestion',
  type: 'parallel',
  context: ({ input }) => ({ items: [], ...input }),
  on: {
    'sources.added': { actions: 'addSources' },           // uploads start 'waiting', reprocess 'queued', validation failures 'failed'
    'source.retry': { guard: 'isFailedSource', actions: 'retrySource' }, // upload → 'waiting', reprocess → retried()
    'project.deleted': { actions: 'removeProject' },
    'ingestions.observed': { actions: 'dropObserved' },   // removes admitted uploads whose workflowId is listed for that project
  },
  states: {
    uploads: {
      initial: 'idle',
      states: {
        idle: { always: { guard: 'hasWaitingUpload', target: 'sending', actions: 'startNextUpload' } },
        sending: {
          invoke: {
            src: 'sendUpload',
            input: ({ context }) => ({ item: context.items.find(isSendingUpload)!, ingest: context.ingest }),
            onDone: [
              { guard: 'isStillOwned', target: 'idle', actions: ['settleSent', 'announceSent'] },
              { target: 'idle' },
            ],
            onError: [{ guard: 'isSendingPresent', target: 'idle', actions: 'failSending' }, { target: 'idle' }],
          },
        },
      },
    },
    reprocesses: {
      initial: 'idle',
      states: {
        idle: { always: { guard: 'hasQueuedReprocess', target: 'parsing', actions: 'startNextReprocess' } },
        parsing: { invoke: { /* today's ingestCurrent invoke, limited to reprocess items, calling context.reprocess */ } },
      },
    },
  },
})
```

`settleSent`: a `replayed` result removes the item; an `admitted` result sets `status: 'admitted', workflowId`, unless another admitted item of the same project already holds that `workflowId`, in which case this item is removed. `announceSent`: calls `onReplayed(item, document)` or `onAdmitted(item, workflowId)`. `dropObserved`: `items.filter((item) => !(item.kind !== 'reprocess' && item.status === 'admitted' && item.projectContextId === event.projectContextId && (event.workflowIds.includes(item.workflowId!) || event.absent.includes(item.workflowId!))))`. Narrow `retried` (today's `sourceIngestionMachine.ts:44-49`) to reprocess items; an upload retry sets `status: 'waiting'` and clears `failure`/`uncertain`. The reprocess region is today's `ingesting` state with `context.reprocess` and `onIngested`, unchanged in behavior.

- [ ] **Step 6: Run and see them pass**

Run: `pnpm exec vitest run src/sourceIngestionMachine.test.ts src/projectContexts/transport.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add prototypes/studio/src/projectContexts/transport.ts prototypes/studio/src/projectContexts/transport.test.ts prototypes/studio/src/sourceIngestionMachine.ts prototypes/studio/src/sourceIngestionMachine.test.ts
git commit -m "refactor(studio): send uploads only until Studio admits them"
```

### Task 5: The ingestion poller

**Files:**
- Create: `prototypes/studio/src/projectContexts/ingestionPolling.ts`, `prototypes/studio/src/projectContexts/ingestionPolling.test.ts`
- Delete: `prototypes/studio/src/projectContexts/useServerIngestions.ts` (uncommitted; never committed, so plain `rm`)

**Interfaces:**
- Produces:

```ts
export const INGESTION_ACTIVE_POLL_MS = 3000
export const INGESTION_IDLE_POLL_MS = 30000
export const INGESTION_BACKOFF_MS = [3000, 6000, 12000, 30000] as const
export type IngestionReading =
  | { kind: 'listed'; listing: SourceIngestionListing }
  | { kind: 'unavailable' }
  | { kind: 'gone' }                                  // 404: the Project Context no longer exists for this account
export type IngestionPoller = { readNow(): void; stop(): void }
export type IngestionPollingOptions = {
  /** Reads the listing; the poller does not know which IDs to name, the provider does. */
  list: (signal: AbortSignal) => Promise<SourceIngestionListing>
  onReading: (reading: IngestionReading) => void
  /** Whether the next read should come soon: live rows listed, or admitted uploads not yet listed. */
  busy: () => boolean
  isHidden?: () => boolean                            // default: () => document.hidden
  onVisible?: (listener: () => void) => () => void    // default: visibilitychange on document
}
export function startIngestionPolling(options: IngestionPollingOptions): IngestionPoller
```

- [ ] **Step 1: Write the failing tests** (fake timers: `vi.useFakeTimers()`, `await vi.advanceTimersByTimeAsync(ms)`)

- `reads at once, then every 3 s while busy and every 30 s while idle`
- `never overlaps reads: a slow read delays the next one instead of stacking`
- `a failed read keeps the rows, marks them stale and backs off 3, 6, 12, then 30 s` — `onReading` receives `{ kind: 'unavailable' }` and never `{ kind: 'listed', ingestions: [] }`
- `a 404 reports gone and stops` — `list` rejects with `new ProjectContextRequestError(404, { code: 'not_found', message: '' })`
- `no reads while hidden; reads at once when visible again`
- `readNow reads immediately and restarts the cadence`
- `readNow during a read in flight reads once more right after it` — hold the first `list` promise, call `readNow()` twice, resolve: exactly one more `list` call follows at once
- `stop aborts the read in flight and ignores its result`

Each test asserts `list` call counts at exact advanced times, e.g. for the first:

```ts
it('reads at once, then every 3 s while busy and every 30 s while idle', async () => {
  let busy = true
  const list = vi.fn(async () => [])
  const poller = startIngestionPolling({ list, onReading: () => {}, busy: () => busy, isHidden: () => false, onVisible: () => () => {} })
  await vi.advanceTimersByTimeAsync(0); expect(list).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3000); expect(list).toHaveBeenCalledTimes(2)
  busy = false
  await vi.advanceTimersByTimeAsync(3000); expect(list).toHaveBeenCalledTimes(3)   // the timer set while busy fires once more
  await vi.advanceTimersByTimeAsync(29_999); expect(list).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1); expect(list).toHaveBeenCalledTimes(4)
  poller.stop()
})
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run src/projectContexts/ingestionPolling.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { SourceIngestionListing } from '../../shared/sourceDocumentIngestion.contract'
import { ProjectContextRequestError } from './transport'

export function startIngestionPolling(options: IngestionPollingOptions): IngestionPoller {
  const isHidden = options.isHidden ?? (() => document.hidden)
  const onVisible = options.onVisible ?? ((listener) => {
    const changed = () => { if (!document.hidden) listener() }
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  })
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading: AbortController | null = null
  let failures = 0
  let again = false                                  // a readNow() arrived during a read
  const schedule = (ms: number) => { clearTimeout(timer); timer = setTimeout(read, ms) }
  function read() {
    if (stopped || reading) return
    if (isHidden()) return                         // resumes through onVisible
    const controller = new AbortController()
    reading = controller
    options.list(controller.signal).then(
      (listing) => {
        if (stopped || controller.signal.aborted) return
        failures = 0
        options.onReading({ kind: 'listed', listing })
        schedule(again ? 0 : options.busy() ? INGESTION_ACTIVE_POLL_MS : INGESTION_IDLE_POLL_MS)
        again = false
      },
      (error: unknown) => {
        if (stopped || controller.signal.aborted) return
        if (error instanceof ProjectContextRequestError && error.status === 404) {
          options.onReading({ kind: 'gone' })
          stopped = true
          return
        }
        options.onReading({ kind: 'unavailable' })
        schedule(INGESTION_BACKOFF_MS[Math.min(failures++, INGESTION_BACKOFF_MS.length - 1)]!)
      },
    ).finally(() => { if (reading === controller) reading = null })
  }
  const stopVisible = onVisible(() => { clearTimeout(timer); read() })
  schedule(0)
  return {
    readNow() { if (reading) { again = true; return } clearTimeout(timer); read() },
    stop() { stopped = true; clearTimeout(timer); reading?.abort(); stopVisible() },
  }
}
```

- [ ] **Step 4: Run and see them pass**

Run: `pnpm exec vitest run src/projectContexts/ingestionPolling.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
rm prototypes/studio/src/projectContexts/useServerIngestions.ts
git add prototypes/studio/src/projectContexts/ingestionPolling.ts prototypes/studio/src/projectContexts/ingestionPolling.test.ts
git commit -m "feat(studio): poll a Project Context's Source Ingestions with backoff and visibility"
```

### Task 6: The provider observes projects and reconciles completions

**Files:**
- Modify: `prototypes/studio/src/projectContexts/ProjectContextsProvider.tsx`, `prototypes/studio/src/projectContexts/useProjectContexts.ts`

**Interfaces:**
- Consumes: Task 4 machine events/inputs, Task 5 `startIngestionPolling`, `listSourceIngestions`, `dismissSourceIngestion`.
- Produces on `ProjectContextsValue`:

```ts
export type ProjectIngestions = {
  status: 'loading' | 'ready' | 'unavailable'
  /** The last successful listing; kept while a later read fails. */
  ingestions: readonly SourceIngestion[]
  stale: boolean
}
ingestions: Readonly<Record<string, ProjectIngestions>>
/** Keeps the Project Context's Source Ingestions observed while the returned release has not been called. */
observeIngestions: (projectContextId: string) => () => void
dismissIngestion: (projectContextId: string, workflowId: string) => WriteResult
```

`ingestingSources` keeps its name and now holds `SourceIngestionItem[]` from Task 4.

- [ ] **Step 1: Write the failing tests** (in `src/ProjectNavigation.test.tsx`, a new `describe('Source Ingestions in the provider')`, using `renderRoutes` and a fetch fake that answers `/source-ingestions` from a mutable listing and records each request's `workflowId` parameters)

- `an admitted upload keeps its project observed after navigating away` — admit A.pdf (202), navigate home, flip the listing to `succeeded`, advance 3 s: exactly one more branch read happens and the rail shows A.pdf on return.
- `each read names the admitted uploads and the attempts live in the previous listing` — after a 202 for `wf-A` and a listing with `wf-B` parsing, the next request carries `workflowId=wf-A&workflowId=wf-B`.
- `a completion missing from the windows is still found through its named ID` — `wf-B` leaves the live read and the terminal read (both fakes omit it) but the named read answers it `succeeded`: the branch is refreshed; the poller does not stop while `wf-B` is unresolved.
- `completion refreshes the branch once however many attempts succeed, and only that branch` — two rows go `succeeded` in one listing → one branch read of this project, one list read, and a second project's in-flight branch read is not re-issued.
- `a failed refresh is retried by the next listing` — the first refresh answers 503: the next listing (same `succeeded` row, document still not in the branch) refreshes again; once the branch contains it, no further refresh.
- `a success already present in the first listing refreshes the branch` — reload scenario: first listing has one `succeeded` row not in the branch → one refresh.
- `opening a cached project re-reads its branch once` — visit P, go home, return to P: one more branch read, then none while idle.
- `a branch read that started before the completion cannot hide the new document` — hold the branch read, deliver the success, then release the older branch response: the new document stays (fence).
- `a project deleted in another tab drops its local items` — the listing answers 404: the poller stops, the rows go, and an admitted item for that project leaves the machine.
- `deleting the project stops its poller` — after `deleteProject`, no further `/source-ingestions` reads for it.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run src/ProjectNavigation.test.tsx -t "Source Ingestions in the provider"`
Expected: FAIL — `observeIngestions` is not provided.

- [ ] **Step 3: Implement**

In `ProjectContextsProvider.tsx`:

1. State: `const [ingestions, setIngestions] = useState<Record<string, ProjectIngestions>>({})`; refs `pollers = useRef(new Map<string, IngestionPoller>())`, `observers = useRef(new Map<string, number>())`, `ingestionsRef` mirroring `ingestions`, `watched = useRef(new Map<string, Set<string>>())` (per project: the IDs live in the previous listing), and `refreshing = useRef(new Set<string>())` (projects with a completion refresh in flight).
2. `refreshAfterIngestion(projectContextId)`: if `refreshing` has it, return. Otherwise add it, bump **only** `branchGenerations.current[projectContextId]` (never `generation.current`: other projects' reads stay valid, as `acknowledgeSourceDocument` intends at lines 248–259), call `loadBranch(projectContextId, true)` if the branch exists, and `reloadList.current()`. Clear the `refreshing` flag when a read of that branch next settles: keep `branchSettled = useRef(new Map<string, (() => void)[]>())`, push the clearing callback there, and in both of `loadBranch`'s `then` callbacks, after `superseded()` returns false, run and clear that project's callbacks. A superseded read re-issues itself through `reloadBranch` (line 82) and the callbacks run when the re-issued read settles, so the flag cannot stick.
3. `named(projectContextId)`: the `workflowId`s of the machine's admitted uploads for that project, plus `watched.current.get(projectContextId)`, deduplicated, capped at `MAX_NAMED_INGESTIONS` (admitted first).
4. `ensurePolling(projectContextId)`: if no poller, start one with `list: (signal) => listSourceIngestions(projectContextId, named(projectContextId), signal)`, `busy: () => (ingestionsRef.current[projectContextId]?.ingestions.some(isLiveIngestion) ?? false) || named(projectContextId).length > 0`, and `onReading`:

```ts
(reading) => {
  if (reading.kind === 'gone') {
    stopPolling(projectContextId)
    dropIngestions(projectContextId)
    sendIngestion({ type: 'project.deleted', projectContextId })   // deleted in another tab: drop local ownership too
    return
  }
  if (reading.kind === 'unavailable') {
    setIngestions((current) => ({ ...current, [projectContextId]: {
      status: current[projectContextId]?.ingestions.length ? 'ready' : 'unavailable',
      ingestions: current[projectContextId]?.ingestions ?? [], stale: true,
    } }))
    return
  }
  const { ingestions: listed, absent } = reading.listing
  sendIngestion({ type: 'ingestions.observed', projectContextId, workflowIds: listed.map((ingestion) => ingestion.workflowId), absent })
  watched.current.set(projectContextId, new Set(listed.filter(isLiveIngestion).map((ingestion) => ingestion.workflowId)))
  setIngestions((current) => ({ ...current, [projectContextId]: { status: 'ready', ingestions: listed, stale: false } }))
  // Reconciled by containment: a success counts once the branch holds its document, so a failed refresh retries.
  const branch = branchesRef.current[projectContextId]
  const held = new Set(branch?.status === 'ready' ? branch.detail.sourceDocuments.map((document) => document.sourceDocumentId) : [])
  if (listed.some((ingestion) => ingestion.status === 'succeeded' && !held.has(ingestion.sourceDocumentId)))
    refreshAfterIngestion(projectContextId)
  if (!observers.current.get(projectContextId) && !listed.some(isLiveIngestion) && named(projectContextId).length === 0)
    stopPolling(projectContextId)
}
```

5. `observeIngestions(id)`: increment `observers`; on the first observer, if the branch is `ready` (cached from an earlier visit), call `loadBranch(id, true)` once so work that finished while nothing observed the project appears; then `ensurePolling(id)`. The release decrements and stops the poller when the count is 0 and `named(id)` is empty and nothing live is listed.
6. Machine input: `onAdmitted: (item) => { ensurePolling(item.projectContextId); pollers.current.get(item.projectContextId)?.readNow() }`, `onReplayed: (item, document) => acknowledgeSourceDocument(item.projectContextId, document)`, `onIngested` for reprocess as today.
7. `deleteProject`: after the acknowledged deletion, `stopPolling(id)`, `dropIngestions(id)` and `watched.current.delete(id)`.
8. `dismissIngestion(id, workflowId)`: `await dismissSourceIngestion(...)`, then remove the row locally and `readNow()`; return `failure(error)` on error (the row stays).
9. Stop every poller on unmount (`useEffect(() => () => { for (const poller of pollers.current.values()) poller.stop() }, [])`).

Admitted IDs are read from the machine's current snapshot through `useMachine`'s actor ref (`const [ingestion, sendIngestion, ingestionActor] = useMachine(...)`), so the pollers' callbacks never close over a stale render.

- [ ] **Step 4: Run and see them pass**

Run: `pnpm exec vitest run src/ProjectNavigation.test.tsx -t "Source Ingestions in the provider"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add prototypes/studio/src/projectContexts/ProjectContextsProvider.tsx prototypes/studio/src/projectContexts/useProjectContexts.ts prototypes/studio/src/ProjectNavigation.test.tsx
git commit -m "fix(studio): observe Source Ingestions in the provider and refresh on completion"
```

### Task 7: The Project page renders one list

**Files:**
- Modify: `prototypes/studio/src/projectContexts/ProjectContextPage.tsx` (replace the uncommitted `useServerIngestions`/`serverOnlyIngestions` wiring), `prototypes/studio/src/ProjectNavigation.test.tsx`

**Interfaces:**
- Consumes: `ingestions`, `observeIngestions`, `dismissIngestion`, `ingestingSources`, `retrySource` from Task 6.

- [ ] **Step 1: Write the failing tests** (replace the uncommitted `describe('uploads the server is still ingesting')`; the listing fake serves the new contract)

- `keeps a parse on the page after a reload, then shows the Source Document it became` — the uncommitted test, with the second listing returning `succeeded` instead of dropping the row.
- `two admissions of one workflow render one card` — two files whose POSTs both answer 202 with the same `workflowId`, **with the listing read held** → one card; after the listing is released, still one card.
- `an admitted upload shows Queued at once, before the next listing` — hold the listing read; after the 202 the card says *Queued*.
- `a failure survives a reload and Dismiss removes it` — listing has a `failed` row → message shown, `Dismiss <name>` button; clicking sends `DELETE …/source-ingestions/<encoded id>` and the card goes; a 503 on DELETE keeps the card and shows the failure message.
- `Upload again opens the file chooser` — clicking it calls `click()` on the drop zone's file input (spy on `HTMLInputElement.prototype.click`).
- `an unavailable listing keeps the cards and says status is unavailable` — second read 503 → cards stay, a `role="status"` line reads `Ingestion status is unavailable; retrying.`
- `pending attempts do not change the Source Document count` — the rail's count stays at the branch's documents.
- `the status line lists sending, queued, parsing and failed items` — e.g. `A.pdf: sending. B.pdf: queued. C.pdf: parsing. D.pdf: failed. kei refused the PDF.`

Update the existing `multi-PDF ingestion on the Project Context page` tests (line 1830 onward) to answer 202 + listing rows instead of 201-after-wait; their intent (order of sends, no key, one card per file, retry of the failed one) stays, with "failed" now meaning a listed failure for B.pdf and **Upload again** replacing **Retry** for it.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run src/ProjectNavigation.test.tsx`
Expected: FAIL in the new and updated ingestion tests only.

- [ ] **Step 3: Implement**

In `ProjectContextPage.tsx`:

```ts
const { ingestions, observeIngestions, dismissIngestion } = useProjectContexts()
useEffect(() => observeIngestions(projectContextId), [observeIngestions, projectContextId])
const listed = ingestions[projectContextId]
const local = ingestingSources.filter((source) => source.projectContextId === projectContextId)
const shownIds = new Set(listed?.ingestions.map((ingestion) => ingestion.workflowId) ?? [])
// One list: local items until Studio lists them, then the listing's rows. Succeeded rows are the branch's documents.
const localCards = local.filter((source) => source.kind === 'reprocess' || !source.workflowId || !shownIds.has(source.workflowId))
const serverCards = (listed?.ingestions ?? []).filter((ingestion) => ingestion.status !== 'succeeded')
const fileInput = useRef<HTMLInputElement>(null)
```

Render `localCards` first (label: `sending`/`waiting` → *Sending…*, `admitted` → *Queued*, reprocess `queued`/`parsing` as today, `failed` with the existing Retry rule), then `serverCards` (*Queued*, *Parsing…*, or the failure message with **Upload again** — `fileInput.current?.click()` — and **Dismiss** calling `dismissIngestion`, showing its returned failure message inline on error). Give the drop zone's `<input type="file">` the `fileInput` ref. When `listed?.stale`, render `<p role="status">Ingestion status is unavailable; retrying.</p>` above the list. Update `sourceStatus`, the list's render condition and the empty state to count `localCards` and `serverCards`.

- [ ] **Step 4: Run and see them pass**

Run: `pnpm exec vitest run src/ProjectNavigation.test.tsx src/sourceIngestionMachine.test.ts`
Expected: PASS.

- [ ] **Step 5: Full unit tier, typecheck, lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass; no reference to `useServerIngestions` or `serverOnlyIngestions` remains (`grep -rn "serverOnlyIngestions\|useServerIngestions" src` prints nothing).

- [ ] **Step 6: Commit**

```bash
git add prototypes/studio/src/projectContexts/ProjectContextPage.tsx prototypes/studio/src/ProjectNavigation.test.tsx
git commit -m "fix(studio): keep Source Ingestions on the Project page across reloads and tabs"
```

### Task 8: PostgreSQL tier

**Files:**
- Modify: `prototypes/studio/api/source_ingestion.postgres.test.ts` (the scenario `test/support/scenarios/ingestion-publish.ts` was adapted in Task 3)
- Create: `prototypes/studio/api/source_ingestions.postgres.test.ts`

**Interfaces:**
- Produces test helpers in `source_ingestion.postgres.test.ts`: `admit(project, pdf): Promise<string>` (POST, assert 202, return `workflowId`) and `settled(project, workflowId): Promise<SourceIngestion>` (poll the real listing handler every 50 ms until the row is `succeeded` or `failed`, 60 s cap). Waits live only in tests.

- [ ] **Step 1: Adapt the existing tests** — every test that awaited a 201 document from the POST now calls `admit` then `settled` and reads the document through the store. Rename `a re-upload after a lost response joins the active attempt and returns its document; a 504 preserves the work` to `a re-upload while the attempt is live answers the same workflow ID and publishes once`. `completed content replays before parsing` keeps its 201.

- [ ] **Step 2: Add** (in `source_ingestions.postgres.test.ts`, on the real DBOS runtime and kei stand-in the tier already launches):
  - `small and large uploads both answer 202 before either conversion is released`
  - `a typed parse failure is listed after a new listing request and releases deduplication`
  - `a re-upload after a failure supersedes the failure in the listing`
  - `Dismiss deletes a failed attempt's history and it stays gone for another request`
  - `an attempt cancelled in this process is refused with 409 ingestion_stopping, and nothing of its chain is deleted` (the post-restart half is Task 9's recovery spec, which really restarts Studio)
  - `a stopped attempt whose content was published is listed as succeeded` (reuse the commit-before-checkpoint kill from `test/support/scenarios/ingestion-publish.ts`)
  - `dismissing the newest failure of a content removes the older ones too`
  - `project deletion makes the listing answer 404 before any history is collected`

- [ ] **Step 3: Run**

Run: `pnpm test:postgres api/source_ingestion.postgres.test.ts api/source_ingestions.postgres.test.ts`
Expected: PASS (needs `DATABASE_URL` equal to the disposable `EXTRACTION_TEST_DATABASE_URL`, `test/support/postgres.ts:5-15`).

- [ ] **Step 4: Commit**

```bash
git add prototypes/studio/api/source_ingestion.postgres.test.ts prototypes/studio/api/source_ingestions.postgres.test.ts prototypes/studio/test/support/scenarios
git commit -m "test(studio): prove admission, listing and dismissal of Source Ingestions on PostgreSQL"
```

### Task 9: Browser, real-service and system flows

**Files:**
- Modify: `prototypes/studio/e2e/project-navigation.spec.ts:452-557` (route fakes answer 202 and serve `**/source-ingestions`), `prototypes/studio/e2e/real-service.spec.ts:20, 67, 181, 403-455` (upload helper), `tests/contract.test.mjs:91-104`
- Modify: `prototypes/studio/playwright.recovery.config.ts:33` (`testMatch: ['interactive-restart.spec.ts', 'source-ingestion-restart.spec.ts']`)
- Create: `prototypes/studio/e2e/sourceIngestion.ts` with two helpers, admission kept apart from settlement: `admit(page, project, pdf): Promise<string>` (POST, assert 202, return `workflowId`) and `settle(page, project, workflowId): Promise<SourceIngestion>` (poll `GET …/source-ingestions?workflowId=…` until the row is `succeeded` or `failed`, return it; the caller decides which it expects)
- Create: `prototypes/studio/e2e/source-ingestion-restart.spec.ts`

- [ ] **Step 1:** `project-navigation.spec.ts` — the filename-boundary test keeps its assertions with the route answering 202 `{ workflowId }` and a listing route answering the row; replace `a timed-out Source Document stays item-scoped and retries by keyboard` with `an unacknowledged upload stays item-scoped and retries by keyboard` (first POST 504, retry 202) and add `a listed failure is dismissed by keyboard`.
- [ ] **Step 2:** `real-service.spec.ts` — every direct `page.request.post(…/source-documents)` goes through `admit` + `settle` and asserts `succeeded`; `a PDF that neither parser opens is refused without a Source Document` (lines 286–298) asserts `admit` then `settle` → `failed` with `failure.code === 'source_ingestion_failed'` instead of a 422 from the POST, keeping its kei-lane and no-document assertions; add `two selected PDFs are admitted before the held conversion finishes, and a reload keeps both cards` using the existing `FREE_REAL_SERVICE_CONVERSION_HOLD` barrier (`e2e/holdConversionWorker.py`): select two PDFs, wait for `entered`, assert two cards, `page.reload()`, assert both cards, write `release`, assert both documents in the rail.
- [ ] **Step 3a:** `source-ingestion-restart.spec.ts` (recovery tier, `killStudio()` from `e2e/studioRestart.ts`): `an admitted upload survives a Studio kill and publishes once` (admit, hold the conversion, `killStudio()`, release, the page shows one Source Document) and `a failure stopped before a Studio restart can be dismissed after it` (while the conversion is held, cancel the workflow with a test-side `DBOSClient` on the stack's database — `cancelWorkflow(workflowId)`; nothing in the product cancels an upload of a surviving project — so the row is `CANCELLED`; assert DELETE 409 `ingestion_stopping`, `killStudio()`, assert DELETE 204 and the card gone in a second tab).
- [ ] **Step 3:** `tests/contract.test.mjs` — `ingestion: a PDF source document uploads and parses` asserts 202, polls the listing (5 min cap) and then reads the document; the non-PDF rejection test is unchanged.
- [ ] **Step 4: Run**

```bash
pnpm exec playwright test e2e/project-navigation.spec.ts
pnpm test:e2e:recovery       # restartable Studio; runs source-ingestion-restart.spec.ts
pnpm test:service            # real Parsing Service tier; needs the service stack
node --test ../../tests/contract.test.mjs   # full system; needs a running deployment
```

Expected: PASS where the infrastructure is available; record which tiers ran in the PR description.

- [ ] **Step 5: Commit**

```bash
git add prototypes/studio/e2e tests/contract.test.mjs
git commit -m "test(studio): cover asynchronous admission, reload and dismissal end to end"
```

## Part B — reprocessing (stacked PR)

### Task 10: Reprocess answers on admission and is listed

**Files:**
- Modify: `prototypes/studio/api/source_reprocess.ts:134-160`, `api/source_reprocess.test.ts`, `api/source_reprocess.postgres.test.ts`, `shared/sourceDocumentReprocess.contract.ts` (drop `REPROCESS_TERMINAL_HEADER`), `shared/sourceDocumentIngestion.contract.ts` (add `kind: 'upload' | 'reprocess'` and, for reprocess, `sourceDocumentId`; a reprocess success carries `sourceRepresentationId`), `api/source_ingestions.ts` (list `reprocessSource` too: `workflowName: [INGEST_SOURCE, REPROCESS_SOURCE]`; supersession by `requestFingerprint` for reprocess; a stopped reprocess whose revision was published is listed as `succeeded` via `store.findReprocessedSourceDocument`, batched per listing), `src/projectContexts/transport.ts` (`ReprocessAdmission`, remove `terminalOutcome`), `src/sourceIngestionMachine.ts` (reprocess items get `admitted` like uploads; the `reprocesses` region is deleted — both kinds share the one send queue again, now that nothing waits on a parse), `ProjectContextsProvider.tsx` (a reprocess `succeeded` row updates `sourceRevisions` only when its representation differs from the current one), `ReprocessSourceModal.tsx` (a listed reprocess failure offers **Reprocess again**, which opens the modal against the current representation with a new request key).

- [ ] Steps follow Tasks 2–7's pattern: failing tests first — `returns 202 after first admission and on a same-key join`, `keeps completed revision replay at 200`, `rejects a changed fingerprint before admitting`, `keeps the expected-head check for a new request key`, `lists a stopped reprocess whose revision was published as succeeded`, `an older reprocess success cannot move the reopen notification backwards`, `a reprocess no longer holds uploads back because nothing waits on a parse` — then the implementation, `pnpm test && pnpm typecheck && pnpm lint`, `pnpm test:postgres api/source_reprocess.postgres.test.ts`, commit `feat(studio)!: answer reprocessing on admission and list it with Source Ingestions`.

This task is written at a coarser grain on purpose: its exact code depends on Part A's merged shapes. Before executing it, expand it to Part A's step granularity against the merged code.

## Task 11: Documentation (Part A PR)

**Files:**
- Modify: `CONTEXT.md` (add **Source Ingestion** after **Source Document**, with `_Avoid_: upload job, parse job`), `prototypes/studio/README.md:88-92` (uploads survive reload once admitted; files not yet sent do not; reprocess until Part B), `docs/plans/2026-09-24-unified-durable-execution.md:439-441, 1835-1837` and `docs/plans/2026-09-26-dbos-m4-studio-background.md` (one-line pointers to this plan where the thirty-minute wait and the out-of-scope line are stated; the old text stays as history)
- Create: `docs/adr/0012-server-owned-source-ingestion.md` (context, decisions 1–5, consequences: staged backlog grows faster on a large drop, kei lanes now see every upload at once, polling cost of 2 DBOS reads per observed project per 3 s while busy)

- [ ] **Step 1:** write the texts above.
- [ ] **Step 2:** `git diff --check` and `pnpm lint` (Markdown is not linted; this catches stray whitespace).
- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md prototypes/studio/README.md docs/plans/2026-09-24-unified-durable-execution.md docs/plans/2026-09-26-dbos-m4-studio-background.md docs/adr/0012-server-owned-source-ingestion.md
git commit -m "docs: record server-owned Source Ingestion"
```

## Risks and questions for the user

1. **Dismiss deletes history** (decision 3) rather than recording a preference. Accept, or prefer Codex's dismissal table?
2. **Failures stay 30 days, successes are synchronization-only for 15 minutes.** Enough?
3. **A second, idle tab discovers new work within 30 s.** Acceptable, or should an open Project page poll faster?
4. **Files not yet sent are still lost on reload.** A `beforeunload` prompt while items are `waiting`/`sending` is a small follow-up; not in this plan.
5. **Faster admission grows the staged backlog** (every selected PDF lands in `source-inbox` at once). No quota is added.
6. **"Parsing…" means Studio's workflow is running**, which includes waiting in kei's lane behind other conversions (`api/_ingestion_workflow.ts:172-188`); telling the two apart needs a kei read per attempt and is not in this plan.
7. **A crash-stopped attempt of a document that was then deleted** is listed as a failure (its content is no longer published) and can be dismissed; nothing reprocesses it on its own.
8. **Branch base.** The plan branches from `6e641b6`; confirm, or name the base the PR should target.

## Review log

- **Independent drafts.** Claude and Codex (gpt-6-astra, read-only, 2026-09-27) drafted separately from the same brief; this merge takes:
  - from Codex: the 202 body carries only `workflowId` (no fabricated status); terminal failures from `SUCCESS/ok:false` with their typed reason; 30-day failure retention on `completedAt`; recent successes in the listing so completions before the first read are not missed; provider-owned polling with an idle heartbeat, visibility pause and backoff that never reads an outage as "nothing in flight"; reprocessing must not hold uploads back and eventually moves to the same model; identity-based reconciliation and deletion of `serverOnlyIngestions`.
  - from Claude: supersession of a failure by a newer attempt of the same content; dismissal by deleting the failed attempt's history (with a boot-boundary guard for in-process cancellations) instead of a new table; a short success window instead of 30 days of successes; skipping an unreadable row instead of failing the listing with 503; admitted items held locally until listed, so the card never blinks between the 202 and the next read; Part B as a stacked PR.
  - rejected from Codex: a dismissal-preference table and migration; home-page summary polling; replacing Playwright's `pnpm` migration call and a repository-wide "no pnpm" rule (that was a constraint on Codex's sandbox, not on the project); a validation-evidence document for this change.
- **Adversarial review** (Codex gpt-6-astra, read-only, 2026-09-27, session `01a0e1cb-096f-7f50-a974-3091e4b571a1`). All findings verified against the code and accepted:
  - P0 dismissal bypassed M6's quiescence rule (exhausted rows, missing `updatedAt`) → Decision 3 and `isQuiescent` use M6's exact predicate; tests for both stopped statuses and a missing timestamp.
  - P1 dismissing the newest failure resurrected older ones → dismissal deletes the content's whole failed chain, all-or-nothing under the predicate (the reviewer's alternative, a dismissal table, stays rejected with the reason in Decision 3).
  - P1 admitted items stranded when their ID left every window, was dismissed elsewhere, or the project was deleted elsewhere → named `workflowId`s with `absent` in the listing; `gone` sends `project.deleted`.
  - P1 parallel live/terminal reads could miss a completion between snapshots → sequential reads, and the poller keeps naming the previously live IDs until they resolve.
  - P1 a crash after publication listed a failure beside the document → failures are checked against published content (`findSourceDocumentIdsByContent`) and listed as successes.
  - P1 a success was "used up" by one failed refresh, and a return after the window left a cached branch stale → reconciliation by branch containment; a re-read when a cached project is observed again.
  - P1 duplicate admissions rendered two local cards → the machine keeps one admitted item per `workflowId`.
  - P1 test migration gaps (201 assertions in kept tests, the crash scenario, the unreadable-PDF service test, no real Studio restart) → named explicitly in Tasks 3, 8 and 9; a recovery-tier spec with `killStudio()`.
  - P2 malformed output inconsistent between listing and dismissal → one validating `classifyOutcome`; P2 global generation bump → branch-only fence (also found in Claude's self-review); snippet fixes: explicit `IngestionPollingOptions`, `retried` narrowed to reprocess, `readNow` during a read schedules one more.
  - Counter-arguments recorded, not adopted: the POST no longer delivers the outcome directly, so correctness now rests on observation (addressed by named IDs and containment); "Parsing" is not evidence of GPU work (Risk 6); Part B's deferral keeps a temporary parallel region (accepted: reprocess has its own identity and head-check contracts, and the region is deleted in Task 10).
  - Live-only questions carried to the PR: late checkpoints or file writes from stopped executions across dismissal and GC; deploying Part A over in-flight old-version ingestions; admission latency, staged-disk growth and pool contention under multi-tab batches; recovery after real tab suspension and network loss.
