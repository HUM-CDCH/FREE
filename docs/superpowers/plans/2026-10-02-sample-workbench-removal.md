# Sample Workbench Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the sample workbench from `dev` so a run always covers the whole Source Document and nothing in Studio, the extraction package, the API or the Parsing Service knows about sample pages, pinned sample decisions or hand pairings.

**Architecture:** A pure deletion in dependency order so every commit typechecks: first the Parsing Service's `pages` option, then the Studio client (which stops using sample fields while the contracts still carry them), then the contracts, the extraction package and the API (nothing references the removed fields any more), then the browser journeys, the schema comments and the domain language. Three retired database columns stay in place, never written.

**Tech Stack:** TypeScript (React 19, Vite, Vitest, Testing Library, Playwright), zod contracts, the `extraction` and `db` workspace packages (pnpm 12 workspace), Python 3 / FastAPI / pydantic for the Parsing Service (uv), Postgres integration tests.

**Spec:** `docs/superpowers/specs/2026-10-02-sample-workbench-removal-design.md` (copied into the worktree in Task 1 so it travels with the branch).

## Global Constraints

- Base branch: a fresh worktree from `origin/dev` after `git fetch` (local `dev` is 62 commits behind); never an open PR branch.
- Never run a bare `pnpm install` in the worktree: the root `postinstall` builds a multi-gigabyte Python environment and `/home` has about 11 GB free. Use `pnpm install --prefer-offline --frozen-lockfile --ignore-scripts` and then `pnpm db:generate`.
- Migrations are forward-only: `requestedPages`, `reviewTransfer`, `reviewPairings` (Extraction) and `carriedFrom` (ReviewDecision) stay in `contract.prisma`, are never written, and only `requestedPages` is still read (the `IS NULL` filter that keeps legacy sample rows out of `latestAttempt`).
- Nothing changes for whole-document Extractions, their Review Decisions, drafts and finalize, Batch Extractions, or export.
- Copy uses CONTEXT.md language: "researcher", "Source Document", "Extraction", "Review Decision"; never "user".
- Every commit passes `pnpm -C prototypes/studio typecheck` once Task 3 is done; Task 2 is Python-only.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A legacy row with `requestedPages` set (a sample made before this change) must never be returned as a document's `latestAttempt` or `latestReviewed`. Pinned to Task 4 (`postgres-attempts.integration.test.ts`).
2. A browser tab from before the deploy that posts a run with `pages` must get `422 invalid_request`, not a server error and not a sample. Pinned to Task 4 (`extractions.test.ts`).
3. A review draft left in session storage with `pairings` or `carriedFrom` must not crash recovery: the strict contract rejects it and the server draft wins. Pinned to Task 3 (`reviewDrafts.test.ts`).
4. A finalized review whose stored decisions carry `carriedFrom` in the database must still read back as a valid attempt DTO. Pinned to Task 4 (`postgres-reviews.integration.test.ts`).
5. kei must refuse, not silently narrow, a request that still carries `options.pages`. Pinned to Task 2 (`test_extract_options.py`).

---

### Task 1: Worktree, dependencies, baseline

**Files:**
- Create: worktree `/home/gennaro/projects/FREE-worktrees/remove-sample-workbench` on branch `chore/remove-sample-workbench`
- Create: `docs/superpowers/specs/2026-10-02-sample-workbench-removal-design.md` and `docs/superpowers/plans/2026-10-02-sample-workbench-removal.md` in the worktree (copies of the files in the main checkout)

**Interfaces:**
- Produces: a worktree where `pnpm -C prototypes/studio typecheck`, `pnpm -C prototypes/studio test`, `pnpm -C packages/extraction test` and the Parsing Service unit tests run.

- [ ] **Step 1: Fetch and create the worktree**

```bash
git -C /home/gennaro/projects/FREE fetch origin
git -C /home/gennaro/projects/FREE worktree add -b chore/remove-sample-workbench \
  /home/gennaro/projects/FREE-worktrees/remove-sample-workbench origin/dev
cd /home/gennaro/projects/FREE-worktrees/remove-sample-workbench
git log --oneline -1
```

Expected: the one-line log shows origin/dev's head (`639f5075` or newer).

- [ ] **Step 2: Install JavaScript dependencies without lifecycle scripts, then generate the database client**

```bash
cd /home/gennaro/projects/FREE-worktrees/remove-sample-workbench
pnpm install --prefer-offline --frozen-lockfile --ignore-scripts
pnpm db:generate
df -h /home | tail -1
```

Expected: install completes from the pnpm store (hardlinks, little disk used); `db:generate` prints the generated client; free space stays above 8 GB. If `--frozen-lockfile` refuses, stop and report: the lockfile and `package.json` disagree on `origin/dev`, which is not this plan's problem to fix.

- [ ] **Step 3: Point the Parsing Service tests at this worktree's source using the main checkout's virtual environment**

```bash
cd /home/gennaro/projects/FREE-worktrees/remove-sample-workbench
/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -c "import sys; sys.path.insert(0, 'prototypes/parsing_service/src'); import kei_exp; print(kei_exp.__file__)"
```

Expected: the printed path starts with `/home/gennaro/projects/FREE-worktrees/remove-sample-workbench/`. Every Python test run in this plan uses the same shape, from the worktree root (the worktree session refuses `PYTHONPATH=…` prefixes, so the path is inserted in-process):

```bash
/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -c "import sys; sys.path.insert(0, 'prototypes/parsing_service/src'); import pytest; sys.exit(pytest.main(['prototypes/parsing_service/tests/test_extract_stages.py', '-q']))"
```

Do not create a second virtual environment.

- [ ] **Step 4: Baseline the suites you will touch**

```bash
cd /home/gennaro/projects/FREE-worktrees/remove-sample-workbench
pnpm -C prototypes/studio typecheck
pnpm -C packages/extraction test
/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -c "import sys; sys.path.insert(0, 'prototypes/parsing_service/src'); import pytest; sys.exit(pytest.main(['prototypes/parsing_service/tests/test_extract_stages.py', '-q']))"
```

