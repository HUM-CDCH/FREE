# View-Ordered Streaming Extraction — Studio Client Implementation Plan (Part B)

Execution status, 2026-10-03: implemented and reviewed locally; delivery awaits
a separate researcher decision. The [SDD execution ledger](2026-10-03-view-ordered-streaming-client-sdd-ledger.md)
records verification, infrastructure limits, and rulings that supersede the
planning examples below (especially state mapping and progress retention).
The checklists below preserve the original plan; commits and infrastructure
execution were deferred at the local delivery boundary.

> **Superseded in part (2026-10-04)** by `docs/superpowers/specs/2026-10-04-results-review-redesign-design.md` §5.5: the Global Constraint "the partial view offers no review controls", Task 2's `PartialResults` component and Ruling 7 (two components, order changing at settlement), the ` · started at page {n}` copy and the count appended to the run button are replaced there. Task 1 (the partial on the running state, `retainFinished`, `startPage`) and Task 3's overlay rulings stand.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the researcher each record as it is read: the Results tab lists a running Extraction's records in the order kei reads them, every value in one of the six states, with a progress line and a "k of n" badge; Run sends the page being read so those records come first; Evidence highlights draw as links arrive; the settled result takes the view's place when the attempt settles.

**Architecture:** Everything is in `prototypes/studio/src`. The two-second poll in `useExtraction` already reads `GET /api/extractions/:id`; it now keeps the response's `partial` (Part A) on the monitor and on the `running` state, never letting a finished record regress between reads or across a reconnect. `ResultsTab` renders that partial through the redesign's `RecordHeader`, `ResultValue` with `getValueState` and `getContested`, and `ProgressBar`; `resultsBadgeFor` reads the counts; `useEvidenceOverlays` paints the partial's links while the attempt runs without moving the page; `App.runExtraction` passes `currentPage` as `startPage`. No new server, contract or package code: Part A supplies `partial` and `startPage`.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4 tokens (`text-content`, `text-secondary`, `text-compact`, `text-overline`), Vitest + Testing Library (`// @vitest-environment jsdom`), Playwright (`e2e/canonical-evidence-lifecycle.spec.ts` with the kei stand-in).

**Spec:** `docs/superpowers/specs/2026-10-02-view-ordered-streaming-extraction-design.md` §1, §5 (base: a fresh worktree from `origin/dev` after both `feat/view-ordered-streaming` (Part A, `docs/superpowers/plans/2026-10-03-view-ordered-streaming-service.md`) and `feat/studio-workspace-redesign` (`docs/superpowers/plans/2026-10-03-studio-workspace-redesign.md`) have merged). Create the worktree then: `git worktree add -b feat/view-ordered-streaming-client /home/gennaro/projects/FREE-worktrees/view-ordered-streaming-client origin/dev`.

## Global Constraints