Expected: all green. Record the test counts; they are the baseline the later tasks compare against.

- [ ] **Step 5: Bring the spec and this plan into the branch and commit**

```bash
cd /home/gennaro/projects/FREE-worktrees/remove-sample-workbench
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp /home/gennaro/projects/FREE/docs/superpowers/specs/2026-10-02-sample-workbench-removal-design.md docs/superpowers/specs/
cp /home/gennaro/projects/FREE/docs/superpowers/plans/2026-10-02-sample-workbench-removal.md docs/superpowers/plans/
git add docs/superpowers
git commit -m "docs: design and plan for removing the sample workbench

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Parsing Service stops taking a page scope

**Files:**
- Modify: `prototypes/parsing_service/src/kei_exp/kie/extract/run.py:48-100` (`Options`) and `:190-215` (`dispatch`)
- Create: `prototypes/parsing_service/tests/test_extract_options.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `Options` without `pages`; `Options.dumped()` unchanged for every request that never carried `pages`; `dispatch` reads the whole evidence for every strategy.

- [ ] **Step 1: Write the failing tests**

Create `prototypes/parsing_service/tests/test_extract_options.py`:

```python
"""The extract request takes no page scope: a sample was a workbench feature, removed on 2026-10-02."""
import pytest
from pydantic import ValidationError

from kei_exp.kie.extract.run import Options


def test_a_page_scope_is_refused_as_an_unknown_option():
    with pytest.raises(ValidationError):
        Options(strategy="article", pages=[1])


def test_dumped_options_carry_no_pages_key():
    assert "pages" not in Options(strategy="article").dumped()
    assert "pages" not in Options(strategy="catalog").dumped()
```

- [ ] **Step 2: Run them to verify they fail**

Run (from the worktree root): `/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -c "import sys; sys.path.insert(0, 'prototypes/parsing_service/src'); import pytest; sys.exit(pytest.main(['prototypes/parsing_service/tests/test_extract_options.py', '-q']))"`
Expected: the first test FAILS (today `pages=[1]` is accepted); the second passes already.

- [ ] **Step 3: Remove the option**

In `run.py`, inside `class Options`:

1. Delete the field line
   `pages: list[int] | None = Field(default=None, min_length=1)  # a Sample Extraction's physical PDF pages`.
2. Delete the whole validator `_pages_are_canonical` (the `@model_validator(mode="after")` decorator and its four lines).
3. In `dumped()`, change the exclusion tuple from `("catalog", "article", "pages", "unified")` to `("catalog", "article", "unified")`, and replace the docstring with:

```python
        """The options as the artifact and the fingerprint record them: no `catalog` key on the version 1 path, and
        the unified method without the character limits it never reads."""
```

4. Remove `pairwise` from the `itertools` import if nothing else in the file uses it (`grep -n pairwise run.py`).

In `dispatch`, delete these lines (the restriction and its comment):

```python
    pages = request.options.pages
    if pages is not None and request.options.catalog is None:
        # A sample: Article and generic Catalog read only its pages. The recipe Catalog segments the whole document
        # and keeps the entries on them itself (`grounded.extract`), so its published segmentation stays whole.
        evidence = replace(evidence, passages=tuple(p for p in evidence.passages if p.page in pages),
                           withheld=tuple(p for p in evidence.withheld if p.page in pages))
```

Remove `replace` from the `dataclasses` import if it is now unused.

- [ ] **Step 4: Run the new tests and the extract suites**

Run: the same wrapper with `['prototypes/parsing_service/tests/test_extract_options.py', 'prototypes/parsing_service/tests/test_extract_stages.py', 'prototypes/parsing_service/tests/test_record_scope.py', '-q']`
Expected: PASS. If any existing test constructs `Options(... pages=...)`, it is a sample test: delete that case (the fixtures named `*.json` with a top-level `"pages"` array are catalogue fixtures, not request options, and stay).

Then run the whole Parsing Service suite once with the wrapper and `['prototypes/parsing_service/tests', '-q', '-x']`, and confirm the count equals the Task 1 baseline plus two.

- [ ] **Step 5: Commit**