- Base check before Task 1: on `origin/dev`, `prototypes/studio/shared/extraction.contract.ts` exports `partialResultSchema` (Part A) and `prototypes/studio/src/ui/ResultValue.tsx` exports `ValueState` and `RecordHeader` (the redesign). If either is missing, stop: this plan's base has not merged.
- No new dependency; no `pnpm add`. Install with `pnpm install --prefer-offline --frozen-lockfile --ignore-scripts` then `DATABASE_URL=postgresql://contract:emit@127.0.0.1:5432/free pnpm db:generate`; never a bare `pnpm install`.
- Tokens and type from `DESIGN.md` and `src/index.css` as the redesign left them: `text-content`, `text-secondary`, `text-compact`, `text-overline`; no new `text-[…px]`. Colour is never the only signal: every state has a text equivalent (the `aria-label`s "Reading" and "Queued", the title "Candidate · being verified", the "Contested" and "Missing" badges).
- A candidate is never shown as a value (spec, Constraints): a `checking` value renders only through `ResultValue`'s `checking` state (muted ink, hollow marker); this plan adds no other rendering of a candidate.
- The settled attempt stays the record of truth: review, finalize and export read it only; the partial view offers no review controls (no `review` prop on its `ResultValue`s).
- The wire type is the client's type: `PartialResult`, `PartialRecord` and `PartialValue` come from `../shared/extraction.contract`; a test that builds a partial from the shared fixture goes through `partialResultSchema.parse(partialFromProgress(fixture))`, never a cast.
- Copy follows `CONTEXT.md` and the redesign: "researcher", never "user"; never "JSON" in a label. New copy, verbatim: `Reading records · {finished} of {discovered}`, ` · started at page {n}` (appended only when a start page is known), `Reading the document · {answered} of {contexts} contexts`, `Records read` (the progress bar's label), `Extraction in progress` (the section's label), `Records being read` (the list's label).
- Lint: `react-refresh/only-export-components` is on; a `.tsx` component file exports its component only. Pure helpers live in `.ts` files.
- The two-second poll stays; no new transport.
- Every commit: `pnpm -C prototypes/studio typecheck`, `pnpm -C prototypes/studio lint`, and the touched test files pass. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` scoped paths only.
- Anchors in this plan are text, not line numbers: the base is a merged tree this plan has not seen. Find the text named, then edit.

## Rulings taken while planning (the controller may re-rule; each cites the spec text it resolves)

1. **Records keep the server's order.** §1 "listed in the order they were read": Part A's `partialFromProgress` orders by distance from the start page then source order (kei's own rule); the client never re-sorts.
2. **A `reading` or `queued` record's rows come from the pinned schema's record-level fields** (every top-level node without a `valueSource`), as placeholders, since kei has no values for it yet; once `record` exists its own keys win (a schema edited since the run still shows what kei read). §1: "placeholder, never text".
3. **Overlays never scroll the viewer for partial links, and a focused Evidence survives a poll.** §1 "Evidence highlights draw on the page as links arrive": a link arriving every two seconds must not move the page the researcher is reading, and a poll's new attempt object must not clear the focus they chose; only a settled result scrolls once, as today, and only another Extraction clears the focus.
4. **While a partial shows, the Results tab reports `['records']` as the result path**, so every record's links paint; the per-record navigation (`navPath`) is the settled view's and stays untouched.
5. **The badge reads "k of n" once `discovered` is known, "running" before** (§1 "the Results badge shows '7 of 48'"; before discovery there is nothing to count).
6. **`retainFinished` keeps a finished record until a finished record at least as grounded replaces it.** §5 "an entry once `finished` stays so until the settled result replaces it": a record read as `checking` after `finished` (a retry rewrote its candidates) keeps the finished record, and a finished record whose links came back empty (Part A's passages could not load for that read) keeps the one with links; `discovered` is the latest read's (kei's discovery is write-once). The retained partial lives on the monitor, so a reconnect after a failed read continues from it.
7. **The partial list and the settled list are two components; the swap is one render.** §1 "the settled result replaces the partial view in place (record index is the React key, so nothing flickers)": a shared keyed tree would put the settled view's navigation and review controls over partial records, out of this plan's scope. At the terminal read the partial is dropped, the partial list unmounts and the settled list mounts in the same scroll container; the records' order changes once, from reading order to source order. No DOM continuity is promised; the human may overrule.
8. **The client derives no value state of its own:** `grounded`, `checking`, `reading`, `empty` and `contested` come from Part A's `values`, keyed by leaf path (the converter enumerates leaves, so a container path has no entry and `ResultValue` renders containers through their leaves); Part A knows about failed windows and contexts (its Ruling 7). A leaf the record has but `values` lacks cannot occur; a record without values is `reading` or `queued` as a whole.

## Review Focus

1. **A reload while an Extraction runs** (the restored monitor): the first read fills the partial and the Results tab shows it without any click — Task 1 (`watch` with a restored `initialAttempt`) and Task 3 (App).
2. **A record whose fields are not in the pinned schema** (the schema was edited after Run): its own keys render; placeholders are for records without values — Task 2.
3. **A partial link whose anchor is not in the pinned document:** no overlay, no error, the value still shows `grounded` — Task 3.
4. **A read that returns no partial after one that did** (kei slow for one poll), and a reconnect after a failed read: the view keeps the last partial; nothing flickers back to the spinner — Task 1.
5. **The settled result arrives:** the partial unmounts, the settled records render, the badge changes to "n to check", the run button loses its count — Tasks 2 and 3.

---

## File structure

New: `src/partialResult.ts` (`retainFinished`, `partialHeadline`, `partialValueState`), `src/partialResult.test.ts`, `src/PartialResults.tsx`, `src/PartialResults.test.tsx`.

Edited: `src/extraction.ts`, `src/useExtraction.ts`, `src/useExtraction.test.tsx`, `src/resultsBadge.ts`, `src/resultsBadge.test.ts`, `src/ResultsTab.tsx`, `src/ResultsTab.test.tsx`, `src/RightRail.test.tsx`, `src/useEvidenceOverlays.ts`, `src/useEvidenceOverlays.test.ts`, `src/App.tsx`, `src/App.test.tsx`, `e2e/canonical-evidence-lifecycle.spec.ts`, `docs/superpowers/specs/2026-10-02-view-ordered-streaming-extraction-design.md` (Status), `DESIGN.md` (one line under the Results section).

---

### Task 1: The partial on the running state, never regressing; Run names the page being read (§5)

**Files:**
- Create: `prototypes/studio/src/partialResult.ts`, `prototypes/studio/src/partialResult.test.ts`
- Modify: `prototypes/studio/src/extraction.ts`, `prototypes/studio/src/useExtraction.ts` (`Monitor`, `ExtractionRunRequest`, `extractionStateFromAttempt`, `watch`, `reconnect`, `runRequest`'s `setState`, `runExtraction`)
- Test: `prototypes/studio/src/useExtraction.test.tsx`; every `{ status: 'running', step: 'extraction' }` literal in `src/*.test.tsx` and `src/*.test.ts` gains `partial: null`

**Interfaces:**
- Consumes: `PartialResult`, `PartialRecord`, `PartialValue` from `../shared/extraction.contract` (Part A); `readExtraction(...)` resolves `{ extraction, pendingReviewDecisions, partial?, reviewDraft? }`; `requestExtraction` accepts `startPage` (Part A's `extractionRequestSchema`).
- Produces: `ExtractionState` `running` variant `{ status: 'running'; step: 'extraction'; partial: PartialResult | null }`; `extractionStateFromAttempt(attempt, partial = null)`; `retainFinished(previous, next)`; `Monitor.partial`; `runExtraction(method, target?, strategy?, catalogRecipe?, startPage: number | null = null)`.

- [ ] **Step 0: Pre-flight on the merged tree** (write the findings to the ledger): `grep -n "export type ValueState\|export function RecordHeader" prototypes/studio/src/ui/ResultValue.tsx`, `grep -n "RecordHeader\|ValueState" prototypes/studio/src/ui/index.ts`, `grep -n "export function resultsBadgeFor" prototypes/studio/src/resultsBadge.ts`, `grep -n "saved.refresh()\|extraction.runExtraction(" prototypes/studio/src/App.tsx`, `grep -n "headerExtras\|getValueState\|getContested" prototypes/studio/src/ResultsTab.tsx`, `grep -n "partialResultSchema\|partialValueSchema\|startPage" prototypes/studio/shared/extraction.contract.ts`, `grep -n "partialFromProgress" packages/extraction/src/index.ts`. Each must print a line. Where a name differs from this plan's, re-anchor to the shipped name and record the ruling; where one is absent, stop (the base has not merged).

- [ ] **Step 1: Write the failing tests.** `src/partialResult.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { EvidenceLink } from '../shared/groundedExtraction'
import type { PartialRecord, PartialResult } from '../shared/extraction.contract'
import { partialHeadline, partialValueState, retainFinished } from './partialResult'

const link = (index: number): EvidenceLink => ({ resultPath: ['records', index, 'site'], evidenceAnchorId: 'a_p1_s0' })
const record = (index: number, state: PartialRecord['state'], site: string | null = null, links: EvidenceLink[] = []): PartialRecord => ({
  index, label: String(index + 1), page: 1, state,
  record: state === 'queued' || state === 'reading' ? null : { site },
  values: state === 'queued' || state === 'reading' ? {} : { [JSON.stringify(['site'])]: { value: site, state: links.length ? 'grounded' : 'checking' } },
  evidenceLinks: links,
})
const partial = (records: PartialRecord[], finished = records.filter((each) => each.state === 'finished').length): PartialResult =>
  ({ strategy: 'CATALOG', startedAtPage: 1, discovered: 3, finished, records, document: null })

describe('retainFinished', () => {
  it('keeps the last partial when a read brings none', () => {
    const shown = partial([record(0, 'finished', 'Adorf')])
    expect(retainFinished(shown, null)).toBe(shown)
    expect(retainFinished(null, null)).toBeNull()
  })
  it('takes a first partial as it is', () => {
    const next = partial([record(0, 'checking', 'Adorf')])
    expect(retainFinished(null, next)).toBe(next)
  })
  it('a record once finished stays finished until the settled result replaces it', () => {
    const previous = partial([record(0, 'finished', 'Adorf', [link(0)]), record(1, 'checking', 'Bdorf')])
    const next = partial([record(0, 'checking', 'Adorf'), record(1, 'finished', 'Bdorf', [link(1)]), record(2, 'reading')])
    const merged = retainFinished(previous, next)!
    expect(merged.records.map((each) => [each.index, each.state])).toEqual([[0, 'finished'], [1, 'finished'], [2, 'reading']])
    expect(merged.records[0]).toBe(previous.records[0])
    expect(merged.finished).toBe(2)
    expect(merged.discovered).toBe(3)
  })
  it('a finished record whose links came back empty keeps the one with links', () => {
    const previous = partial([record(0, 'finished', 'Adorf', [link(0)])])
    const next = partial([record(0, 'finished', 'Adorf', [])])
    expect(retainFinished(previous, next)!.records[0]).toBe(previous.records[0])
    const more = partial([record(0, 'finished', 'Adorf', [link(0), { resultPath: ['records', 0, 'label'], evidenceAnchorId: 'a_p1_s0' }])])
    expect(retainFinished(previous, more)!.records[0]).toBe(more.records[0])
  })
})

describe('partialHeadline and partialValueState', () => {
  it('names the records read, the start page only when known, and the document\'s contexts', () => {
    const shown = partial([record(0, 'finished', 'Adorf')])
    expect(partialHeadline({ ...shown, finished: 2, discovered: 5 })).toBe('Reading records · 2 of 5 · started at page 1')
    expect(partialHeadline({ ...shown, finished: 2, discovered: 5, startedAtPage: null })).toBe('Reading records · 2 of 5')
    expect(partialHeadline({ ...shown, strategy: 'ARTICLE', document: { contextsAnswered: 1, contexts: 3, groundingBatches: 0 } }))
      .toBe('Reading the document · 1 of 3 contexts')
  })
  it('reads a value\'s state from the partial, and a record without values as being read', () => {
    const finished = record(0, 'finished', 'Adorf', [link(0)])
    expect(partialValueState(finished, ['site'])).toBe('grounded')
    expect(partialValueState({ ...finished, values: { ...finished.values, [JSON.stringify(['gilded'])]: { value: null, state: 'contested', candidates: ['a', 'b'] } } }, ['gilded'])).toBe('contested')
    expect(partialValueState(record(3, 'reading'), ['site'])).toBe('reading')
    expect(partialValueState(record(4, 'queued'), ['site'])).toBe('queued')
  })
})
```

In `src/useExtraction.test.tsx`, the case that advances a QUEUED run to RUNNING then COMPLETED (the one asserting `expect(result.current.state).toEqual({ status: 'running', step: 'extraction' })`) becomes a partial-carrying run; replace its two `readExtraction` answers and the running assertion:

```ts
    const reading = partialFor([{ index: 0, state: 'finished' as const }, { index: 1, state: 'reading' as const }])
    const regressed = partialFor([{ index: 0, state: 'checking' as const }, { index: 1, state: 'finished' as const }])
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: provisional, pendingReviewDecisions: null, partial: reading })
      .mockResolvedValueOnce({ extraction: provisional, pendingReviewDecisions: null })            // kei slow: no partial this read
      .mockResolvedValueOnce({ extraction: provisional, pendingReviewDecisions: null, partial: regressed })
      .mockResolvedValueOnce({ extraction: attempt(), pendingReviewDecisions: [] })
    …
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.attempt?.executionStatus).toBe('RUNNING')
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: reading })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: reading })   // kept, not dropped
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect((result.current.state as { partial: PartialResult }).partial.records.map((each) => each.state)).toEqual(['finished', 'finished'])
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); await run })
    expect(result.current.state.status).toBe('ready')
    expect(result.current.state).not.toHaveProperty('partial')
```

with a module-level helper:

```ts
function partialFor(records: Array<{ index: number; state: PartialRecord['state'] }>): PartialResult {
  return {
    strategy: 'CATALOG', startedAtPage: 1, discovered: records.length,
    finished: records.filter((each) => each.state === 'finished').length,
    records: records.map(({ index, state }) => ({
      index, label: String(index + 1), page: 1, state,
      record: state === 'queued' || state === 'reading' ? null : { title: `Record ${index + 1}` },
      values: state === 'queued' || state === 'reading' ? {} : { [JSON.stringify(['title'])]: { value: `Record ${index + 1}`, state: state === 'finished' ? 'grounded' : 'checking' } },
      evidenceLinks: [],
    })),
    document: null,
  }
}
```

Add three cases:

```ts
  it('a restored running job shows its partial from the first read', async () => {
    vi.useFakeTimers()
    const restored = jobAttempt()
    const reading = partialFor([{ index: 0, state: 'reading' }])
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: restored, pendingReviewDecisions: null, partial: reading })
    const { result } = renderHook(() => useExtraction(options(restored)))
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: null })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: reading })
    vi.useRealTimers()
  })

  it('a reconnect after a failed read continues from the partial shown, even when the first read back has none', async () => {
    vi.useFakeTimers()
    const restored = jobAttempt()
    const shown = partialFor([{ index: 0, state: 'finished' }])
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: restored, pendingReviewDecisions: null, partial: shown })
      .mockRejectedValueOnce(new ApiRequestError('Service Unavailable', 503))
      .mockResolvedValueOnce({ extraction: restored, pendingReviewDecisions: null })
    const { result } = renderHook(() => useExtraction(options(restored)))
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.monitorError).toBe(MONITOR_DISCONNECTED)
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: shown })
    act(() => result.current.reconnect())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.monitorError).toBeNull()
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: shown })
    vi.useRealTimers()
  })

  it('a run names the page being read; a run from no page names none', async () => {
    vi.mocked(api.requestExtraction).mockResolvedValue(jobAttempt({ executionStatus: 'QUEUED' }))
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: attempt(), pendingReviewDecisions: [] })
    const first = renderHook(() => useExtraction(options()))
    await act(async () => { await first.result.current.runExtraction(SERVICE_DEFAULTS, undefined, 'ARTICLE', null, 6) })
    expect(vi.mocked(api.requestExtraction).mock.calls[0]![0]).toEqual(expect.objectContaining({ startPage: 6 }))
    first.unmount()
    const second = renderHook(() => useExtraction(options()))
    await act(async () => { await second.result.current.runExtraction(SERVICE_DEFAULTS) })
    expect(vi.mocked(api.requestExtraction).mock.calls[1]![0]).not.toHaveProperty('startPage')
    second.unmount()
  })
```

(import `type PartialRecord, type PartialResult` from `'../shared/extraction.contract'`; `ApiRequestError`'s constructor arguments follow the file's existing failed-read cases; unmounting stops each hook's monitor, so the two runs never share one). Then `grep -rn "status: 'running', step: 'extraction' }" prototypes/studio/src --include=*.test.tsx --include=*.test.ts` and give every literal `partial: null` (ResultsTab.test.tsx, RightRail.test.tsx, App.test.tsx, resultsBadge.test.ts).

- [ ] **Step 2: Run them to verify they fail** — `pnpm -C prototypes/studio exec vitest run src/partialResult.test.ts src/useExtraction.test.tsx` → FAIL (module missing; state lacks `partial`).

- [ ] **Step 3: `src/extraction.ts`**

```ts
import type { PartialResult } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'

export type ExtractionState =
  | { status: 'idle' }
  /** Running, with what the two-second poll has read so far of it: null before the first partial (design §5). */
  | { status: 'running'; step: 'extraction'; partial: PartialResult | null }
  | {
      status: 'ready'
      result: Record<string, unknown>
      evidenceLinks: readonly EvidenceLink[]
      ungroundedCount: number
    }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }
```

- [ ] **Step 4: `src/partialResult.ts`**

```ts
import type { PartialRecord, PartialResult } from '../shared/extraction.contract'
import type { ValueState } from './ui'

/**
 * The partial to show after a read (design §5): the new one, with a record the previous read showed finished kept when
 * the new read shows it as less (a retry rewrote its candidates) or as finished with fewer links (the passages could not
 * be loaded for that read), so a partial never regresses; a read without a partial (kei slow for one poll) keeps what
 * is shown. The settled result replaces all of it.
 */
export function retainFinished(previous: PartialResult | null, next: PartialResult | null): PartialResult | null {
  if (next === null) return previous
  if (previous === null) return next
  const finished = new Map(previous.records.filter((record) => record.state === 'finished').map((record) => [record.index, record]))
  const records = next.records.map((record) => {
    const kept = finished.get(record.index)
    if (!kept) return record
    return record.state === 'finished' && record.evidenceLinks.length >= kept.evidenceLinks.length ? record : kept
  })
  return { ...next, records, finished: records.filter((record) => record.state === 'finished').length }
}

/** The Results header line of a run in progress (design §1): what is being read, how far, and from where. */
export function partialHeadline(partial: PartialResult): string {
  if (partial.strategy === 'ARTICLE')
    return partial.document
      ? `Reading the document · ${partial.document.contextsAnswered} of ${partial.document.contexts} contexts`
      : 'Reading the document'
  const from = partial.startedAtPage === null ? '' : ` · started at page ${partial.startedAtPage}`
  return `Reading records · ${partial.finished} of ${partial.discovered}${from}`
}