```bash
git add prototypes/parsing_service/src/kei_exp/kie/extract/run.py prototypes/parsing_service/tests/test_extract_options.py
git commit -m "feat(parsing): the extract request takes no page scope

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The Studio client forgets samples, transfers and pairings

The contracts still carry the sample fields in this task, so the client compiles at every step; Task 4 removes the fields once nothing reads them.

**Files:**
- Modify: `prototypes/studio/src/App.tsx`, `AppFrame.tsx`, `PageNavigation.tsx`, `RightRail.tsx`, `SchemaPanel.tsx`, `ReviewAttention.tsx`, `ResultsTab.tsx`, `useExtraction.ts`, `reviewDrafts.ts`, `api.ts`, `useBatchExtractionReviewGrid.ts`, `projectContexts/BatchExtractionReviewGrid.tsx`, `projectContexts/BatchExtractionsPanel.tsx`
- Delete: `prototypes/studio/src/SampleFacts.tsx`
- Test: `prototypes/studio/src/App.test.tsx`, `SchemaPanel.test.tsx`, `ResultsTab.test.tsx`, `useBatchExtractionReviewGrid.test.tsx`, `reviewDrafts.test.ts` (new cases), `projectContexts/BatchExtractionsPanel.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PageNavigation` props `{ id, pageCount, currentPage, onNavigate, onClose }`; `runExtraction()` in `App.tsx` takes no arguments; `useExtraction().review` has no `transfer` and no `pairing`; `saveExtractionReviewDraft(extractionId, decisions, version)`; `recoverReviewDraft` returns no `pairings`.

- [ ] **Step 1: Write the failing client tests**

In `prototypes/studio/src/App.test.tsx`, replace the test `'navigates a long document with the keyboard and enforces the sample page limit'` (the `it(` at line 1321 through its closing `})` just before the next `it(` at 1352) with:

```tsx
  it('navigates a long document with the keyboard and offers no sample controls', async () => {
    getDocument.mockReturnValueOnce({
      promise: Promise.resolve({ numPages: 120 }),
      destroy: destroyLoadingTask,
    })
    await renderReopened()
    const navigation = within(await screen.findByRole('navigation', { name: 'Page navigation' }))
    const firstPage = navigation.getByRole('button', { name: 'Go to page 1' })
    firstPage.focus()
    fireEvent.keyDown(firstPage, { key: 'End' })
    const lastPage = navigation.getByRole('button', { name: 'Go to page 120' })
    expect(lastPage).toHaveFocus()
    expect(lastPage).toHaveAttribute('aria-current', 'page')
    expect(firstPage).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(lastPage, { key: 'ArrowUp' })
    expect(navigation.getByRole('button', { name: 'Go to page 119' })).toHaveFocus()
    fireEvent.keyDown(document.activeElement!, { key: 'Home' })
    expect(firstPage).toHaveFocus()
    expect(screen.queryByRole('button', { name: 'Select sample pages' })).not.toBeInTheDocument()
    expect(navigation.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryByText(/admitted samples/)).not.toBeInTheDocument()
    fireEvent.keyDown(firstPage, { key: 'Escape' })
    expect(screen.queryByRole('navigation', { name: 'Page navigation' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pages' })).toHaveFocus()
  })
```

Delete these cases entirely: `'keeps page navigation visible and sampling optional, preserves a hidden selection, and admits with the saved schema'` (line 1352 to the `it(` before 1497), `'shows the newest sample only on the Source Representation it ran on'` (1497 to 1516) and `'offers Save & re-run sample only while the schema is still the strategy the sample ran as'` (1517 to the `it(` at 1611). Delete the helpers they alone used (`activeSample`, `sampleOn`, `articleSample`, whichever `grep -n` shows unused afterwards).

In `prototypes/studio/src/SchemaPanel.test.tsx`, delete the `describe('SchemaPanel sample values', …)` block (lines 1348 to the line before `describe('SchemaPanel conflict recovery'` at 1474).

In `prototypes/studio/src/ResultsTab.test.tsx`, delete `'saves a review with decisions carried from a sample only when the researcher asks, and counts them'` (890 to the `it(` at 920).

In `prototypes/studio/src/useBatchExtractionReviewGrid.test.tsx`, delete the three cases `'clears finalized hand pairings on reset and does not restore them on the next edit'` (215), `'saves a batch member hand pairing through the common draft API and reloads carried decisions'` (275) and `'keeps a wholly carried batch member as a draft until explicit finalization'` (292), each through the line before the next `it(`.

Add to `prototypes/studio/src/reviewDrafts.test.ts` (create the file if it does not exist, beside `reviewDrafts.ts`; use the file's existing imports if it exists):

```ts
import { describe, expect, it } from 'vitest'
import { recoverReviewDraft, rememberReviewDraft } from './reviewDrafts'

describe('review drafts from before the sample workbench was removed', () => {
  it('drops a local draft that still carries pairings and keeps the server state', () => {
    const decision = { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_p1_1', reviewedOccurrenceIds: ['o1'], action: 'APPROVED' as const, reviewedValue: null }
    rememberReviewDraft('e1', { version: 2, decisions: [decision], pairings: [{ record: 0, extractionId: 'old', sourceRecord: 0 }] } as never)
    const recovered = recoverReviewDraft('e1', { version: 3, decisions: [decision] }, [decision])
    expect(recovered.conflict).toBe(false)
    expect(recovered.version).toBe(3)
    expect('pairings' in recovered).toBe(false)
  })
})
```

- [ ] **Step 2: Run the client tests to verify they fail**

Run: `pnpm -C prototypes/studio exec vitest run src/App.test.tsx src/reviewDrafts.test.ts -t "no sample controls|pairings"`
Expected: FAIL (the sample button and checkboxes still render; `recovered.pairings` still exists).

- [ ] **Step 3: `PageNavigation.tsx` becomes page navigation only**

Replace the whole file with:

```tsx
import { useEffect, useRef } from 'react'

type PageNavigationProps = {
  id: string
  pageCount: number
  currentPage: number
  onNavigate: (page: number) => void
  onClose: () => void
}

export function PageNavigation({ id, pageCount, currentPage, onNavigate, onClose }: PageNavigationProps) {
  const pageButtons = useRef(new Map<number, HTMLButtonElement>())

  useEffect(() => {
    pageButtons.current.get(currentPage)?.parentElement?.scrollIntoView({ block: 'nearest' })
  }, [currentPage])

  return (
    <nav id={id} aria-label="Page navigation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
      className="scrollbar-subtle z-20 w-28 shrink-0 overflow-y-auto overscroll-contain border-r border-line bg-surface-muted max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-lg">
      <ol className="flex flex-col items-center gap-3 px-3 py-3">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
          <li key={page} className="flex w-full flex-col items-center">
            <button type="button" aria-label={`Go to page ${page}`}
              aria-current={page === currentPage ? 'page' : undefined}
              tabIndex={page === currentPage ? 0 : -1}
              ref={(button) => {
                if (button) pageButtons.current.set(page, button)
                else pageButtons.current.delete(page)
              }}
              onClick={() => onNavigate(page)}
              onKeyDown={(event) => {
                const nextPage = event.key === 'ArrowDown' ? Math.min(pageCount, page + 1)
                  : event.key === 'ArrowUp' ? Math.max(1, page - 1)
                    : event.key === 'Home' ? 1 : event.key === 'End' ? pageCount : null
                if (nextPage !== null) {
                  event.preventDefault()
                  onNavigate(nextPage)
                  pageButtons.current.get(nextPage)?.focus()
                }
              }}
              className={`h-20 w-16 rounded border border-line-strong bg-surface text-sm font-medium text-ink-muted shadow-sm ${
                page === currentPage ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface-muted' : ''}`}>
              {page}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
```

- [ ] **Step 4: `App.tsx` runs the whole document only**

Line numbers are those of `origin/dev` at the start of the task; re-locate by the quoted text as earlier edits shift them.

1. Line 1: delete `import { SampleFacts } from './SampleFacts'`.
2. Lines 67 to 76: delete `SAMPLE_PAGE_LIMIT`, `EVERY_RESULT_PATH`, `STRATEGY_NAME` and `sampleStrategyChanged`. If `pageRanges` (the helper just above, lines 55 to 65) is then unused, delete it too.
3. Lines 153 to 154 and 183: delete the `latestSample` prop and its default. Lines 238 and 247: remove `latestSample` from the `reopenedSchemas` loop and its dependency array, so both read `[persistedExtraction, latestReviewedExtraction]`.
4. Lines 210 to 217: keep `currentPage`, `pagesOpen`, `pageNavigationId` and `pagesToggleRef`; delete `samplePages`, `selectingSamplePages`, `sampleControlsId` and `sampleRerunRefusalId`. Change the comment to `// The page the viewer shows (pdf.js \`pagechanging\`).`
5. Lines 347 to 348: delete `setSamplePages([])` and `setSelectingSamplePages(false)`.
6. Lines 612 to 625: delete the `sample` `useExtraction` call and its comment.
7. Lines 685 to 686: delete `sampleRunning`.
8. Lines 728 to 735: delete the `shownSample`, `onSampleTab`, `sampleSchema`, `focusedSampleKey`, `pickSampleValue` and `overlaySchema` lines, and make `evidenceFieldNames` read `inspectedAttemptSchema?.schemaNodes.map((node) => node.name) ?? []` with `[inspectedAttemptSchema]` as its dependency. In the `useEvidenceOverlays` call (lines 740 to 750) use:

```tsx
    attempt: inspectedAttempt,
    fieldNames: evidenceFieldNames,
    resultPath,
    active: effectiveRailOpen && railTab === 'results',
```

   (no `onPick`).
9. Lines 752 to 810: `runExtraction` takes no arguments. Replace its head and the lines that mention `pages` or `previous`:

```tsx
  /** Saves pending schema edits as the Current Schema Revision, then admits the run over the whole document. A failed
   *  admission leaves the revision saved; running again only admits. */
  async function runExtraction() {
    if (savingForRun || running || !sourceRepresentationCurrent || saved.state.status !== 'ready') return
```

   Inside: the comment above the scope check becomes `// The saved revision's own scope decides what a run is; admission refuses any other.`; delete the two lines `if (previous && previous.strategy !== strategy) throw new Error(sampleStrategyChanged(previous.strategy, strategy))`; `catalogRecipe` becomes `const catalogRecipe = savedState.unifiedCatalog ? null : nextCatalogRecipe || null`; `method` becomes `const method = savedMethodFor(savedState, strategy, catalogRecipe)`; `if (!pages) setSelectedInspectionId(null)` becomes `setSelectedInspectionId(null)`; the call becomes `await extraction.runExtraction(method, { … }, strategy, catalogRecipe)` with no fifth argument; `if (!acknowledged || pages) return` becomes `if (!acknowledged) return`.
10. Lines 824 to 841: remove `sampleRunning ||` from `runExtractionUnavailable` and delete `sampleRerunRefusal` with its comment.
11. Lines 1061 to 1110: in the document toolbar keep only the `Pages` button and the `{currentPage} / {loadState.pageCount}` span inside the first `div.flex`; delete everything from the `Select sample pages` button through the `Clear` button's closing `</div>}`.
12. Lines 1114 to 1120: the `PageNavigation` element keeps `id`, `pageCount`, `currentPage`, `onNavigate` and `onClose` only.
13. Lines 1164 to 1166: delete the `SampleFacts` element.
14. Lines 1212 to 1225: delete the `sample={…}` prop of `RightRail`.

Then `pnpm -C prototypes/studio exec eslint src/App.tsx` and remove every import it reports unused (`resultPathKey`, `useCallback`, `pageRanges` and the like).

- [ ] **Step 5: `AppFrame.tsx`, `RightRail.tsx`, `SchemaPanel.tsx`, `ReviewAttention.tsx`**

`AppFrame.tsx` line 229: delete `latestSample: openDocument.latestSample,`.

`RightRail.tsx`: line 3 imports `SchemaPanel, { type FieldContext }` only; delete the `sample` prop (lines 52 to 53 and 89); `editField` loses its third parameter and reads `inspection.attempt` and `inspection.pinnedSchema` unconditionally; line 207 deletes `sample={sample}`; the `onEditField={(id, path) => editField(id, path, true)}` passed to `SchemaPanel` becomes `onEditField={editField}`.

`SchemaPanel.tsx`: delete the `SchemaSample` type (lines 60 to 75), `TRANSFER_STATUS` (132 to 136), the whole `SampleValues` component (from `function SampleValues(` at 150 to the blank line before the next top-level declaration), the `sample` prop (246 and 673), the `attention` computation (681 to 683), both `<SampleValues …/>` lines (1384 and 1530), and the block from `{sample?.review.error && (` (1833) through `<p className="p-2 text-xs">No records extracted on these pages.</p>}` (1865), keeping the `fieldContext` block that sits between them. Run eslint on the file and delete the imports it reports unused (`reviewAttention`, `ReviewAttention`, `printedIn`, `anchorText`, `Button` if unused, and the types that only `SchemaSample` used).

`ReviewAttention.tsx`: replace the whole file with:

```tsx
import { useState } from 'react'
import type { reviewAttention } from 'extraction/review-attention'
import { resultPathKey } from '../shared/groundedExtraction'
import { Button } from './ui'

export function ReviewAttention({ attention, onSelect, onEditField }: {
  attention: ReturnType<typeof reviewAttention>
  onSelect: (path: (string | number)[]) => void
  onEditField?: (nodeId: string, path: (string | number)[]) => void
}) {
  const [filter, setFilter] = useState('unresolved')
  const cells = attention.cells.filter((cell) => filter === 'all' ||
    (filter === 'unresolved' ? cell.presence === 'grounded' && !cell.decision : cell.presence === filter))
  return <details className="border-b border-line p-3 text-xs">
    <summary>{attention.grounded} grounded · {attention.requiredRemaining} required decisions remaining · {attention.ungrounded} ungrounded · {attention.missing} missing</summary>
    <label>Show <select aria-label="Review attention" value={filter} onChange={(event) => setFilter(event.target.value)}>
      <option value="unresolved">Required decisions remaining</option>
      <option value="ungrounded">Ungrounded cells</option><option value="missing">Missing cells</option><option value="all">All cells</option>
    </select></label>
    <p>Missing and ungrounded cells are optional attention; they do not block finalization.</p>
    {cells.map((cell) => <div key={resultPathKey([...cell.resultPath])} className="flex gap-2">
      <Button onClick={() => onSelect([...cell.resultPath])}>Record {Number(cell.resultPath[1]) + 1} · {cell.resultPath.slice(2).join(' / ')} · {cell.presence}{cell.decision ? ` · ${cell.decision.action.toLowerCase()}` : ' · undecided'}</Button>
      {onEditField && <Button onClick={() => onEditField(cell.nodeId, [...cell.resultPath])}>Edit this field</Button>}
    </div>)}
    {cells.length === 0 && <p>No cells in this view.</p>}
  </details>
}
```

- [ ] **Step 6: `ResultsTab.tsx`, `useExtraction.ts`, `reviewDrafts.ts`, `api.ts`**

`ResultsTab.tsx`: delete lines 557 to 562 (`carried`, `changedSinceSample`, the `pairings, sources, pair` destructuring and `unmatchedRecords`); in the auto-accept effect just below, delete `carried === 0 &&`; replace the progress span (751 to 753) with the single branch

```tsx
                      {`${controller.review.untouchedCount} of ${requiredCount} required decisions remaining`}
```

replace line 838 with `The review saves automatically when all required decisions are made.`; delete the pairing block from `{!readOnly && !inspectedAttempt && !controller.review.reviewedExtractionId && (unmatchedRecords.length > 0 || pairings.length > 0) && (` through its closing `)}`; and remove `transfer={controller.review.transfer}` from the `<ReviewAttention …/>` element.

`useExtraction.ts`:

1. Delete `pages?: number[]` and its comment from `ExtractionRunRequest` (lines 37 to 38), and the `ReviewPairing` and `ReviewTransferVerdicts` type imports (18 to 19).
2. `pendingDecision` (line 141): delete the `carriedFrom` spread.
3. Line 187: `draftRef` is `useRef<{ decisions: ReviewDecisionInput[]; touched: ReadonlySet<string> }>({ decisions: reviewDecisions, touched: touchedPaths })`. Delete the `transfer` state (192 to 195), line 223, line 361, and lines 386 to 389, 395 and the `pendingPairings` argument at 400 (`updateReview(recovered.decisions, recovered.touchedPaths)`); line 394 reads `draftRef.current = { decisions: recovered.decisions, touched: recovered.touchedPaths }`.
4. Replace `updateReview` (lines 550 to 584) with:

```ts
  function updateReview(decisions: ReviewDecisionInput[], touched: ReadonlySet<string>) {
    if (!attempt) return
    draftRef.current = { decisions, touched }
    setReviewDecisions(decisions)
    setTouchedPaths(touched)
    const scope = draftSaveRef.current
    const saved = decisions.filter((decision) => touched.has(resultPathKey(decision.resultPath)))
    if (scope.conflict) {
      rememberReviewDraft(attempt.extractionId, { version: scope.version, decisions: saved })
      return
    }
    scope.writes += 1
    setDraftSaving(true)
    setDraftSaved(false)
    setDraftError(null)
    const write = saveExtractionReviewDraft(attempt.extractionId, saved, scope.version)
    scope.pending = write.then((result) => {
      scope.version = result.version
      if (draftSaveRef.current === scope) setDraftSaved(true)
    })
    void scope.pending.catch((error: unknown) => {
      if (draftSaveRef.current !== scope) return
      const message = error instanceof Error ? error.message : 'Draft could not be saved.'
      // Retrying a stale version can never succeed; only reloading server state can.
      if (message === REVIEW_DRAFT_CONFLICT) scope.conflict = true
      setDraftError(message)
    }).finally(() => {
      scope.writes -= 1
      if (draftSaveRef.current === scope) setDraftSaving(scope.writes > 0)
    })
  }
```

5. In `setReviewDecision`, delete the comment and the line `delete (next as { carriedFrom?: unknown }).carriedFrom`.
6. Delete `pairRecords` (lines 610 to 617) and, in the returned `review` object, the `transfer:` line and the whole `pairing:` block (lines 655 to 661). Delete the `runExtraction` fifth parameter (`pages`) and the `...(pages ? { pages } : {})` spread in the request it builds.

`reviewDrafts.ts`: line 1 imports `extractionReviewDraftSchema, type ReviewDecisionInput` only; line 5 is `type ReviewDraft = { version: number; decisions: readonly ReviewDecisionInput[] }`; in `canonical` (line 45) drop `, decision.carriedFrom`; delete the pairings comparison (lines 50 to 51) so `matches` is `local && canonical(local.decisions) === canonical(server?.decisions ?? [])`; delete the `pairings:` line of the returned object (59). Every caller of `rememberReviewDraft` now passes `{ version, decisions }` only.

`api.ts`: delete the `sampleFactsResponse` import (line 2), `readSampleFacts` (28 to 33) and the `ReviewPairing` type import (20); `saveExtractionReviewDraft` loses its fourth parameter and the two `...(pairings && { pairings })` spreads.

- [ ] **Step 7: The batch review grid and the batch panel**

`useBatchExtractionReviewGrid.ts`: delete the three type imports (13 to 15) and the three state fields (36 to 38); delete `delete next.carriedFrom` (78); `persistDraft(state)` has one parameter, passes no pairings to `rememberReviewDraft` and `saveExtractionReviewDraft`, and loses the `refreshPairing` reload (lines 159 to 176 keep the version bookkeeping only); the ready state (lines 228 to 230) and the reset (418) lose `transfer`, `pairings` and `sources`; line 233 to 234 become `if (recovered.retry && state.editable) persistDraft(state)`; delete `pairRecords` (535 to 556) and its entry in the returned object (583).

`BatchExtractionReviewGrid.tsx`: line 491 becomes `state.decisions.some((decision) => decision.evidenceAnchorId !== null)) void grid.saveMember(id)`; delete lines 865 to 866 (`unmatched`) and 868 (the "reviewed in sample" paragraph); the `ReviewAttention` element loses `transfer={state.transfer}`; delete the pairing paragraphs and the `Pair with…` select (877 to 883).

`BatchExtractionsPanel.tsx`: delete the import (line 1), `sampleFactsRefresh` (229) and its call (703), and the `<SampleFacts …/>` element (1080 to 1082); its wrapping `div.mb-3` keeps the `SavedMethodSummary` that follows.

Delete `prototypes/studio/src/SampleFacts.tsx`.

- [ ] **Step 8: Typecheck, lint, test**

```bash
pnpm -C prototypes/studio typecheck
pnpm -C prototypes/studio lint
pnpm -C prototypes/studio test
```

Expected: all green. Fixtures in other tests that render `DocumentWorkspace` with `latestSample` or assert on coverage copy fail here: remove the prop or the assertion, nothing else.

- [ ] **Step 9: Commit**

```bash
git add -A prototypes/studio/src
git commit -m "feat(studio): the workspace runs the whole document; sample pages, transfers and pairings leave the client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Contracts, the extraction package and the API forget samples

**Files:**
- Modify: `prototypes/studio/shared/extraction.contract.ts`, `shared/projectContext.contract.ts`, `api/_extractions.ts`, `api/extractions.ts`, `api/document_reopen.ts`
- Delete: `prototypes/studio/api/sample_facts.ts`, `api/sample_facts.postgres.test.ts`, `shared/sampleFacts.contract.ts`
- Modify: `packages/extraction/src/types.ts`, `review-rules.ts`, `review-attention.ts`, `module.ts`, `postgres-admission.ts`, `postgres-attempts.ts`, `postgres-persistence.ts`, `workflows.ts`
- Test: `packages/extraction/src/postgres-admission.integration.test.ts`, `postgres-attempts.integration.test.ts`, `postgres-reviews.integration.test.ts`, `review-rules.test.ts`, `review-attention.test.ts`, `workflows.test.ts`; `prototypes/studio/api/extractions.test.ts`, `document_reopen.test.ts`; `prototypes/studio/src/ProjectNavigation.test.tsx`

**Interfaces:**
- Consumes: the client of Task 3, which reads none of the removed fields.
- Produces: `ReviewDraft = { attention?, version, decisions }`; `DocumentExtractionsSnapshot = { sourceRepresentationRevisionId, latestAttempt, latestReviewed }`; `extractionRequestSchema` without `pages`; `extractionReadResponseSchema.reviewDraft` without `transfer`, `pairings`, `sources`; attention cells' `decision` is `{ action }`.

- [ ] **Step 1: Write the failing server tests**

`packages/extraction/src/postgres-attempts.integration.test.ts`: replace the case `'a newer reviewed sample is listed apart and displaces neither the full result nor the summary'` (line 74 to 96) with:

```ts
it('a legacy sample row is never the latest or the latest reviewed attempt', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const document = project.documents[0]!
    const { module } = createRuntime(project.researcherAccountId)
    const full = await module.runSingle(freshInput(project))
    await module.finalizeReview(full.extraction.extractionId, (await module.prepareReview(full.extraction.extractionId)).reviewDecisions)
    // A row the removed sample workbench wrote: newer than the whole-document run, scoped to one page, reviewed.
    const later = new Date(Date.now() + 60_000)
    await db.orm.public.Extraction.create({
      id: randomUUID(), sourceDocumentId: document.sourceDocumentId,
      sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, batchExtractionId: null,
      requestedPages: [1], outcome: 'SUCCEEDED', reviewedAt: later, createdAt: later,
    })
    const reopened = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId })
    assert.equal(reopened?.latestAttempt?.extractionId, full.extraction.extractionId)
    assert.equal(reopened?.latestReviewed?.extractionId, full.extraction.extractionId)
    assert.equal('samples' in (reopened ?? {}), false)
  })
```

(`seedProject`, `createRuntime`, `freshInput`, `cleanup` and `db` come from the file's `fixture` destructuring; `randomUUID` is already imported there.)

`prototypes/studio/api/extractions.test.ts`: replace `'reads a batch member carrying sample draft provenance through the owned Extraction DTO'` (450 to 465) with a request test in the same style as the file's other `create` cases:

```ts
  it('refuses a run that still names sample pages', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    const refused = await handle(request({ ...fresh, pages: [1] }))
    expect(refused.status).toBe(422)
    await expect(refused.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    expect(module.runSingle).not.toHaveBeenCalled()
  })
```

(`extractionModule`, `handlerFor`, `request` and `fresh` are the file's existing helpers, defined above its first `describe`.)

`packages/extraction/src/postgres-reviews.integration.test.ts`: add, beside the finalize cases:

```ts
it('a stored decision with a legacy carriedFrom still reads back', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const { module } = createRuntime(project.researcherAccountId)
    const run = await module.runSingle(freshInput(project))
    const prepared = await module.prepareReview(run.extraction.extractionId)
    await module.finalizeReview(run.extraction.extractionId, prepared.reviewDecisions)
    const review = (await db.orm.public.ExtractionReview.where({ extractionId: run.extraction.extractionId }).select('id').first())!
    await db.orm.public.ReviewDecision.where({ extractionReviewId: review.id })
      .update({ carriedFrom: { extractionId: 'old-sample', sourcePathKey: '["records",0,"title"]' } })
    const read = await module.readExtractionAttempt(run.extraction.extractionId)
    assert.equal(read?.reviewDecisions.length, prepared.reviewDecisions.length)
    assert.equal(read?.reviewDecisions.some((decision) => 'carriedFrom' in decision), false)
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm -C packages/extraction test:postgres` (it needs `EXTRACTION_TEST_DATABASE_URL`, or `DATABASE_URL`, pointing at a migrated disposable `free_test_*` database, as the suite's own skip message says) and `pnpm -C prototypes/studio exec vitest run api/extractions.test.ts -t "sample pages"`.
Expected: FAIL (`samples` is still returned; `pages` is still accepted; `carriedFrom` is still read).

- [ ] **Step 3: Shared contracts**

`prototypes/studio/shared/extraction.contract.ts`: delete `pages` and its comment (74 to 75); delete `carriedFrom` and its comment (119 to 120); delete `requestedPages` and its comment (421 to 422); delete `reviewPairingSchema`, its comment and `ReviewPairing` (510 to 514); in `extractionReadResponseSchema.reviewDraft.attention.cells` the decision object is `z.object({ action: reviewDecisionActionSchema }).nullable()`; delete `transfer`, `pairings` and `sources` with their comments (528 to 536); delete the `ReviewTransferVerdicts` and `ReviewTransferSources` types (541 to 542); delete `pairings` and its comment from `extractionReviewDraftSchema` (547 to 548).

`prototypes/studio/shared/projectContext.contract.ts`: delete `latestSample` and its comment (227 to 228).

- [ ] **Step 4: The extraction package**

`types.ts`: delete `carriedFrom` and its comment (104 to 105); delete `TransferRecord`, `TransferEntry`, `ReviewTransfer` and their comments (112 to 137); delete `requestedPages` and its comment in both snapshots (284 to 285, 319 to 320) and `reviewTransfer` (299 to 300); delete `pages` and its comment from `FreshExtractionInput` (347 to 348); delete `ReviewPairing` (371 to 372) and `pairings`, `sources`, `transfer` with their comments from `ReviewDraft` (378 to 384); delete `samples` and its comment from `DocumentExtractionsSnapshot` (477 to 478).

`review-rules.ts`: the type import (lines 8 to 9) keeps `EvidenceLink, ExtractionSchemaNode, ExtractionSnapshot, ReviewDecisionInput`; delete the `carriedFrom` spreads at 103 and 211 to 213; delete everything from `type TransferSample = …` (292) to the end of the file. Remove `valueAtPath` from the imports if nothing above line 292 uses it.

`review-attention.ts`: `ReviewCell.decision` is `{ action: ReviewDecisionInput['action'] } | null` and the `scalar` function pushes `decision: decision ? { action: decision.action } : null`.

`module.ts`: the import list from `./review-rules.js` loses `transferVerdicts` and `unmatchedSources`; delete the `carried` helper and its comment (19 to 26); `readReviewDraft` ends with `return withAttention(draft)` (delete from `const pinned = extraction.reviewTransfer` through the `return withAttention({ … })` block); `saveReviewDraft` ends with `return persistence.saveReviewDraft(extractionId, draft)` right after the validation `throw` (delete the pairing paragraph that follows). Remove the now-unused `resultPathKey` import if eslint reports it.

`postgres-admission.ts`: delete the import at line 41 and the `ReviewPairing`, `ReviewTransfer` type imports (52 to 53); delete `requestedPages` from `AdmissionPins` (143), from the pins object (189), from `AdmittedIdentity` (204) and from `sameAdmission` (219, so the function ends at the `requestedSettings` comparison); delete `samplesReviewTransfer` with its comment (222 to 256); drop `'requestedPages'` from the identity select (278); delete line 311 and the two spreads at 322 to 323 (the `create` call ends with `requestedSettings: pins.requestedSettings, batchExtractionId: null`); in `admitBatchMember` delete line 559 and the spread at 570.

`postgres-attempts.ts`: `readAttemptRows` no longer selects `requestedPages` or `reviewTransfer` (55, 57); `pinsOf` drops `requestedPages` (138); the decision select drops `'carriedFrom'` (161); `extractionSnapshot` drops `reviewTransfer` (177) and the `carriedFrom` spread (187); `loadDocumentExtractions` keeps the `'requestedPages'` select and the `whole` filter at 238 (the one place the retired column is read), deletes the `samples` query and comment (261 to 264), passes only `selected` and `latestReviewed` ids to `loadAttempts`, and returns no `samples`.

`postgres-persistence.ts`: delete `SAMPLE_PAGE_LIMIT` (72) and the `if (input.pages) { … }` block at the top of `scheduleExtraction` (175 to 186).

`workflows.ts`: delete `requestedPages` and its comment from `AdmittedExtraction` (35 to 37); line 101 reads `options: keiMethodOptions(method),`.

- [ ] **Step 5: The API**

`api/_extractions.ts`: delete line 126 (`requestedPages`).

`api/extractions.ts`: delete line 97 (`...(parsed.data.pages ? { pages: parsed.data.pages } : {})`).

`api/document_reopen.ts`: delete `samples` from the parameter type (113); replace lines 128 to 133 with

```ts
  const [attemptSchema, reviewedSchema] = await Promise.all([
    schemaFor(documentExtractions.latestAttempt),
    schemaFor(documentExtractions.latestReviewed),
  ])
```

delete the `latestSample:` line (182) and `samples: [],` (269).

Delete `api/sample_facts.ts`, `api/sample_facts.postgres.test.ts` and `shared/sampleFacts.contract.ts`. The dispatcher globs `api/[a-z]*.ts`, so the route disappears with the file.

- [ ] **Step 6: Remove the sample tests and fixtures the contracts no longer admit**

Delete: `postgres-admission.integration.test.ts` cases `"a sample's pages are its admission identity, never its method"` (231) and `'pins the decisions of samples on two page sets at admission, and a later sample edit changes nothing'` (247 to the `it(` at 264); `review-rules.test.ts` the whole `describe('Review transfer from a sample to a later run', …)` (241 to the end of the file, 430); `review-attention.test.ts` assertions on `provenance` (keep the cases, drop the provenance expectations); `postgres-reviews.integration.test.ts` the looped case ``seeds a … whose every value carries, requiring explicit finalization`` (the `for (const batchMember …) it(` at line 82 through the line before `it('projects only the active review revision` at 117); `testing/extraction-fixture.ts` any helper only those cases used (`grep -n -i 'sample\|pages' packages/extraction/src/testing/extraction-fixture.ts`; `extractionRow` keeps selecting `requestedPages`, which still exists); `workflows.test.ts` case at 536 to 546, replaced by:

```ts
  it('every admitted run asks kei for the whole document', async () => {
    const run = harness({ admitted: admittedExtraction() })
    await run.run()
    assert.deepEqual((run.submissions[0]!.request as KeiExtractInput).request.options, { strategy: 'article' })
    assert.equal(run.row.outcome?.outcome, 'SUCCEEDED')
  })
```

(`admittedExtraction({ requestedPages })` no longer typechecks; drop the option from the helper.)

`prototypes/studio/api/document_reopen.test.ts`: remove `samples: [],` (108, 263) and any `latestSample` assertion. `prototypes/studio/src/ProjectNavigation.test.tsx`: remove `latestSample: null,` (140, 219, 2447). `prototypes/studio/e2e/project-navigation.spec.ts`: remove `samples: [],` (115).

- [ ] **Step 7: Typecheck, lint and run every suite**

```bash
pnpm -C packages/extraction typecheck
pnpm -C packages/extraction test
pnpm -C packages/extraction test:postgres
pnpm -C prototypes/studio typecheck
pnpm -C prototypes/studio lint
pnpm -C prototypes/studio test
pnpm -C prototypes/studio test:postgres
```

The two `test:postgres` scripts need `EXTRACTION_TEST_DATABASE_URL` (or `DATABASE_URL`) pointing at a migrated disposable `free_test_*` database; `prototypes/studio/README.md` describes the compose database. Expected: all green, and the three new cases pass.

- [ ] **Step 8: Commit**

```bash
git add -A packages/extraction/src prototypes/studio/shared prototypes/studio/api prototypes/studio/src prototypes/studio/e2e/project-navigation.spec.ts
git commit -m "feat(extraction): admission, review and the API forget sample pages, pinned transfers and pairings

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Browser journey, schema comments, domain language

**Files:**
- Modify: `prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts:903-1009`
- Modify: `packages/db/src/prisma/contract.prisma:223-231, 288-289`
- Modify: `CONTEXT.md:119-122, 133-135`

**Interfaces:**
- Consumes: the client and API of Tasks 3 and 4.
- Produces: one browser journey `import → whole source → review → collection review`.

- [ ] **Step 1: Reduce the journey**

Rename the test at line 903 to `'import → whole source → review → collection review @deterministic'`. Keep lines 904 to 952 (setup and the codebook import through the `imported.schemaTree` assertion). Replace lines 953 to 993 (from `await page.getByRole('button', { name: 'Select sample pages' }).click()` to the `Sample · rev 3` expectation) with nothing, so the next statement is `await page.getByRole('button', { name: '▶ Run extraction', exact: true }).click()`. Keep everything from there to the end of the test. Then delete the test's remaining references to a sample: none should remain (`grep -n -i sample prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts` shows only the fixture names `Sample Researcher`, `Sample E2E`, `sample.pdf`, `Sample schema`, which stay).

- [ ] **Step 2: Run the journey if the deterministic e2e stack is available on this machine**

Run: `pnpm -C prototypes/studio exec playwright test e2e/canonical-evidence-lifecycle.spec.ts -g "collection review"`
Expected: PASS. If the stack (compose services, kei stand-in) is not available, say so in the commit body and leave the run to the weekly e2e; do not skip silently.

- [ ] **Step 3: Retire the columns in the schema comments**

In `packages/db/src/prisma/contract.prisma` replace the comments above the three Extraction columns (lines 223 to 231) with:

```prisma
  // Retired on 2026-10-02 with the sample workbench. Never written since; read only as `IS NULL` to keep legacy sample
  // rows out of a document's latest attempt. A later migration drops it.
  requestedPages                 Json?
  // Retired on 2026-10-02 with the sample workbench. Never written or read since; a later migration drops it.
  reviewTransfer                 Json?
  // Retired on 2026-10-02 with the sample workbench. Never written or read since; a later migration drops it.
  reviewPairings                 Json?
```

and the comment above `carriedFrom` (line 288) with `// Retired on 2026-10-02 with the sample workbench. Never written or read since; a later migration drops it.`

Run `pnpm db:generate` and confirm it succeeds (comments only; no migration).

- [ ] **Step 4: Domain language**

In `CONTEXT.md`, delete the `**Sample Extraction**:` entry (its three lines plus the blank line after, 119 to 122) and the `**Carried Review Decision**:` entry (133 to 135 plus its blank line). Afterwards `grep -n 'Sample Extraction\|Carried Review' CONTEXT.md` prints nothing.

- [ ] **Step 5: Final verification and commit**

```bash
pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio test
git grep -n -i -E 'sample(Facts|Pages|_facts)|requestedPages|reviewTransfer|reviewPairings|carriedFrom|TransferEntry|ReviewPairing' -- . ':!packages/db/src/prisma' ':!packages/db/migrations' ':!docs' ':!*.samples.json'
```

Expected: typecheck, lint and tests green; the grep prints only `packages/extraction/src/postgres-attempts.ts` (the `requestedPages` select and `IS NULL` filter), `packages/extraction/src/testing/extraction-fixture.ts` (`extractionRow` still selects the column), and the two integration tests that seed legacy rows on purpose (`postgres-attempts.integration.test.ts`, `postgres-reviews.integration.test.ts`); nothing else. Then:

```bash
git add prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts packages/db/src/prisma/contract.prisma CONTEXT.md
git commit -m "chore: retire the sample columns, the sample domain terms and the sample browser steps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