/** A value's state in a record still being read: the one the server derived for it (Part A knows about failed windows
 *  and contexts), or the record's own when it has no values yet (being read, or waiting). */
export function partialValueState(record: PartialRecord, path: readonly string[]): ValueState {
  const value = record.values[JSON.stringify(path)]
  if (value) return value.state
  return record.state === 'queued' ? 'queued' : record.state === 'reading' ? 'reading' : 'empty'
}
```

- [ ] **Step 5: `src/useExtraction.ts`.** Import `type PartialResult` from the contract and `retainFinished` from `./partialResult`. `Monitor` gains `/** What the poll has read so far of the Extraction (design §5); kept across a pause and reconnect. */ partial?: PartialResult | null`. `ExtractionRunRequest` gains `/** The page the researcher was reading when Run was clicked (one-based): the order kei reads records in. */ startPage?: number`. `extractionStateFromAttempt` becomes `export function extractionStateFromAttempt(attempt: ExtractionAttempt | null, partial: PartialResult | null = null): ExtractionState` and its running return `{ status: 'running', step: 'extraction', partial }`. In `watch`, the read becomes:

```ts
        const response = await readExtraction(monitor.extractionId, signal)
        if (!live()) return
        latest = response.extraction
        monitor.partial = retainFinished(monitor.partial ?? null, response.partial ?? null)
        monitor.unacknowledged = undefined
        setAttempt(latest)
        setState(extractionStateFromAttempt(latest, monitor.partial))
```

`reconnect` is unchanged in body: it calls `watch(monitor, …)` with the same monitor, whose `partial` survives. In `runRequest`, `setState({ status: 'running', step: 'extraction' })` becomes `setState({ status: 'running', step: 'extraction', partial: null })`; the request object `runRequest` posts already spreads `...request`, so `startPage` travels when present. `runExtraction` gains a fifth parameter `startPage: number | null = null` and passes `...(startPage === null ? {} : { startPage })` into the request object it builds.

- [ ] **Step 6: Run the tests to verify they pass** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/partialResult.test.ts src/useExtraction.test.tsx src/ResultsTab.test.tsx src/RightRail.test.tsx src/App.test.tsx` → PASS.

- [ ] **Step 7: Commit** — `feat(studio): the running state carries the partial view, kept from read to read and across a reconnect; Run names the page being read`.

---

### Task 2: The Results tab shows the records as they are read; the badge counts them (§1)

**Files:**
- Create: `prototypes/studio/src/PartialResults.tsx`, `prototypes/studio/src/PartialResults.test.tsx`
- Modify: `prototypes/studio/src/ResultsTab.tsx` (the `onResultPathChange` effect; the `{state.status === 'running' && (` branch), `prototypes/studio/src/resultsBadge.ts`
- Test: `prototypes/studio/src/ResultsTab.test.tsx`, `prototypes/studio/src/resultsBadge.test.ts`

**Interfaces:**
- Consumes: `ResultValue` with `getValueState`, `getContested` and `ValueState`, `RecordHeader` (`ui/index.ts`), `ProgressBar` (`ui`), `singularItemLabel` (`ui/ResultValue`), `resultsBadgeFor(controller)` (redesign), `ExtractionState.running.partial`, `partialHeadline`, `partialValueState` (Task 1).
- Produces: `PartialResults({ partial, schemaNodes, onSelectEvidence })` (the component, its file's only export); `resultsBadgeFor` takes `Pick<ExtractionController, 'attempt' | 'hasResults' | 'review' | 'state'>` and answers `{ label: 'k of n' }` during a run with a partial.

- [ ] **Step 1: Write the failing tests.** `src/PartialResults.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { partialFromProgress } from 'extraction'
import progressFixture from '../../parsing_service/tests/fixtures/contracts/extract.progress.json'
import type { SchemaNode } from 'extraction/schema'
import { partialResultSchema, type PartialResult } from '../shared/extraction.contract'
import PartialResults from './PartialResults'

afterEach(cleanup)

const schemaNodes: SchemaNode[] = [
  { id: 'l', name: 'label', type: 'string' }, { id: 's', name: 'site', type: 'string' }, { id: 'm', name: 'material', type: 'string' },
  { id: 'g', name: 'gilded', type: 'boolean' },
  { id: 'f', name: 'finds', type: 'array', children: [{ id: 'fn', name: 'name', type: 'string' }, { id: 'fc', name: 'count', type: 'integer' }] },
  { id: 't', name: 'title', type: 'string', valueSource: 'document' },
]
/** The shared fixture as the wire carries it: the package's converter, then the wire contract (never a cast). */
const partial = (): PartialResult => partialResultSchema.parse(partialFromProgress(progressFixture))
const items = () => within(screen.getByRole('list', { name: 'Records being read' })).getAllByRole('listitem')

describe('PartialResults', () => {
  it('names the progress, counts it on a progress bar and lists the records in the order they were read', () => {
    render(<PartialResults partial={partial()} schemaNodes={schemaNodes} />)
    expect(screen.getByRole('status')).toHaveTextContent('Reading records · 2 of 5 · started at page 1')
    expect(screen.getByRole('progressbar', { name: 'Records read' })).toHaveAttribute('aria-valuenow', '40')
    const listed = items()
    expect(listed.map((item) => item.getAttribute('data-record-state'))).toEqual(['finished', 'finished', 'checking', 'reading', 'queued'])
    expect(listed.map((item) => item.getAttribute('aria-label'))).toEqual(['1', '2', '3', '4', 'Record 5'])  // a missing label: the generic one
    expect(listed[0]).toHaveTextContent('· page 1')
    expect(listed[4]).toHaveTextContent('· page 4')
  })
  it('a finished record shows its values solid with their Evidence, a candidate muted, a null as Missing, a disagreement as Contested', () => {
    const onSelectEvidence = vi.fn()
    render(<PartialResults partial={partial()} schemaNodes={schemaNodes} onSelectEvidence={onSelectEvidence} />)
    const [first, second, third] = items()
    expect(within(first!).getByText('Holz')).toBeInTheDocument()
    within(first!).getByRole('button', { name: 'View Evidence for material' }).click()
    expect(onSelectEvidence).toHaveBeenCalledWith('a_p1_s0')
    expect(within(first!).getByText('Missing')).toBeInTheDocument()          // gilded is null in a finished record
    expect(within(second!).getByText('Contested')).toBeInTheDocument()       // site: arbitration chose none
    expect(within(second!).getByText(/Bdorf · Bdorf-Nord/)).toBeInTheDocument()
    const candidates = within(third!).getAllByTitle('Candidate · being verified')
    expect(candidates.map((element) => element.textContent)).toEqual(['3', 'Gold'])
    expect(within(third!).queryByRole('button', { name: /View Evidence/ })).not.toBeInTheDocument()
    expect(within(third!).getAllByText('Missing')).toHaveLength(2)          // site and gilded: the values call returned without them
  })
  it('a record being read shows one placeholder per record-level field and never text; a queued one only its header', () => {
    render(<PartialResults partial={partial()} schemaNodes={schemaNodes} />)
    const [, , , reading, queued] = items()
    expect(within(reading!).getAllByLabelText('Reading')).toHaveLength(5)   // label, site, material, gilded, finds: not the document field
    expect(within(reading!).queryByText('Missing')).not.toBeInTheDocument()
    expect(within(queued!).queryAllByRole('img')).toHaveLength(0)
    expect(within(queued!).queryByText('label')).not.toBeInTheDocument()
  })
  it('a record whose fields the pinned schema no longer names still shows its own fields', () => {
    render(<PartialResults partial={partial()} schemaNodes={[{ id: 'x', name: 'renamed', type: 'string' }]} />)
    const [first] = items()
    expect(within(first!).getByText('material')).toBeInTheDocument()
    expect(within(first!).queryByText('renamed')).not.toBeInTheDocument()
  })
})
```

In `src/resultsBadge.test.ts` every call gains a `state` argument (`state: { status: 'running', step: 'extraction', partial: null }` for the running case, `state: { status: 'ready', result: {}, evidenceLinks: [], ungroundedCount: 0 }` for the completed ones, `state: { status: 'idle' }` for the null attempt), plus:

```ts
  it('counts the records read during a run once discovery is known', () => {
    const partial: PartialResult = { strategy: 'CATALOG', startedAtPage: 1, discovered: 48, finished: 7, records: [], document: null }
    expect(resultsBadgeFor({ attempt: attempt('RUNNING'), hasResults: false, review: review(0), state: { status: 'running', step: 'extraction', partial } })).toEqual({ label: '7 of 48' })
    expect(resultsBadgeFor({ attempt: attempt('RUNNING'), hasResults: false, review: review(0), state: { status: 'running', step: 'extraction', partial: { ...partial, discovered: 0, finished: 0 } } })).toEqual({ label: 'running' })
  })
```

(import `type PartialResult` from `'../shared/extraction.contract'`). In `src/ResultsTab.test.tsx`, in `describe('ResultsTab extraction status')`, add:

```tsx
  it('shows the records as they are read instead of the spinner, reports the records path, and renders the result once it settles', () => {
    const partial = partialResultSchema.parse(partialFromProgress(progressFixture))
    const onResultPathChange = vi.fn()
    const running = { ...queuedAttempt, executionStatus: 'RUNNING' as const }
    const { rerender } = render(
      <ResultsTab {...defaultRunProps} controller={controller({ status: 'running', step: 'extraction', partial }, running)}
        schemaReady pinnedSchema={usedSchema} documentMarkdown="# Source" sourceDocumentName="running.pdf" onResultPathChange={onResultPathChange} />,
    )
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Reading records · 2 of 5 · started at page 1')).toBeInTheDocument()
    expect(screen.queryByText('Running extraction…')).not.toBeInTheDocument()
    expect(onResultPathChange).toHaveBeenLastCalledWith(['records'])
    rerender(
      <ResultsTab {...defaultRunProps} controller={controller({ status: 'ready', result: { records: [{ place: 'Hill' }] }, evidenceLinks: [], ungroundedCount: 0 }, articleAttempt)}
        schemaReady pinnedSchema={usedSchema} documentMarkdown="# Source" sourceDocumentName="running.pdf" onResultPathChange={onResultPathChange} />,
    )
    expect(screen.queryByText(/Reading records/)).not.toBeInTheDocument()
    expect(screen.getByText('Hill')).toBeInTheDocument()
    expect(onResultPathChange).toHaveBeenLastCalledWith(['records', '0'])
  })
```

(import `partialFromProgress` from `'extraction'`, `partialResultSchema` from the contract and the fixture JSON as in `PartialResults.test.tsx`; `usedSchema` and `queuedAttempt` are the describe's existing fixtures.)

- [ ] **Step 2: Run them to verify they fail** — `pnpm -C prototypes/studio exec vitest run src/PartialResults.test.tsx src/resultsBadge.test.ts src/ResultsTab.test.tsx` → FAIL.

- [ ] **Step 3: `src/PartialResults.tsx`**

```tsx
import type { SchemaNode } from 'extraction/schema'
import type { PartialResult } from '../shared/extraction.contract'
import { partialHeadline, partialValueState } from './partialResult'
import ResultValue, { singularItemLabel } from './ui/ResultValue'
import { ProgressBar, RecordHeader } from './ui'

/** Placeholder rows for a record kei has not answered yet: the pinned schema's record-level fields (Ruling 2). */
function placeholderFor(schemaNodes: readonly SchemaNode[]): Record<string, null> {
  return Object.fromEntries(schemaNodes.filter((node) => node.valueSource === undefined).map((node) => [node.name, null]))
}

/**
 * A running Extraction's records in the order they are read (design §1): a header per record, its values in their
 * states through `ResultValue`, Evidence chips where links exist, Contested where verified values disagreed. No review
 * controls: the settled attempt is reviewed.
 */
export default function PartialResults({ partial, schemaNodes = [], onSelectEvidence }: {
  partial: PartialResult
  schemaNodes?: readonly SchemaNode[]
  onSelectEvidence?: (anchorId: string) => void
}) {
  const placeholder = placeholderFor(schemaNodes)
  const fraction = partial.discovered > 0 ? partial.finished / partial.discovered : 0
  return (
    <section aria-label="Extraction in progress" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
        <p role="status" className="text-secondary font-semibold text-ink">{partialHeadline(partial)}</p>
        <ProgressBar fraction={fraction} className="mt-1.5" aria-label="Records read" />
      </div>
      <div role="list" aria-label="Records being read" className="bg-canvas px-3 py-2">
        {partial.records.map((record) => {
          const label = record.label ?? singularItemLabel('records', record.index)
          const fields = record.state === 'queued' ? null : Object.entries(record.record ?? placeholder)
          const linkByPath = new Map(record.evidenceLinks.map((link) => [JSON.stringify(link.resultPath.slice(2).map(String)), link]))
          return (
            <div key={record.index} role="listitem" aria-label={label} data-record-state={record.state} className="mb-2">
              <RecordHeader label={label} page={record.page} />
              {fields?.map(([name, value]) => (
                <ResultValue
                  key={name}
                  name={name}
                  value={value}
                  path={[name]}
                  defaultExpanded={false}
                  getValueState={(path) => partialValueState(record, path)}
                  getContested={(path) => record.values[JSON.stringify(path)]?.candidates}
                  getEvidenceAnchorId={(path) => linkByPath.get(JSON.stringify(path))?.evidenceAnchorId}
                  onSelectEvidence={onSelectEvidence}
                />
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}
```

(`ProgressBar` and `RecordHeader` come from `./ui`; if the redesign exported `RecordHeader` elsewhere, import it from there and ledger the re-anchor. `ResultValue`'s `contested` rendering shows the candidates joined by ` · `, which the test's `/Bdorf · Bdorf-Nord/` matches.)

- [ ] **Step 4: `src/ResultsTab.tsx`.** Import `PartialResults` from `./PartialResults`. The `onResultPathChange` effect becomes:

```tsx
  const partialShown = state.status === 'running' && state.partial !== null
  useEffect(
    () => onResultPathChange?.(
      view === 'review' ? (partialShown ? ['records'] : [...articlePathPrefix, ...navPath]) : null,
    ),
    [articlePathPrefix, navPath, onResultPathChange, partialShown, view],
  )
```

The running branch `{state.status === 'running' && (` (the `Spinner` with "Queued extraction…" / "Running extraction…" / "Starting extraction…") becomes two:

```tsx
      {state.status === 'running' && state.partial && (
        <PartialResults partial={state.partial} schemaNodes={pinnedSchema?.schemaNodes} onSelectEvidence={onSelectEvidence} />
      )}
      {state.status === 'running' && !state.partial && (
        …the Spinner block exactly as it is…
      )}
```

- [ ] **Step 5: `src/resultsBadge.ts`.** The signature becomes `Pick<ExtractionController, 'attempt' | 'hasResults' | 'review' | 'state'>` and the running branch:

```ts
  if (attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING') {
    const partial = controller.state.status === 'running' ? controller.state.partial : null
    // Once discovery is known, the records read so far (design §1: "7 of 48"); before it there is nothing to count.
    return { label: partial && partial.discovered > 0 ? `${partial.finished} of ${partial.discovered}` : 'running' }
  }
```

(`RightRail` and `App` pass the whole controller already.)

- [ ] **Step 6: Run the tests to verify they pass** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/PartialResults.test.tsx src/resultsBadge.test.ts src/ResultsTab.test.tsx src/RightRail.test.tsx` → PASS.

- [ ] **Step 7: Commit** — `feat(studio): the Results tab lists the records as they are read, with a progress line and a "k of n" badge`.

---

### Task 3: Highlights draw as links arrive; Run sends the page being read (§1, §4)

**Files:**
- Modify: `prototypes/studio/src/useEvidenceOverlays.ts` (the `attempt` prop type, the paint effect, the focus cleanup effect), `prototypes/studio/src/App.tsx` (the `useEvidenceOverlays` call; `extraction.runExtraction(…)` inside `runExtraction`)
- Test: `prototypes/studio/src/useEvidenceOverlays.test.ts`, `prototypes/studio/src/App.test.tsx`

**Interfaces:**
- Produces: `useEvidenceOverlays({ …, partialEvidenceLinks?: readonly EvidenceLink[] | null })`; `attempt` typed `Pick<ExtractionAttempt, 'extractionId' | 'executionStatus' | 'outcome' | 'evidenceLinks' | 'reviewDecisions'> | null`; Run's request carries `startPage: currentPage` while a PDF is loaded.

- [ ] **Step 1: Write the failing tests.** In `src/useEvidenceOverlays.test.ts` add a describe:

```ts
describe('partial links (design §1)', () => {
  /** The viewer of one rendered page, with stable ref objects: a ref recreated per render would re-run the hook's effects
   *  (their dependency lists name the refs), which the existing tests avoid the same way. */
  function viewerWithPage(anchor: ReturnType<typeof decodeParsedDocument>['evidence_index']['anchors'][number]) {
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    container.scrollTo = vi.fn()
    document.body.append(container)
    const viewer = { scrollPageIntoView: vi.fn(), eventBus: { on: vi.fn(), off: vi.fn() } }
    return { container, viewer, containerRef: { current: container }, viewerRef: { current: viewer as never } }
  }
  const running = { extractionId: 'x-1', executionStatus: 'RUNNING' as const, outcome: null, evidenceLinks: null, reviewDecisions: [] }

  it('paints a running attempt\'s partial links without moving the page the researcher is reading', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const { container, viewer, containerRef, viewerRef } = viewerWithPage(anchor)
    renderHook(() => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt: running,
      fieldNames: ['title'], resultPath: ['records'], active: true,
      partialEvidenceLinks: [
        { resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id },
        { resultPath: ['records', 1, 'title'], evidenceAnchorId: 'a_nowhere' },   // not in the pinned document: skipped
      ],
    }))
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(1)
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled()
  })

  it('paints nothing for a running attempt without partial links, and a settled attempt as before', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const { container, viewer, containerRef, viewerRef } = viewerWithPage(anchor)
    const { rerender } = renderHook(({ attempt, partialEvidenceLinks }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt,
      fieldNames: ['title'], resultPath: ['records'], active: true, partialEvidenceLinks,
    }), { initialProps: { attempt: running as Parameters<typeof useEvidenceOverlays>[0]['attempt'], partialEvidenceLinks: null as readonly EvidenceLink[] | null } })
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(0)
    rerender({
      attempt: { ...running, executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id }] },
      partialEvidenceLinks: null,
    })
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(1)
    expect(viewer.scrollPageIntoView).toHaveBeenCalledTimes(1)
  })

  it('a focused Evidence survives a poll of the same Extraction and clears for another one', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const { container, containerRef, viewerRef } = viewerWithPage(anchor)
    const { result, rerender } = renderHook(({ attempt }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt,
      fieldNames: ['title'], resultPath: ['records'], active: true, partialEvidenceLinks: null,
    }), { initialProps: { attempt: running as Parameters<typeof useEvidenceOverlays>[0]['attempt'] } })
    act(() => result.current(anchor))
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    rerender({ attempt: { ...running } })                       // the next poll: a new object, the same Extraction
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    rerender({ attempt: { ...running, extractionId: 'x-2' } })  // another Extraction
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)
  })
})
```

(import `type EvidenceLink` from `'../shared/groundedExtraction'`.) In `src/App.test.tsx`: in the test that asserts the run request body (`expect(extractionRequests[0]).toEqual(expect.objectContaining({ strategy: 'ARTICLE', …` after a Run click with the PDF loaded) add `startPage: 1` to the `objectContaining`; and in the test that stubs `GET /api/extractions/${runningAttempt.extractionId}` with `{ extraction: runningAttempt, pendingReviewDecisions: null }`, add `partial: partialResultSchema.parse(partialFromProgress(progressFixture))` to that stub and assert, after the Results tab is shown, `expect(await screen.findByText('Reading records · 2 of 5 · started at page 1')).toBeVisible()` and `expect(screen.getByRole('button', { name: /■ Stop extraction/ })).toHaveTextContent('2 of 5')` (imports as in `PartialResults.test.tsx`).

- [ ] **Step 2: Run them to verify they fail** — `pnpm -C prototypes/studio exec vitest run src/useEvidenceOverlays.test.ts src/App.test.tsx` → FAIL.

- [ ] **Step 3: `src/useEvidenceOverlays.ts`.** The options gain `partialEvidenceLinks?: readonly EvidenceLink[] | null` (import `type EvidenceLink` from `'../shared/groundedExtraction'`) and `attempt`'s `Pick` gains `'extractionId' | 'executionStatus'`. In the paint effect, the guard and the links become:

```ts
    const running = attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING'
    // A settled attempt paints its links; a running one the partial view's, as they arrive (design §1).
    const evidenceLinks = attempt?.outcome === 'SUCCEEDED' ? attempt.evidenceLinks ?? [] : running ? partialEvidenceLinks ?? null : null
    if (!container || !parsedDocument || !attempt || evidenceLinks === null || !active || !resultPath) return
```

(delete the old `const evidenceLinks = attempt.evidenceLinks ?? []`; `!attempt` keeps TypeScript's narrowing for the `attempt.reviewDecisions` read that follows, which the old `attempt?.outcome !== 'SUCCEEDED'` guard provided). The scroll after the first paint becomes `if (firstOccurrence && !running && !container.querySelector('.parsed-evidence-focus'))` (Ruling 3: links arriving every two seconds never move the page). The paint effect's dependency list gains `partialEvidenceLinks`. The focus cleanup effect (`stopFocusedPaint.current?.() … removeOverlays(containerRef.current, 'parsed-evidence-focus')`) keys on the Extraction, not on the attempt object a poll renews: its dependency list becomes `[attempt?.extractionId, containerRef, parsedDocument]` (with the eslint `react-hooks/exhaustive-deps` disable comment the file's style uses, if the rule objects to the member access).

- [ ] **Step 4: `src/App.tsx`.** Before the `useEvidenceOverlays` call:

```ts
  // The partial view's links while the latest attempt runs: painted as they arrive, never scrolled to.
  const partialEvidenceLinks = useMemo(
    () => extraction.state.status === 'running' && extraction.state.partial
      ? extraction.state.partial.records.flatMap((record) => record.evidenceLinks)
      : null,
    [extraction.state],
  )
```

and pass `partialEvidenceLinks` into `useEvidenceOverlays({ … })`. In `runExtraction`, the call `extraction.runExtraction(savedMethodFor(savedState, strategy, catalogRecipe), target, strategy, catalogRecipe)` gains a fifth argument `loadState.status === 'ready' ? currentPage : null` (the page pdf.js reports as current when Run is clicked, design §4; `currentPage` and `loadState` are App state already).

- [ ] **Step 5: Run the tests to verify they pass** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/useEvidenceOverlays.test.ts src/App.test.tsx` → PASS.

- [ ] **Step 6: Commit** — `feat(studio): Evidence highlights draw as links arrive and keep their focus across polls; Run names the page being read`.

---

### Task 4: The browser journey, documentation and the full gates (Testing, Files)

**Files:**
- Modify: `prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts` (the `kei` switches, `extractFor`, the stand-in `script`, the second UI run), `prototypes/studio/DESIGN.md` (the Results section), `docs/superpowers/specs/2026-10-02-view-ordered-streaming-extraction-design.md:3`

- [ ] **Step 1: The stand-in's progress and the journey.** In `e2e/canonical-evidence-lifecycle.spec.ts`:

1. The `kei` switches gain `progress: null as unknown` and `lastStartPage: null as number | null`; the per-test `Object.assign(kei, { … })` reset gains `progress: null, lastStartPage: null`.
2. At the top of `extractFor`, record what Studio asked for: `kei.lastStartPage = (request.request.options as { start_page?: number }).start_page ?? null`.
3. `launchKeiStandIn({ …, script: { extract: (request) => extractFor(request), progress: () => kei.progress } })`.
4. A helper beside `extractFor`:

```ts
/** What kei's progress route says mid-run for this spec's fixture. The record read first sits on the page Run was clicked
 *  from (page 2) but later in source order than a page-1 record still waiting, so the view's order proves the ordering
 *  handoff: for a Catalog, one finished, one under verification, one waiting; for Article, one of two contexts answered. */
function progressFor(strategy: 'ARTICLE' | 'CATALOG') {
  if (strategy === 'ARTICLE')
    return {
      version: 1, strategy: 'article', started_at_page: 2, discovered: 1, finished: 0,
      entries: [{ index: 0, label: null, page: null, stage: 'candidates', candidates: [{ path: ['title'], value: 'First context', quote: null, window: 0 }],
        record: { title: 'First context' }, evidence: [], contested: [], failed: 0 }],
      document: { contexts: [{ primary: ['p2_s0'], overlap: [] }], answered: 1, of: 2, failed_contexts: 0, links: [], grounding_batches: 0 },
    }
  return {
    version: 1, strategy: 'catalog', started_at_page: 2, discovered: 3, finished: 1,
    entries: [
      { index: 0, label: 'Waiting', page: 1, stage: 'queued', candidates: null, record: null, evidence: null, contested: null, failed: null },
      { index: 1, label: 'First', page: 2, stage: 'finished', candidates: null, record: { title: 'First record' }, evidence: [], contested: [], failed: null },
      { index: 2, label: 'Second', page: 2, stage: 'candidates', candidates: [{ path: ['title'], value: 'Second record', quote: null, window: 0 }],
        record: { title: 'Second record' }, evidence: null, contested: null, failed: 0 },
    ],
    document: null,
  }
}
```

5. Before the second UI run (the `'▶ Run extraction'` activation that follows the schema edit, whose settlement is the `'Extraction finished'` dialog), insert:

```ts
  // Design §1, §4: Run from page 2 sends the page; the Results tab shows the record read first (page 2) before a page-1
  // record still waiting and before the attempt settles; the badge and the run button count it; the settled result
  // takes the view's place.
  await page.getByLabel('Current page').fill('2')
  await page.getByLabel('Current page').press('Enter')
  await expect(page.getByText('/ 6', { exact: true })).toBeVisible()
  kei.blockNextResult = true
  kei.progress = progressFor(strategy)
```

and after that run's activation, before its `'Extraction finished'` wait:

```ts
  await expect(page.getByRole('button', { name: /■ Stop extraction/ })).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => kei.lastStartPage).toBe(2)   // the stand-in received start_page from Studio
  await expect(page.getByRole('button', { name: /■ Stop extraction/ })).toContainText(strategy === 'CATALOG' ? '1 of 3' : '0 of 1', { timeout: 10_000 })
  await page.getByRole('tab', { name: /Results/ }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Reading/ })).toHaveText(
    strategy === 'CATALOG' ? 'Reading records · 1 of 3 · started at page 2' : 'Reading the document · 1 of 2 contexts')
  if (strategy === 'CATALOG') {
    const listed = page.getByRole('list', { name: 'Records being read' }).getByRole('listitem')
    await expect(listed).toHaveText([/First/, /Second/, /Waiting/])   // reading order: page 2 first, the page-1 record last
    await expect(listed.nth(0)).toContainText('· page 2')
    await expect(listed.nth(0)).toContainText('First record')
    await expect(listed.nth(1).getByTitle('Candidate · being verified')).toHaveText('Second record')
  }
  await expect.poll(() => resultGate.release !== null).toBe(true)
  kei.progress = null
  resultGate.release!()
```

The existing `'Extraction finished'` dialog wait and dismissal follow unchanged; right after the dismissal add `await expect(page.getByText(/^Reading records|^Reading the document/)).toHaveCount(0)` (the settled result replaced the partial view). (The `'/ 6'` text and the `'Current page'` input are the redesign's toolbar; the `'■ Stop extraction'` button and the `'Extraction finished'` dialog are the redesign's run action. The lifecycle's Catalog method is the legacy generic one, which the real kei never reorders; this journey proves the client and the handoff, and the kei side is proven by Part A's tests.)

- [ ] **Step 2: Run the journey** — with the disposable database the lifecycle spec requires (`EXTRACTION_TEST_DATABASE_URL` equal to `DATABASE_URL`): `pnpm -C prototypes/studio exec playwright test e2e/canonical-evidence-lifecycle.spec.ts` → both strategies PASS. Where no disposable database is available, record in the ledger that this journey runs at the Baratheon verification (`~/pr-validation/run-tiers.sh`); this journey on the merged client is the question only a live run answers for this plan (Review log round 5).

- [ ] **Step 3: Documentation.** `DESIGN.md`, in the Results tab section the redesign wrote, add one line: `While an Extraction runs, the tab lists the records in the order kei reads them, each value in its state (reading, checking, grounded, empty, contested), under "Reading records · k of n · started at page p" and a progress bar; the badge and the run button read "k of n"; at settlement the settled list takes the view's place.` In the spec, §1's sentence `When the attempt settles, the settled result replaces the partial view in place (record index is the React key, so nothing flickers).` becomes `When the attempt settles, the settled list takes the partial list's place in one render, in source order (Part B, Ruling 7: two components, no DOM continuity promised).`, and the Status (line 3) becomes `Status: implemented by docs/superpowers/plans/2026-10-03-view-ordered-streaming-service.md (Part A) and …-client.md (Part B)`.

- [ ] **Step 4: Full gates** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio test` → PASS; `pnpm -r typecheck` → PASS; the e2e default suite `pnpm -C prototypes/studio exec playwright test` where the stack is available.

- [ ] **Step 5: Commit** — `test(studio): the run from page 2 shows its first record before the attempt settles; DESIGN.md`.

---

## Self-review

**Spec coverage.** §1 six states → Task 2 (`partialValueState` reads the server's states, Ruling 8, through `ResultValue`'s rendering; `contested` through `getContested`); order of records → Ruling 1 (server order kept); header line and progress bar → Task 2 (`partialHeadline`, `ProgressBar`); badge "7 of 48" → Task 2 (`resultsBadgeFor`); highlights as links arrive → Task 3; the settled result taking the view's place → Tasks 1 (partial dropped at the terminal read) and 2 (Ruling 7). §4 Studio sends `startPage` → Tasks 1 and 3. §5 `extractionStateFromAttempt` with partial, monitor keeps the latest, never regresses → Task 1; `ResultsTab` renders through the redesign's components → Task 2; overlays accept partial links → Task 3; badge and run button read the counts → Task 2 (the run button appends `badge.label`, redesign Task 4). Error handling "the settled result always wins" → Task 1 and 2 tests. Testing: client bullets → Tasks 1–3; browser bullet → Task 4. Files: `useExtraction.ts`, `extraction.ts`, `ResultsTab.tsx`, `useEvidenceOverlays.ts`, `App.tsx` edited; `PartialResults.tsx` and `partialResult.ts` added (the spec's Files list names no client file for them; the rendering is its own component so the Results tab stays readable, and the pure helpers live apart from it for the lint rule).

**Placeholder scan.** None; every step has its code and its assertions.

**Type consistency.** `PartialResult`/`PartialRecord`/`PartialValue` are the contract's (`shared/extraction.contract.ts`, Part A) everywhere in `src`; the package's converter output enters the client only through `partialResultSchema.parse` in tests. `values` keys are `JSON.stringify(path)` with string steps (Part A Task 6) and `partialValueState`/`getContested` read them the same way; `resultsBadgeFor` takes `state` beside the three fields the redesign gave it; `useEvidenceOverlays`'s `partialEvidenceLinks` is `readonly EvidenceLink[] | null`, as `PartialRecord.evidenceLinks` flattens to; `runExtraction`'s fifth argument is `number | null` and `ExtractionRunRequest.startPage` is `number | undefined`; `Monitor.partial` is `PartialResult | null | undefined` and `retainFinished` takes `monitor.partial ?? null`.

**Review Focus.** 1 → Task 1 (`a restored running job…`) and Task 3 (App stub); 2 → Task 2 (`fields the pinned schema no longer names`); 3 → Task 3 (`a_nowhere`); 4 → Task 1 (`kei slow: no partial this read`, `a reconnect after a failed read…`); 5 → Task 2 (`renders the result once it settles`) and Task 3 (the App stub's settled read).

## Review log — Codex gpt-6-astra (reasoning max), round 1, 2026-10-03

Accepted and applied: P0-2 and P0-5 (the wire type is the client's; fixtures go through `partialResultSchema.parse(partialFromProgress(…))`; the badge fixture is typed `PartialResult`) · P0-7 (candidate assertions scoped with `getAllByTitle`; labels asserted through the listitems' `aria-label`) · P0-8 (`partialHeadline` and `partialValueState` live in `partialResult.ts`) · P1-5 (the partial lives on the monitor across reconnects; a finished record is replaced only by a finished record with at least as many links; both tested) · P1-6 (`contested` rendered through `getContested`) · P1-7 (Ruling 8: the client derives no state of its own) · P1-9 (the browser test puts the current-page record later in source order and asserts the stand-in received `start_page`) · P2-1 (the focus overlay survives a poll; Ruling 3).

Rejected or narrowed: P1-8 — DOM continuity across settlement is out of scope (Ruling 7 revised to say what happens; its test asserts the swap, not continuity); the human may overrule.

## Review log — Codex gpt-6-astra (reasoning max), round 2, 2026-10-03

Accepted and applied: P0-4 (the third record has two null fields: `getAllByText('Missing')` has length 2) · P0-5 (the overlay tests hold stable ref objects, as the existing tests do, so a rerender does not run the cleanup that removes the focus) · P2 (the spec's §1 settlement sentence records the chosen swap, Task 4; Ruling 8 narrowed to leaf paths). Codex closed round-1's P1-8 on Ruling 7 as a product decision.

## Review log — Codex gpt-6-astra (reasoning max), round 3, 2026-10-03

Accepted and applied: P0-2 (the overlay guard includes `!attempt`, keeping the narrowing the removed `outcome` check gave the `reviewDecisions` read). No other Part B finding.

## Review log — Codex gpt-6-astra (reasoning max), round 4, 2026-10-03

P2 only: the duplicated round-2 heading removed. No Part B finding; Codex confirmed the `!attempt` guard.

## Review log — Codex gpt-6-astra (reasoning max), round 5, 2026-10-03

Open P0/P1: 0 across both plans. Live-run question for this plan: the browser journey against the merged client on Baratheon.
