# Studio Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Source Document workspace of FREE Studio to the layout of the redesign spec: one tab-strip row with a project chip and a single green Run action, an edge-to-edge document with a thumbnail page rail and one toolbar, a schema panel whose field names are never truncated and whose fields delete in one click with undo, a chat that is a composer line until it is used, and a Results tab whose per-value states the streaming spec can later populate.

**Architecture:** Everything stays inside `prototypes/studio/src` (plus `DESIGN.md`): no server, contract or package changes. The work proceeds from primitives (tokens, `Button` variants, a `Toast` with an action slot) through the schema panel header, the frame and run action, the thumbnail rail, the field rows, the chat drawer, the Results tab and the import dialog, so each commit leaves the app coherent and its tests green. State that today lives in the toolbar (record scope, record boundaries, save state) moves into the schema panel through props threaded by `RightRail`; the run click re-reads the account's saved method so admission pins what was saved at the click.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4 (`@theme` tokens in `src/index.css`), pdfjs-dist 6 (thumbnails from the viewer's own `PDFDocumentProxy`), Vitest + Testing Library (`// @vitest-environment jsdom`), Playwright (`e2e/`), `src/ui` primitives.

**Spec:** `docs/superpowers/specs/2026-10-02-studio-workspace-redesign-design.md` (base: `origin/dev` at b77fabb7, after the sample-workbench removal). Worktree: `/home/gennaro/projects/FREE-worktrees/studio-workspace-redesign`, branch `feat/studio-workspace-redesign`.

## Global Constraints

- No new dependency; thumbnails render with the `pdfjs-dist` already loaded. No `pnpm add`.
- Install in the worktree with `pnpm install --prefer-offline --frozen-lockfile --ignore-scripts` then `pnpm db:generate`; never a bare `pnpm install` (the postinstall builds a multi-GB venv).
- Tokens and type from `DESIGN.md` and `src/index.css`, with the §10 amendment. Four text sizes in the rail: 13 content, 12 secondary, 11 compact, 10.5 overline, as the utilities `text-content`, `text-secondary`, `text-compact`, `text-overline` (Task 1). No new `text-[9px]`, `text-[9.5px]`, `text-[10px]`, `text-[11.5px]`, `text-[12.5px]` or `text-[13.5px]` in the files this plan touches; existing ones in a touched component are converted.
- Colour is never the only signal: every coloured action keeps an icon or a label; every state has a text equivalent.
- Hit targets at least 24px (28px for the field-row actions); hover-revealed controls are also revealed by `:focus-within`.
- `src/ui` primitives are used, not mirrored: `Button`, `Pill`, `SegmentedControl`, `Overline`, `Panel`, `EmptyState`, `ModalDialog`, and the new `Toast`.
- Domain language from `CONTEXT.md`: copy says "researcher", never "user", and never "JSON" in a researcher-facing label (the Results view "Raw JSON" becomes "Values as code", the schema view "JSON" becomes "Code", the completion toasts stop saying JSON).
- The next-step line of `2026-10-02-workflow-guidance-design.md` is not built here; this plan removes the floating hint pill it replaces and leaves the slot above the content empty.
- Every commit: `pnpm -C prototypes/studio typecheck`, `pnpm -C prototypes/studio lint`, and the touched test files pass. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` scoped paths only.
- Line numbers in this plan point at the base commit b77fabb7; every task shifts the next one's. They are anchors to the text named beside them, not addresses: find the text, then edit.
- Tests that assert removed controls are rewritten, never deleted wholesale: each task names the test files it changes and what each assertion becomes.

## Rulings taken while planning (the controller may re-rule; each cites the spec text it resolves)

1. **`SavedMethodSummary` is not deleted.** The spec's Files section deletes it, but `projectContexts/BatchExtractionsPanel.tsx` renders its `panel` variant twice and the project page is out of scope. Ruling: delete the `toolbar` variant and the `variant` prop; keep the component for the batch panel. Costs one small file if wrong.
2. **The tab-strip slot shows the save state only while it blocks or is in flight** (`SchemaSaveStatus` already renders nothing once saved). §1 puts "the schema save state" in the slot and §5 puts "Saved · revision 3" in the panel footer; both hold when the slot carries the transient states and the footer the persistent one.
3. **The snapshot `<select>` ("Latest attempt / Latest reviewed"), the "Open latest reviewed" button and the indexing status leave the tab strip** (§1: "Nothing else") and render at the right of the Results tab header, which is where they decide what is shown. The indexing status also stays in the Run button's disabled `title`.
4. **The undo toast for a deleted field is hosted by the schema panel itself**, docked above the composer, through the same `Toast` primitive that replaces the inline toast of `App.tsx` (§6: "the existing showToast with an action slot added"). The panel also renders inside the batch panel, which has no document toast; one host inside the panel serves both and keeps the toast next to the action.
5. **"Start blank" initialises a durable schema with no fields** (`schemaNodesSchema` allows an empty array) **and the record description "Untitled record"** (`recordDescriptionSchema` requires at least one character); the panel then renames it "Untitled schema". The researcher replaces both.
6. **Default names are set by the client.** The server names every new Extraction Schema "Extraction Schema" (`project-store.ts`); the client renames it through the existing `PATCH /api/extraction-schemas/:id` right after the first generation or import, to the Source Document's file name without its extension (`defaultSchemaName`). A failed rename keeps the server's name; nothing else fails.
7. **`method_changed` is told apart from the other refusals** by passing the refusal code to `onMethodChanged` (one extra argument in `useExtraction.ts`); migration and record-scope refusals show their message as a toast, since the summary that showed them is gone.
8. **The collapsed rail's monogram is an inline SVG** (`FreeMonogram.tsx`: a 24px rounded square in accent with a white "F"); there is no monogram asset and no new file may be added under `public/` without a designer's mark.
9. **Undo restores the removed subtree at its old parent and index** (`restoreSchemaNode`), not the whole previous tree, so edits made after the delete survive. When the parent is gone or the name is now taken, the commit fails and the toast says "Could not restore the field" (spec, Error handling).
10. **Type pill words:** `string`, `number`, `integer`, `boolean`, `date`, `verbatim` (for `verbatim-string`), `object`, `list of <plural item type>` (`list of strings`, `list of dates`), `list of objects`; a collapsed group appends ` · n fields` (spec §6 item 2 and 4).

## Review Focus

1. **The saved-method read fails at the click** (network error on `/api/model_config`): nothing starts, the toast says "Saved advanced settings could not be read. Nothing was started." — Task 4.
2. **Undo after the parent group was deleted or the name was re-used**: no field appears twice, the toast says "Could not restore the field" — Task 6.
3. **A thumbnail render rejects** (`getPage` throws, no 2D context, no `createImageBitmap`): the card shows the number, navigation and keyboard still work — Task 5.
4. **The page input receives `0`, `999` or `abc`**: nothing navigates, the field resets to the current page on blur — Task 4.
5. **A pending proposal with the drawer collapsed**: the dot marks it and the Apply / Discard bar is reachable again on reopen; a collapse never discards — Task 7.

---

## File structure

New: `src/ui/Toast.tsx`, `src/ui/Toast.test.tsx`, `src/useToast.ts`, `src/FreeMonogram.tsx`, `src/schemaNames.ts`, `src/schemaNames.test.ts`, `src/resultsBadge.ts`, `src/resultsBadge.test.ts`, `src/SchemaActionsMenu.tsx`, `src/PageThumbnails.ts`, `src/PageThumbnails.test.ts`, `src/PageNavigation.test.tsx`, `src/DocumentTabBar.test.tsx`, `src/ui/Button.test.tsx`, `src/FieldRow.tsx` (the field row, extracted from `SchemaPanel.tsx`), `src/fieldTypeWords.ts`, `src/fieldTypeWords.test.ts`, `src/ChatDrawer.tsx`.

Edited: `src/index.css`, `DESIGN.md`, `src/ui/README.md`, `src/ui/Button.tsx`, `src/ui/index.ts`, `src/ui/ResultValue.tsx`, `src/App.tsx`, `src/AppFrame.tsx`, `src/DocumentTabBar.tsx`, `src/PageNavigation.tsx`, `src/RightRail.tsx`, `src/SchemaPanel.tsx`, `src/SchemaNameEditor.tsx`, `src/SchemaInstructions.tsx`, `src/SchemaSaveStatus.tsx`, `src/SchemaImport.tsx`, `src/SavedMethodSummary.tsx`, `src/ResultsTab.tsx`, `src/ReviewAttention.tsx`, `src/useExtraction.ts`, `src/schemaEditorTree.ts`, the 20 `variant="primary"` call sites (Task 1), and the tests beside each; `e2e/canonical-evidence-lifecycle.spec.ts`, `e2e/real-application-route.spec.ts`, `e2e/interactive-reload.spec.ts`, `e2e/interactive-restart.spec.ts`.

Deleted: nothing whole (see Ruling 1). Removed inside files: the breadcrumb row, the floating hint pill, the toolbar strategy and boundaries selects, the toolbar `SavedMethodSummary`, the selection checkboxes and bulk delete, the chat greeting bubble, the "n fields" footer, the `nyt_felt` default.

---

### Task 1: Type tokens and the `positive` / `danger` button variants (§10)

**Files:**
- Modify: `prototypes/studio/src/index.css:6-45` (`@theme`)
- Modify: `prototypes/studio/src/ui/Button.tsx`
- Create: `prototypes/studio/src/ui/Button.test.tsx`
- Modify: the 20 `variant="primary"` call sites listed in Step 5
- Modify: `prototypes/studio/DESIGN.md` (§2 Rules, §3 Scale, §5 Action Button), `prototypes/studio/src/ui/README.md` (Button row)

**Interfaces:**
- Produces: `ButtonProps['variant']` is `'positive' | 'danger' | 'secondary' | 'pill'` (default `secondary`); utilities `text-content`, `text-secondary`, `text-compact`, `text-overline`.

- [ ] **Step 1: Write the failing test** `src/ui/Button.test.tsx`

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import Button from './Button'

afterEach(cleanup)

it('positive is a green fill with white text, danger a danger fill, secondary an outline', () => {
  render(<>
    <Button variant="positive">▶ Run</Button>
    <Button variant="danger">Delete</Button>
    <Button>Cancel</Button>
  </>)
  expect(screen.getByRole('button', { name: '▶ Run' }).className).toMatch(/\bbg-green\b.*\btext-white\b/)
  expect(screen.getByRole('button', { name: 'Delete' }).className).toMatch(/\bbg-danger\b.*\btext-white\b/)
  expect(screen.getByRole('button', { name: 'Cancel' }).className).toMatch(/\bborder-line\b/)
})

it('a disabled positive button loses its fill, so colour never carries the state alone', () => {
  render(<Button variant="positive" disabled>▶ Run</Button>)
  expect(screen.getByRole('button', { name: '▶ Run' }).className).toMatch(/disabled:bg-line/)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm -C prototypes/studio exec vitest run src/ui/Button.test.tsx`
Expected: FAIL — `positive` renders the default classes (TypeScript also rejects the variant until Step 3).

- [ ] **Step 3: Rewrite `src/ui/Button.tsx`**

```tsx
import type { ComponentPropsWithRef } from 'react'

type Variant = 'positive' | 'danger' | 'secondary' | 'pill'
type Size = 'sm' | 'md'

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  /** Visual weight: green `positive` (run, apply, accept, save, finalize), danger `danger` (delete, clear, discard,
   *  cancel), outline `secondary`, or rounded `pill`. Terracotta is for brand, active and selection states only. */
  variant?: Variant
  size?: Size
}

const base =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-semibold outline-none transition-colors disabled:cursor-default disabled:opacity-60'

const variants: Record<Variant, string> = {
  positive:
    'rounded-[3px] border border-green bg-green text-white transition-[filter] hover:brightness-108 disabled:border-line disabled:bg-line disabled:text-ink-muted',
  danger:
    'rounded-[3px] border border-danger bg-danger text-white transition-[filter] hover:brightness-108 disabled:border-line disabled:bg-line disabled:text-ink-muted',
  secondary:
    'rounded-[3px] border border-line bg-surface text-ink-muted hover:border-accent/50 hover:text-accent focus-visible:border-accent',
  pill:
    'rounded-full border border-line bg-surface text-ink-muted hover:border-accent/50 hover:bg-accent-soft hover:text-accent focus-visible:border-accent disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-ink-muted',
}

const sizes: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-compact',
  md: 'px-4 py-2 text-secondary font-bold',
}

function Button({ variant = 'secondary', size = 'sm', className = '', type, ...props }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  )
}

export default Button
```

- [ ] **Step 4: Add the text tokens to `src/index.css`** inside `@theme`, after `--color-danger-soft`:

```css
  /* Rail type scale (DESIGN.md §3): content, secondary, compact, overline. Tailwind derives the utilities
     text-content, text-secondary, text-compact and text-overline from these. */
  --text-content: 13px;
  --text-secondary: 12px;
  --text-compact: 11px;
  --text-overline: 10.5px;
```

- [ ] **Step 5: Map every `variant="primary"`** (grep `variant="primary"` under `src`, excluding tests; 20 hits at the base commit):

| File | Button | New variant |
|---|---|---|
| `App.tsx:942` | ▶ Run extraction | `positive` |
| `ResultsTab.tsx:1145, 1161, 1182` (`RunExtractionButton`) and `:1165` ("Generate a schema first") | run actions | `positive` |
| `ExtractionFinishedDialog.tsx:58`, `projectContexts/BatchExtractionFinishedDialog.tsx:187` | Review now | `positive` |
| `SchemaImport.tsx:69` | Confirm schema | `positive` |
| `providerConfig/ProviderConfigPage.tsx:277` | Apply | `positive` |
| `projectContexts/CreateProjectModal.tsx:120`, `projectContexts/ReprocessSourceModal.tsx:86` | form submits (create, reprocess) | `positive` |
| `projectContexts/BatchExtractionsPanel.tsx:942, 1279` | run a Batch Extraction | `positive` |
| `ui/DeleteDialog.tsx:68` | Delete permanently | `danger` |
| `auth/AuthForms.tsx:86, 104, 118, 180` | Retry, Sign in, Continue, Retry | `secondary` |
| `projectContexts/StudioHome.tsx:130, 191` | Create project (opens the modal) | `secondary` |

Then grep again: `grep -rn "variant=\"primary\"\|variant='primary'" prototypes/studio/src` must print nothing (test files included — fix any test that renders `variant="primary"`).

- [ ] **Step 6: Docs.** `DESIGN.md` §2 Rules: replace "Use accent only for commands and active states; focus uses the dual-color global indicator." with

```
- Terracotta (accent) marks brand, the active tab, selection and drag states, and focus.
- Green (`--color-green`) fills positive commands: run, apply, accept, save, finalize.
- Red (`--color-danger`) fills destructive commands: delete a field, clear the schema, discard a proposal, cancel.
- Every coloured action keeps an icon or a label; colour is never the only signal.
```

§3 Scale: add a line under the table: "In the right rail only four sizes are used, as the tokens `--text-content` (13), `--text-secondary` (12), `--text-compact` (11) and `--text-overline` (10.5) in `index.css`." §5 Action Button variants: "green positive, danger, surface secondary, rounded pill; disabled is a line fill." `src/ui/README.md` Button row: "`positive` (green) / `danger` / `secondary` (outline) / `pill` actions".

- [ ] **Step 7: Verify**

Run: `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/ui/Button.test.tsx src/ResultsTab.test.tsx src/App.test.tsx src/projectContexts src/auth src/providerConfig`
Expected: all pass (no test asserts the old `bg-accent` fill on a primary button; if one does, update it to `bg-green` and say so in the report).

- [ ] **Step 8: Commit**

```bash
git add prototypes/studio/src/index.css prototypes/studio/src/ui/Button.tsx prototypes/studio/src/ui/Button.test.tsx prototypes/studio/src/ui/README.md prototypes/studio/DESIGN.md <the 20 mapped files>
git commit -m "feat(studio): green positive and red danger button variants; rail type tokens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `Toast` with an action slot and the `useToast` host hook (§6, Files)

**Files:**
- Create: `prototypes/studio/src/ui/Toast.tsx`, `prototypes/studio/src/ui/Toast.test.tsx`, `prototypes/studio/src/useToast.ts`
- Modify: `prototypes/studio/src/ui/index.ts` (export), `prototypes/studio/src/App.tsx:161, 195-198, 437-452, 1009-1015` (the inline toast and its timer), `prototypes/studio/src/ui/README.md` (row)

**Interfaces:**
- Produces: `Toast({ message, action?, onDismiss?, className? })`; `useToast(): { toast: ToastState | null; showToast(message, options?); dismissToast() }` with `ToastOptions = { durationMs?: number; action?: ToastAction; outlivesSwitch?: boolean }` and `ToastState = { message: string; action?: ToastAction; outlivesSwitch: boolean }`. Default duration 2600 ms (as today).

- [ ] **Step 1: Write the failing test** `src/ui/Toast.test.tsx`

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Toast from './Toast'
import { useToast } from '../useToast'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('announces the message and runs its one action, then dismisses', () => {
  const onAction = vi.fn(), onDismiss = vi.fn()
  render(<Toast message="Field removed" action={{ label: 'Undo', onAction }} onDismiss={onDismiss} />)
  expect(screen.getByRole('status')).toHaveTextContent('Field removed')
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(onAction).toHaveBeenCalledOnce()
  expect(onDismiss).toHaveBeenCalledOnce()
})

it('the host shows one toast at a time and clears it after its duration', () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useToast())
  act(() => result.current.showToast('Saved', { durationMs: 1000 }))
  act(() => result.current.showToast('Field removed', { durationMs: 8000, action: { label: 'Undo', onAction: () => {} } }))
  expect(result.current.toast?.message).toBe('Field removed')
  act(() => vi.advanceTimersByTime(1001))
  expect(result.current.toast?.message).toBe('Field removed')
  act(() => vi.advanceTimersByTime(7000))
  expect(result.current.toast).toBeNull()
})
```

- [ ] **Step 2: Run it to verify it fails** — `pnpm -C prototypes/studio exec vitest run src/ui/Toast.test.tsx` → FAIL (modules missing).

- [ ] **Step 3: Create `src/ui/Toast.tsx`**

```tsx
import type { ReactNode } from 'react'

export type ToastAction = { label: string; onAction: () => void }

export type ToastProps = {
  message: ReactNode
  /** One optional command, e.g. Undo. The toast dismisses after it runs. */
  action?: ToastAction
  onDismiss?: () => void
  className?: string
}

/** A transient notice. The host decides where it sits and for how long; `role="status"` announces it once. */
function Toast({ message, action, onDismiss, className = '' }: ToastProps) {
  return (
    <div
      role="status"
      className={`animate-fadeup pointer-events-auto flex min-w-0 max-w-full items-center gap-3 rounded-xl border border-line-strong bg-surface px-4 py-2 text-compact font-semibold text-ink shadow-float ${className}`}
    >
      <span className="min-w-0 truncate">{message}</span>
      {action && (
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded-sm px-1 font-bold text-green outline-none hover:underline"
          onClick={() => {
            action.onAction()
            onDismiss?.()
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

export default Toast
```

Add to `src/ui/index.ts`: `export { default as Toast } from './Toast'` and `export type { ToastAction, ToastProps } from './Toast'`.

- [ ] **Step 4: Create `src/useToast.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToastAction } from './ui/Toast'

export type ToastOptions = {
  durationMs?: number
  action?: ToastAction
  /** The toast explains the switch of Source Representation that is about to happen, so that switch keeps it. */
  outlivesSwitch?: boolean
}

export type ToastState = { message: string; action?: ToastAction; outlivesSwitch: boolean }

/** One toast at a time; a new message replaces the current one and restarts the timer. */
export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const dismissToast = useCallback(() => {
    window.clearTimeout(timer.current)
    setToast(null)
  }, [])
  const showToast = useCallback((message: string, { durationMs = 2600, action, outlivesSwitch = false }: ToastOptions = {}) => {
    window.clearTimeout(timer.current)
    setToast({ message, ...(action ? { action } : {}), outlivesSwitch })
    timer.current = window.setTimeout(() => setToast(null), durationMs)
  }, [])
  return { toast, showToast, dismissToast }
}
```

- [ ] **Step 5: Migrate `App.tsx`.** Remove `toastTimerRef` (line 161), the `toast` and `toastOutlivesSwitch` state (195-198), the unmount effect (437-442) and the `showToast` function (444-452). Add `const { toast, showToast, dismissToast } = useToast()` beside the other hooks (before `useDurableCurrentSchemaRevision`, which receives `onCommitMessage: (message) => showToast(message)`). In the render-time reset block (lines 243-244) replace the two lines with `if (!toast?.outlivesSwitch) dismissToast()`. Keep every `showToast(...)` call; `onSuperseded` passes `{ outlivesSwitch: true, durationMs: 6000 }` as today. Replace the inline toast markup (1009-1015) with:

```tsx
            {toast && (
              <div className="pointer-events-none absolute inset-x-4 top-4 z-20 flex justify-center">
                <Toast message={toast.message} action={toast.action} onDismiss={dismissToast} />
              </div>
            )}
```

Import `Toast` from `./ui`.

- [ ] **Step 6: Verify** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/ui/Toast.test.tsx src/App.test.tsx` → pass (App tests that `findByText` a toast message still pass: the text is inside `role="status"`).

- [ ] **Step 7: Commit** — `feat(studio): Toast primitive with an action slot; the workspace toast uses it`.

---

### Task 3: Schema panel header, record scope, save footer, empty state, overflow menu and default names (§5, §11)

**Files:**
- Create: `prototypes/studio/src/ActionsMenu.tsx`, `prototypes/studio/src/schemaNames.ts`, `prototypes/studio/src/schemaNames.test.ts`
- Modify: `prototypes/studio/src/SchemaPanel.tsx` (header 1377-1440, empty state 1511-1518, record description 1612-1633, chat-header controls 1724-1794, footer 1861-1873, `view` state), `prototypes/studio/src/SchemaNameEditor.tsx:39-40`, `prototypes/studio/src/SchemaSaveStatus.tsx`, `prototypes/studio/src/SchemaInstructions.tsx` (delete `InstructionCount`), `prototypes/studio/src/SchemaImport.tsx` (an `onConfirmed` callback), `prototypes/studio/src/RightRail.tsx` (two pass-through props), `prototypes/studio/src/App.tsx:497-500, 1064-1081` (default name after generation; rename reads the live snapshot)
- Test: `prototypes/studio/src/SchemaPanel.test.tsx`, `prototypes/studio/src/App.test.tsx`, `prototypes/studio/e2e/interactive-reload.spec.ts`, `prototypes/studio/e2e/interactive-restart.spec.ts`

**Interfaces:**
- Consumes: `Button` variants and `text-*` tokens (Task 1); `SchemaEditorController.confirmDefinition`, `setRecordScope`, `flush`, `snapshot().save` (`SchemaSaveState` has `status` `'saved' | 'dirty' | 'saving' | 'error' | 'conflict'` and `acknowledged.revisionNumber`).
- Produces: `SchemaPanelProps.recordScope?: { value: RecordScope | null; onChange: (scope: RecordScope) => void; disabled?: boolean }` and `SchemaPanelProps.boundaries?: { value: string; options: ReadonlyArray<{ id: string; label: string }>; onChange: (id: string) => void; disabled?: boolean } | null`, both passed through `RightRailProps` under the same names (Task 4 wires `App.tsx` to them); `defaultSchemaName(sourceDocumentName: string): string`; `ActionsMenu({ label, items, trigger? })` with `ActionItem = { id, label, onSelect, disabled?, tone?: 'danger', divider?: boolean }`; the schema panel's view state is `'fields' | 'code'`; the record description control is labelled "What one record is"; the record scope control is `select[aria-label="Record scope"]` with option values `document` and `records`; the boundaries control is `select[aria-label="Boundaries"]`.

- [ ] **Step 1: Write the failing tests.** `src/schemaNames.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { defaultSchemaName } from './schemaNames'

describe('defaultSchemaName', () => {
  it('is the Source Document name without its extension', () => {
    expect(defaultSchemaName('Beretning_Ellekilde_8_13.pdf')).toBe('Beretning_Ellekilde_8_13')
    expect(defaultSchemaName('archive.tar.gz')).toBe('archive.tar')
    expect(defaultSchemaName('No extension')).toBe('No extension')
  })
  it('falls back to "Untitled schema" when the name would be empty or invalid', () => {
    expect(defaultSchemaName('.pdf')).toBe('Untitled schema')
    expect(defaultSchemaName('   ')).toBe('Untitled schema')
  })
})
```

Add to `src/SchemaPanel.test.tsx` (reuse `renderPanel`/`setupController`; read the file's helpers first):

```tsx
describe('schema header (redesign §5)', () => {
  it('names the schema in the heading, switches Fields and Code, and offers the actions menu', () => {
    renderPanel({}, { schemaName: 'Places', onRenameSchema: vi.fn(async () => null) })
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Places')
    expect(screen.queryByText('Extraction Schema')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Code' }))
    expect(screen.getByText(/"recordDescription"/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(
      ['Edit as code', 'History', 'Regenerate from the document…', 'Clear schema'])
  })

  it('says the saved record scope in words and saves a change at once', () => {
    const onChange = vi.fn()
    renderPanel({}, { recordScope: { value: 'document', onChange } })
    const scope = screen.getByLabelText('Record scope')
    expect(scope).toHaveValue('document')
    expect(screen.getByRole('option', { name: 'Catalog · a collection of records' })).toBeInTheDocument()
    fireEvent.change(scope, { target: { value: 'records' } })
    expect(onChange).toHaveBeenCalledWith('records')
  })

  it('asks for Article or Catalog while none is saved, and shows Boundaries only when given', () => {
    const { rerender } = renderPanel({}, { recordScope: { value: null, onChange: vi.fn() } })
    expect(screen.getByLabelText('Record scope')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Choose Article or Catalog' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Boundaries')).not.toBeInTheDocument()
    rerender({}, { recordScope: { value: 'records', onChange: vi.fn() },
      boundaries: { value: '', options: [{ id: 'numbered-catalogue-de@1', label: 'Numbered catalogue (German)' }], onChange: vi.fn() } })
    expect(screen.getByLabelText('Boundaries')).toHaveValue('')
  })

  it('labels the record description "What one record is" and saves it on blur', () => {
    const setup = renderPanel()
    const description = screen.getByLabelText('What one record is')
    fireEvent.change(description, { target: { value: 'One grave.' } })
    fireEvent.blur(description)
    expect(setup.schema.snapshot().draft?.recordDescription).toBe('One grave.')
    expect(screen.queryByText('Record description')).not.toBeInTheDocument()
  })

  it('the footer says the saved revision and never counts fields', () => {
    renderPanel({ durableScope: true })
    expect(screen.getByText('Saved · revision 2')).toBeInTheDocument()
    expect(screen.queryByText(/\d+ fields?\s*$/)).not.toBeInTheDocument()
  })

  it('the empty state offers Generate and Start blank; Start blank creates an empty schema named Untitled schema', async () => {
    const onRenameSchema = vi.fn(async () => null)
    const onGenerateInstructions = vi.fn()
    const setup = renderPanel({ durableScope: true, noSchema: true }, { onGenerateInstructions, onRenameSchema, schemaName: null })
    expect(screen.getByRole('heading', { name: 'No schema yet' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Generate from the document' }))
    expect(onGenerateInstructions).toHaveBeenCalledWith('')
    fireEvent.click(screen.getByRole('button', { name: 'Start blank' }))
    await waitFor(() => expect(setup.initialized).toEqual([{ recordDescription: 'Untitled record', schemaNodes: [] }]))
    await waitFor(() => expect(onRenameSchema).toHaveBeenCalledWith('Untitled schema'))
  })

  it('History, Regenerate and Clear schema open dialogs from the actions menu', async () => {
    const onClearDraft = vi.fn(async () => undefined)
    const onGenerateInstructions = vi.fn()
    renderPanel({ durableScope: true }, { showRegenerate: true, onGenerateInstructions, onClearDraft })
    const open = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: 'Schema actions' }))
      fireEvent.click(screen.getByRole('menuitem', { name }))
    }
    open('History')
    expect(within(screen.getByRole('dialog', { name: 'Schema history' })).getByRole('button', { name: /Revision 2.*Current/ })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    open('Regenerate from the document…')
    const dialog = screen.getByRole('dialog', { name: 'Regenerate from the document' })
    fireEvent.change(within(dialog).getByPlaceholderText(/Add a generation instruction/), { target: { value: 'Focus on dates' } })
    fireEvent.keyDown(within(dialog).getByPlaceholderText(/Add a generation instruction/), { key: 'Enter' })
    fireEvent.click(within(dialog).getByRole('button', { name: /Regenerate schema/ }))
    expect(onGenerateInstructions).toHaveBeenCalledWith(expect.stringContaining('Focus on dates'))
    open('Clear schema')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Clear current schema' })).getByRole('button', { name: 'Clear schema' }))
    await waitFor(() => expect(onClearDraft).toHaveBeenCalledOnce())
  })
})
```

`setupController` needs `initialized: SchemaDefinition[]` recorded by its `initialize` (today it throws "Generation is not exercised here."): record the definition and return an acknowledged revision with `recordDescription`/`schemaNodes` from it, `revisionNumber: 1`, `recordScope: null`; `renderPanel`'s second argument is spread onto `SchemaPanel` props (check the existing helper and extend it rather than re-implement it).

- [ ] **Step 2: Run them to verify they fail** — `pnpm -C prototypes/studio exec vitest run src/schemaNames.test.ts src/SchemaPanel.test.tsx` → FAIL (module missing; no "Record scope", "Schema actions", "Start blank").

- [ ] **Step 3: Create `src/schemaNames.ts`**

```ts
import { extractionSchemaNameSchema } from '../shared/schemaRevision.contract'

export const UNTITLED_SCHEMA_NAME = 'Untitled schema'

/** The name a generated or imported schema gets: the Source Document's file name without its extension (§5). */
export function defaultSchemaName(sourceDocumentName: string): string {
  const base = sourceDocumentName.replace(/\.[^./\\]+$/, '').trim()
  return extractionSchemaNameSchema.safeParse(base).success ? base : UNTITLED_SCHEMA_NAME
}
```

- [ ] **Step 4: Create `src/ActionsMenu.tsx`** (the keyboard model of `providerConfig/ConnectionsTab.tsx:358-420`; Task 4 reuses it for the project chip)

```tsx
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

export type ActionItem = {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  /** A danger item renders in red; `divider` draws a hairline above it. */
  tone?: 'danger'
  divider?: boolean
}

/** A "⋯" (or custom) trigger and a `role="menu"` list: arrow keys move between items, Escape closes and returns focus,
 *  a blur outside closes. Items only receive focus through the arrow keys, so the trigger keeps its place in the tab order. */
export default function ActionsMenu({ label, items, trigger, triggerClassName = '' }: {
  label: string
  items: ActionItem[]
  trigger?: ReactNode
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLUListElement>(null)
  function close(returnFocus: boolean) {
    setOpen(false)
    if (returnFocus) button.current?.focus()
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!open) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const entries = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const at = entries.findIndex((entry) => entry === document.activeElement)
    entries[(at + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]?.focus()
  }
  return (
    <div
      className="relative"
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false)
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`grid h-7 min-w-7 cursor-pointer place-items-center rounded-[3px] border border-line bg-surface px-1 text-ink-muted outline-none transition-colors hover:border-accent/50 hover:text-accent ${triggerClassName}`}
        onMouseDown={(event) => open && event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger ?? <span aria-hidden="true">⋯</span>}
      </button>
      {open && (
        <ul
          ref={menu}
          role="menu"
          aria-label={label}
          onMouseDown={(event) => event.preventDefault()}
          className="absolute right-0 top-full z-30 mt-1 min-w-56 rounded-xl border border-line bg-surface py-1 shadow-float"
        >
          {items.map((item) => (
            <li key={item.id} role="none" className={item.divider ? 'mt-1 border-t border-line pt-1' : ''}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={`flex w-full items-center px-3 py-1.5 text-left text-secondary font-semibold outline-none hover:bg-surface-muted focus-visible:bg-surface-muted disabled:cursor-default disabled:opacity-50 ${
                  item.tone === 'danger' ? 'text-danger' : 'text-ink'
                }`}
                onClick={() => {
                  close(true)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 5: `SchemaSaveStatus`** gains `showSaved?: boolean`: when `showSaved && status === 'saved'` the status span reads `Saved · revision ${save.acknowledged.revisionNumber}`; everything else as today (`text-xs` → `text-secondary`, the Retry button `text-xs` → `text-compact`). `SchemaNameEditor` static line: `h-7` stays, add `text-content font-semibold text-ink`; the pencil button gets `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100` and the wrapper `group` (pencil on hover and focus). Its own test (`SchemaNameEditor.test.tsx`) clicks by name; it keeps passing.

- [ ] **Step 6: `SchemaPanel.tsx` header, line two, description, footer, empty state, menu.** In order:

1. Props: add `recordScope` and `boundaries` (interfaces above) to `SchemaPanelProps` and the destructuring. Rename the view state to `useState<'fields' | 'code'>('fields')`; every `'json'` becomes `'code'`.
2. Imports: `import { Button, EmptyState, ModalDialog, SegmentedControl } from './ui'`, `import ActionsMenu, { type ActionItem } from './ActionsMenu'`, `import { UNTITLED_SCHEMA_NAME } from './schemaNames'`, `import type { RecordScope } from 'extraction/schema'`. Drop `InstructionCount` from the `./SchemaInstructions` import and delete that component from `SchemaInstructions.tsx`.
3. Replace the header (1377-1440) with:

```tsx
      <header className="flex shrink-0 flex-col gap-1 border-b border-line px-4 pb-2 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="group min-w-0 flex-1 text-content font-semibold text-ink">
            {schemaName && ready ? (
              editorReadOnly || !onRenameSchema ? (
                <span className="block h-7 truncate leading-7">{schemaName}</span>
              ) : (
                <SchemaNameEditor name={schemaName} onSubmit={onRenameSchema} />
              )
            ) : (
              <span className="block h-7 truncate leading-7">{sourceDocumentName}</span>
            )}
          </h2>
          {ready && (
            <div className="flex shrink-0 items-center gap-2">
              <SegmentedControl
                aria-label="Schema view"
                value={view}
                onChange={setView}
                options={[{ value: 'fields', label: 'Fields' }, { value: 'code', label: 'Code' }]}
              />
              {!editorReadOnly && <ActionsMenu label="Schema actions" items={menuItems} />}
            </div>
          )}
        </div>
        {ready && (recordScope || boundaries) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-secondary text-ink-muted">
            {recordScope && (
              <span className="inline-flex items-center gap-0.5">
                <select
                  aria-label="Record scope"
                  className={`cursor-pointer appearance-none bg-transparent outline-none hover:text-ink disabled:cursor-default ${
                    recordScope.value === null ? 'font-semibold text-accent' : 'text-ink-muted'
                  }`}
                  value={recordScope.value ?? ''}
                  disabled={recordScope.disabled}
                  onChange={(event) => recordScope.onChange(event.target.value as RecordScope)}
                >
                  {recordScope.value === null && <option value="" disabled>Choose Article or Catalog</option>}
                  <option value="document">Article · one object for the document</option>
                  <option value="records">Catalog · a collection of records</option>
                </select>
                <span aria-hidden="true" className="text-ink-faint">▾</span>
              </span>
            )}
            {boundaries && (
              <label className="inline-flex items-center gap-1">
                Boundaries
                <select
                  aria-label="Boundaries"
                  className="cursor-pointer appearance-none bg-transparent text-ink outline-none disabled:cursor-default"
                  value={boundaries.value}
                  disabled={boundaries.disabled}
                  title="How catalogue entries are found: by the model, or by a numbered-catalogue recipe with source-backed evidence"
                  onChange={(event) => boundaries.onChange(event.target.value)}
                >
                  <option value="">Model discovery</option>
                  {boundaries.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
                <span aria-hidden="true" className="text-ink-faint">▾</span>
              </label>
            )}
          </div>
        )}
      </header>
```

4. `menuItems`, the dialogs and `startBlank`, placed after `deleteSchema()`:

```tsx
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const menuItems: ActionItem[] = [
    { id: 'code', label: 'Edit as code', onSelect: () => setView('code') },
    {
      id: 'history', label: 'History', onSelect: () => setHistoryOpen(true),
      disabled: snap.history.length === 0 || creatingFromHistory || snap.creatingFromRevisionId !== null || snap.previewingRevisionId !== null,
    },
    ...(showRegenerate && onGenerateInstructions
      ? [{ id: 'regenerate', label: 'Regenerate from the document…', onSelect: () => setRegenerateOpen(true), disabled: snap.generating }]
      : []),
    { id: 'clear', label: 'Clear schema', tone: 'danger' as const, divider: true, onSelect: () => setConfirmingDeleteSchema(true) },
  ]

  /** A durable schema with no fields yet: the researcher names it and describes the record (Ruling 5). */
  async function startBlank() {
    setMutationError(null)
    try {
      await schema.confirmDefinition({ recordDescription: 'Untitled record', schemaNodes: [] })
      await onRenameSchema?.(UNTITLED_SCHEMA_NAME)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'The schema could not be created.')
    }
  }
```

Render the three dialogs at the end of the component (before the drag chip), each a `ModalDialog` with `className="m-auto w-full max-w-sm rounded-card border border-line bg-surface p-4 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"`:
   - History (`historyOpen`, `ariaLabel="Schema history"`): the revision buttons of today's popover (1776-1791) in a `scrollbar-subtle max-h-80 overflow-y-auto` list; `onDismiss={() => setHistoryOpen(false)}`; `previewHistory` already closes it.
   - Regenerate (`regenerateOpen`, `ariaLabel="Regenerate from the document"`): `<SchemaInstructionsDrawer instructions={instructions} />` then a footer with `<Button onClick={() => setRegenerateOpen(false)}>Cancel</Button>` and `<Button variant="positive" onClick={() => { setRegenerateOpen(false); onGenerateInstructions?.([instructions.text, fieldDescriptionsInstruction(nodes)].filter(Boolean).join('\n\n')) }}>Regenerate schema{instructions.countLabel}</Button>`.
   - Clear (`confirmingDeleteSchema`, `ariaLabel="Clear current schema"`): the copy of 1415-1418, then `<Button onClick={() => setConfirmingDeleteSchema(false)}>Cancel</Button>` and `<Button variant="danger" onClick={() => { setConfirmingDeleteSchema(false); void deleteSchema() }}>Clear schema</Button>`.
   Remove the old popovers and their buttons from the chat header (1724-1794): the chat header keeps only its "Chat" label until Task 7 removes it. Remove `instructions.open`/`toggle` uses (the hook keeps them).
5. Empty state (1511-1518):

```tsx
        {snap.view === 'empty' && (
          <EmptyState title="No schema yet" description="Generate it from the document, import a codebook, or start blank.">
            {onGenerateInstructions && (
              <Button variant="positive" onClick={() => onGenerateInstructions(instructions.text)}>Generate from the document</Button>
            )}
            <Button onClick={() => void startBlank()}>Start blank</Button>
          </EmptyState>
        )}
```
   (Task 9 adds "Import from Excel codebook…" between them.) `mutationError` already renders as `role="alert"` under the fields view; render it under the empty state too.
6. Record description (1612-1633):

```tsx
            <label className="mb-3 block">
              <span className="text-compact font-semibold text-ink-muted">What one record is</span>
              {editorReadOnly ? (
                <p className="mt-1 text-secondary leading-relaxed text-ink-muted">{recordDescriptionDraft}</p>
              ) : (
                <textarea
                  className="mt-1 block w-full resize-none rounded-[3px] border border-line bg-transparent px-2 py-1 text-secondary leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-line-strong"
                  rows={Math.min(6, Math.max(2, recordDescriptionDraft.split('\n').length))}
                  value={recordDescriptionDraft}
                  placeholder="Describe the record this schema extracts…"
                  onChange={(event) => setRecordDescriptionDraft(event.target.value)}
                  onBlur={commitRecordDescription}
                />
              )}
            </label>
```
7. Footer (1861-1873):

```tsx
      <footer className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-line px-4 py-2 text-compact text-ink-faint">
        {snap.view === 'generating' && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-stale" />
            Producing schema from the document…
          </span>
        )}
        {snap.view === 'empty' && 'Generate, import or start blank to create the schema'}
        {snap.view === 'failed' && 'Generation failed'}
        {ready && <SchemaSaveStatus save={snap.save} showSaved onRetry={() => void schema.flush().catch(() => undefined)} />}
      </footer>
```
   Delete `displayedFieldCount` and the `countTemplateFields`/`nodesToTemplate` imports if nothing else uses them.
8. `SchemaImport`: add `onConfirmed?: () => void`, called after `await schema.confirmDefinition(definition); close()`. `SchemaPanel` passes `onConfirmed={() => { if (!schemaName) void onRenameSchema?.(defaultSchemaName(sourceDocumentName)) }}` (import `defaultSchemaName`).

- [ ] **Step 7: `RightRail.tsx`**: add `recordScope?: SchemaPanelProps['recordScope']` and `boundaries?: SchemaPanelProps['boundaries']` to `RightRailProps` (export `SchemaPanelProps` from `SchemaPanel.tsx`), pass both to `<SchemaPanel>`.

- [ ] **Step 8: `App.tsx`.** Pass `recordScope={{ value: schemaSnap.recordScope, onChange: (scope) => schema.setRecordScope(scope), disabled: running || savingForRun }}` and `boundaries={!running && nextExtractionStrategy === 'CATALOG' && !(saved.state.status === 'ready' && saved.state.unifiedCatalog) ? { value: nextCatalogRecipe, options: CATALOG_RECIPES, onChange: setNextCatalogRecipe, disabled: savingForRun } : null}` to `<RightRail>` (the toolbar's own selects stay until Task 4 removes them). Replace lines 497-500 with the default-name rename:

```ts
    // The first successful generation initializes the Extraction Schema; it is named after its Source Document (§5).
    if (!hadSchema) {
      const extractionSchemaId = schema.snapshot().extractionSchemaId
      if (extractionSchemaId) {
        const name = defaultSchemaName(filename)
        setSchemaName(name)
        renameExtractionSchema(projectContextId, extractionSchemaId, name)
          .then((renamed) => setSchemaName(renamed.name))
          .catch(() => setSchemaName('Extraction Schema'))
      }
    }
```
   In `onRenameSchema` (1065) read `const extractionSchemaId = schema.snapshot().extractionSchemaId` (the live controller, not the render-time snapshot: an import or Start blank renames right after initialising).

- [ ] **Step 9: Update the existing tests.** `SchemaPanel.test.tsx`: history cases (245-275, 381-446) open the menu then the "History" item and read the dialog (`getByRole('dialog', { name: 'Schema history' })`); the read-only preview asserts `queryByRole('button', { name: 'Schema actions' })` is absent instead of `Regenerate`; 279-307 open the menu and expect the "Regenerate from the document…" menuitem disabled/enabled; 325-335 go menu → dialog → placeholder → "Regenerate schema"; 344-346 and 837 click `{ name: 'Code' }`; any `getByLabelText('Record description')` → `'What one record is'`. `App.test.tsx`: 730 ("persists a generated first schema…") stubs `PATCH /api/extraction-schemas/<id>` to echo `{ extractionSchema: { extractionSchemaId, name } }` and expects the name `Beretning` in the heading; 995 ("flushes edits before clearing, then regenerates…") goes through the menu for both Clear schema and Regenerate. `projectContexts/BatchExtractionsPanel.test.tsx`: any `Schema history`/`Regenerate` button lookups follow the menu. e2e `interactive-reload.spec.ts:28-34` and `interactive-restart.spec.ts:29-33`: `page.getByRole('button', { name: 'Schema actions' }).click()`, `page.getByRole('menuitem', { name: 'Regenerate from the document…' }).click()`, the same placeholder inside `page.getByRole('dialog', { name: 'Regenerate from the document' })`, then "Regenerate schema"; `interactive-reload.spec.ts:46, 96` `getByLabel('What one record is')`.

- [ ] **Step 10: Verify** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/schemaNames.test.ts src/SchemaPanel.test.tsx src/App.test.tsx src/RightRail.test.tsx src/SchemaImport.test.tsx src/projectContexts/BatchExtractionsPanel.test.tsx` → pass.

- [ ] **Step 11: Commit** — `feat(studio): schema header with record scope, actions menu, saved-revision footer and default schema names`.

---

### Task 4: Frame, tab strip, the run action and the document toolbar (§1, §2, §3 without thumbnails, §4 badge, §11)

**Files:**
- Create: `prototypes/studio/src/FreeMonogram.tsx`, `prototypes/studio/src/resultsBadge.ts`, `prototypes/studio/src/resultsBadge.test.ts`, `prototypes/studio/src/DocumentTabBar.test.tsx`, `prototypes/studio/src/PagePager.tsx`
- Modify: `prototypes/studio/src/AppFrame.tsx:426-453, 510-540`, `prototypes/studio/src/DocumentTabBar.tsx`, `prototypes/studio/src/App.tsx` (the portal slot 820-978, `runExtraction` 691-752, `runExtractionUnavailable`/`runLabel`/`hintText` 759-805, the work surface 979-1021, the `RightRail` props), `prototypes/studio/src/RightRail.tsx` (badge; `resultsHeaderExtras`), `prototypes/studio/src/ResultsTab.tsx:734-739` (`headerExtras`), `prototypes/studio/src/useExtraction.ts:60-61, 99, 463-469`, `prototypes/studio/src/SavedMethodSummary.tsx` (toolbar variant removed), `prototypes/studio/src/projectContexts/BatchExtractionsPanel.tsx:1077, 1336` (drop `variant`)
- Test: `prototypes/studio/src/App.test.tsx`, `prototypes/studio/src/useExtraction.test.tsx`, `prototypes/studio/src/SavedMethodSummary.test.tsx`, `prototypes/studio/src/RightRail.test.tsx`, `prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts`, `prototypes/studio/e2e/real-application-route.spec.ts`

**Interfaces:**
- Consumes: `Button variant="positive"` (Task 1), `useToast`/`Toast` (Task 2), `RightRailProps.recordScope`/`boundaries` (Task 3).
- Produces: `resultsBadgeFor(controller): { label: string; done?: boolean } | null` (`src/resultsBadge.ts`), used by `RightRail` and the run button; `RightRailProps.resultsHeaderExtras?: ReactNode` → `ResultsTabProps.headerExtras?: ReactNode`; `useExtraction` option `onMethodChanged?: (message: string, code: string) => void` and the export `METHOD_CHANGED`; `DocumentTabBarProps` loses `documentName`; the toolbar's controls: `button[aria-expanded]` named "Pages", `input[aria-label="Current page"]`, buttons "Previous page"/"Next page", the text `/ <pageCount>`, the zoom group `role="group"[aria-label="PDF zoom"]` as today; the run button reads "▶ Run extraction" / "■ Stop extraction" / "Cancellation requested…"; completion toasts read "✓ Extraction complete — review it in the Results tab" and "↻ Re-run complete — review it in the Results tab".

- [ ] **Step 1: Write the failing tests.** `src/resultsBadge.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { resultsBadgeFor } from './resultsBadge'
import type { ExtractionController } from './useExtraction'

const review = (untouchedCount: number, reviewedExtractionId: string | null = null) =>
  ({ untouchedCount, reviewedExtractionId }) as unknown as ExtractionController['review']
const attempt = (executionStatus: 'RUNNING' | 'COMPLETED', reviewedAt: string | null = null) =>
  ({ executionStatus, reviewedAt }) as unknown as ExtractionController['attempt']

describe('resultsBadgeFor', () => {
  it('says running during a run', () => {
    expect(resultsBadgeFor({ attempt: attempt('RUNNING'), hasResults: false, review: review(0) })).toEqual({ label: 'running' })
  })
  it('counts the required decisions left to check', () => {
    expect(resultsBadgeFor({ attempt: attempt('COMPLETED'), hasResults: true, review: review(3) })).toEqual({ label: '3 to check' })
  })
  it('shows nothing once reviewed or without a result', () => {
    expect(resultsBadgeFor({ attempt: attempt('COMPLETED', '2026-10-03T00:00:00Z'), hasResults: true, review: review(0) })).toBeNull()
    expect(resultsBadgeFor({ attempt: attempt('COMPLETED'), hasResults: true, review: review(0, 'x') })).toBeNull()
    expect(resultsBadgeFor({ attempt: null, hasResults: false, review: review(0) })).toBeNull()
  })
})
```

`src/DocumentTabBar.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DocumentTabBar from './DocumentTabBar'

afterEach(cleanup)
const tabs = [{ sourceDocumentId: 'doc-1', name: 'Beretning.pdf' }]

it('shows the project as a chip that opens its Sources tab, and no breadcrumb row', () => {
  const onNavigateProject = vi.fn()
  render(<DocumentTabBar projectName="Ellekilde" tabs={tabs} activeSourceDocumentId="doc-1" onActivate={vi.fn()} onClose={vi.fn()}
    onNavigateProject={onNavigateProject} slotRef={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open project Ellekilde' }))
  expect(onNavigateProject).toHaveBeenCalledOnce()
  expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Project actions' })).not.toBeInTheDocument()
})

it('offers Back to review grid in the chip menu when the document came from a review grid', () => {
  const onBackToReviewGrid = vi.fn()
  render(<DocumentTabBar projectName="Ellekilde" tabs={tabs} activeSourceDocumentId="doc-1" onActivate={vi.fn()} onClose={vi.fn()}
    onNavigateProject={vi.fn()} onBackToReviewGrid={onBackToReviewGrid} slotRef={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Project actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Back to review grid' }))
  expect(onBackToReviewGrid).toHaveBeenCalledOnce()
})
```

Add to `App.test.tsx` (inside `describe('reopened Source Document workspace')`, reusing its fetch stubs and `appendRevision`):

```tsx
  it('a run re-reads the saved method before posting and labels itself Stop while running', async () => {
    const extractionResponse = Promise.withResolvers<Response>()
    const order: string[] = []
    saved.refresh.mockImplementation(async () => { order.push('refresh'); return saved.state.status === 'ready' ? saved.state : null })
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      if (url.endsWith('/api/extractions')) { order.push('post'); return extractionResponse.promise }
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    await waitFor(() => expect(order).toEqual(['refresh', 'post']))
    extractionResponse.resolve(Response.json({ ...runningAttempt('51000000-0000-4000-8006-000000000031') }, { status: 201 }))
    expect(await screen.findByRole('button', { name: /■ Stop extraction/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /■ Stop extraction/ })).toHaveTextContent('running')
  })

  it('a method_changed refusal is retried once with a fresh read, a second one ends with a toast', async () => {
    const posts: unknown[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/source')) return Promise.resolve(Response.json(parsedDocument))
      if (url.endsWith('/markdown')) return Promise.resolve(new Response('# Beretning'))
      if (url.startsWith('/api/schema-revisions?')) return Promise.resolve(Response.json({ revisions: [] }))
      if (url.endsWith('/api/extractions')) {
        posts.push(JSON.parse(String(init?.body)))
        return Promise.resolve(Response.json({ error: { code: 'method_changed', message: 'Stale.' } }, { status: 409 }))
      }
      return Promise.resolve(new Response('pdf'))
    }))
    render(<DocumentWorkspace {...reopened} persistedExtraction={null} />)
    await waitFor(() => expect(screen.queryByText('Indexing document…')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '▶ Run extraction' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(saved.refresh).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Your saved settings changed. Run again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeEnabled()
  })

  it('without a saved record scope the run is disabled and points at the schema header', async () => {
    await renderReopened({ persistedExtraction: null, extractionSchema: { ...reopened.extractionSchema!, recordScope: null } })
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '▶ Run extraction' })).toHaveAttribute('title', 'Choose Article or Catalog in the schema header')
    expect(screen.queryByText(/Press Run extraction/)).not.toBeInTheDocument()
  })

  it('the toolbar pager navigates on Enter and ignores an invalid page', async () => {
    await renderReopened()
    expect(screen.getByText('/ 3')).toBeInTheDocument()
    const input = screen.getByLabelText('Current page')
    fireEvent.change(input, { target: { value: '3' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Go to page 3' })).toHaveAttribute('aria-current', 'page')
    fireEvent.change(screen.getByLabelText('Current page'), { target: { value: '999' } })
    fireEvent.blur(screen.getByLabelText('Current page'))
    expect(screen.getByLabelText('Current page')).toHaveValue('3')
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(screen.getByRole('button', { name: 'Go to page 2' })).toHaveAttribute('aria-current', 'page')
  })
```

(`runningAttempt(id)` is a small local helper returning the RUNNING attempt literal used at 1283-1291 with that id; add it near `appendRevision`. `renderReopened` takes an optional props override — extend it if it does not.) Update `saved.refresh` in the hoisted mock to `vi.fn(async () => saved.state.status === 'ready' ? saved.state : null)` and reset it in `afterEach`.

- [ ] **Step 2: Run them to verify they fail** — `pnpm -C prototypes/studio exec vitest run src/resultsBadge.test.ts src/DocumentTabBar.test.tsx src/App.test.tsx` → FAIL.

- [ ] **Step 3: `src/resultsBadge.ts`**

```ts
import type { ExtractionController } from './useExtraction'

export type ResultsBadge = { label: string; done?: boolean }

/** The Results tab's badge and the run button's progress word: "running" during a run, "n to check" while required
 *  decisions remain, nothing once the review is saved or no result exists. The streaming spec adds "k of n". */
export function resultsBadgeFor(
  controller: Pick<ExtractionController, 'attempt' | 'hasResults' | 'review'>,
): ResultsBadge | null {
  const attempt = controller.attempt
  if (attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING') return { label: 'running' }
  if (!controller.hasResults || attempt?.reviewedAt || controller.review.reviewedExtractionId) return null
  const remaining = controller.review.untouchedCount
  return remaining > 0 ? { label: `${remaining} to check` } : null
}
```

`RightRail.tsx:114`: `const resultsBadge = resultsBadgeFor(extraction)`; `TabBadge`'s `text-[10px]` → `text-overline`.

- [ ] **Step 4: `src/FreeMonogram.tsx`** (Ruling 8) and `AppFrame.tsx`

```tsx
/** The FREE mark reduced to a 24px monogram for the collapsed project rail; the full logo shows when the rail is open. */
export default function FreeMonogram({ size = 24 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      <rect width="24" height="24" rx="5" fill="var(--color-accent)" />
      <text x="12" y="17" textAnchor="middle" fontFamily="Albert Sans, system-ui, sans-serif" fontWeight="800" fontSize="14" fill="#fff">F</text>
    </svg>
  )
}
```

In `AppFrame.tsx` the `<a aria-label="Studio home">` renders `{effectiveNavOpen ? <img …free-logo.png… /> : <FreeMonogram />}`; the header keeps `h-14`. Delete the commented-out `<h1>` (455-458). Remove `activeDocumentName` (338-345) and the `documentName` prop from `<DocumentTabBar>`.

- [ ] **Step 5: `DocumentTabBar.tsx`**: drop `documentName`; one row; delete the breadcrumb `<nav>` (99-134); render the project chip before the tablist:

```tsx
function ProjectChip({ name, onNavigateProject, onBackToReviewGrid }: {
  name: string
  onNavigateProject: () => void
  onBackToReviewGrid?: () => void
}) {
  return (
    <div className="flex shrink-0 items-center self-center">
      <button
        type="button"
        className="flex h-7 max-w-48 cursor-pointer items-center rounded-l-[3px] border border-line bg-surface px-2 text-compact font-semibold text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent"
        aria-label={`Open project ${name}`}
        onClick={onNavigateProject}
      >
        <span className="truncate">{name}</span>
      </button>
      {onBackToReviewGrid ? (
        <ActionsMenu
          label="Project actions"
          trigger={<span aria-hidden="true">▾</span>}
          triggerClassName="rounded-l-none border-l-0"
          items={[{ id: 'grid', label: 'Back to review grid', onSelect: onBackToReviewGrid }]}
        />
      ) : (
        <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-r-[3px] border border-l-0 border-line text-ink-faint">▾</span>
      )}
    </div>
  )
}
```

Row: `<div className="flex h-14 shrink-0 items-end gap-2 border-b border-line bg-surface pl-2">{navigationToggle}<ProjectChip … />{tablist as today}<div ref={slotRef} className="flex shrink-0 items-center gap-3 self-center px-3" /></div>`; the narrow-viewport wrapping classes stay as today. Import `ActionsMenu` from `./ActionsMenu` (the `rounded-l-none border-l-0` trigger classes join the menu's own; `ActionsMenu` appends `triggerClassName` last).

- [ ] **Step 6: `useExtraction.ts`**: export `METHOD_CHANGED`; the option becomes `onMethodChanged?: (message: string, code: string) => void` and line 467 passes `onMethodChanged?.(error.message, error.code!)`. Fix `useExtraction.test.tsx` expectations that assert the single-argument call (`toHaveBeenCalledWith('Stale.')` → `toHaveBeenCalledWith('Stale.', 'method_changed')`).

- [ ] **Step 7: `src/PagePager.tsx`**

```tsx
import { useState } from 'react'

/** "◀ 6 / 7 ▶": the number is an input; Enter or blur navigates when it names a page, otherwise it resets. Mount it with
 *  `key={page}` so the draft follows the viewer. */
export default function PagePager({ page, pageCount, onNavigate }: { page: number; pageCount: number; onNavigate: (page: number) => void }) {
  const [draft, setDraft] = useState(String(page))
  const commit = () => {
    const next = Number.parseInt(draft, 10)
    if (Number.isInteger(next) && next >= 1 && next <= pageCount && next !== page) onNavigate(next)
    else setDraft(String(page))
  }
  const step = 'grid size-6 cursor-pointer place-items-center rounded-[3px] text-ink-muted outline-none transition-colors hover:bg-surface-muted hover:text-ink disabled:cursor-default disabled:opacity-40'
  return (
    <div className="flex items-center gap-1 text-compact text-ink-muted" role="group" aria-label="Page">
      <button type="button" className={step} aria-label="Previous page" disabled={page <= 1} onClick={() => onNavigate(page - 1)}>◀</button>
      <input
        aria-label="Current page"
        inputMode="numeric"
        className="w-9 rounded-[3px] border border-line bg-surface px-1 py-0.5 text-center tabular-nums text-ink outline-none focus:border-line-strong"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
      <span className="tabular-nums">/ {pageCount}</span>
      <button type="button" className={step} aria-label="Next page" disabled={page >= pageCount} onClick={() => onNavigate(page + 1)}>▶</button>
    </div>
  )
}
```

- [ ] **Step 8: `App.tsx`.**

1. Imports: drop `SavedMethodSummary`; add `PagePager`, `resultsBadgeFor`, `METHOD_CHANGED` (from `./useExtraction`). Delete `statusStyles` (547-551), `methodConflict` (563), `hintText`/`strategyHelp`/`strategyUnchosen` (790-805), `runLabel` (770-776). Add `const refusalRef = useRef<{ message: string; code: string } | null>(null)` and pass `onMethodChanged: (message, code) => { refusalRef.current = { message, code } }` to `useExtraction`.
2. `runExtractionUnavailable` drops `saved.state.status !== 'ready'` (the click reads it). `const badge = resultsBadgeFor(extraction)`; `const runLabel = running ? (extraction.cancellationRequested ? 'Cancellation requested…' : '■ Stop extraction') : '▶ Run extraction'`.
3. Replace `runExtraction` (691-752) with:

```ts
  /** Saves pending schema edits as the Current Schema Revision, reads the account's saved method again, then admits the
   *  run over the whole document: what admission pins is what was saved at the click (§2). A `method_changed` refusal
   *  re-reads once and retries; a second refusal starts nothing. A failed admission leaves the revision saved. */
  async function runExtraction() {
    if (savingForRun || running || !sourceRepresentationCurrent) return
    setSavingForRun(true)
    const targetSourceRepresentationId = sourceRepresentationId
    const stillHere = () => activeSourceRepresentationIdRef.current === targetSourceRepresentationId
    try {
      const revision = await schema.flush()
      if (!stillHere()) return
      if (!revision) throw new Error('Save the Current Schema Revision before extraction.')
      if (revision.recordScope === null) throw new Error('Choose Article or Catalog in the schema header before extraction.')
      const strategy = strategyOf(revision.recordScope)
      setSelectedInspectionId(null)
      setKnownSchemas((known) => ({
        ...known,
        [revision.schemaRevisionId]: {
          schemaRevisionId: revision.schemaRevisionId,
          revisionNumber: revision.revisionNumber,
          recordDescription: revision.recordDescription,
          schemaNodes: revision.schemaNodes,
        },
      }))
      const target = { sourceRepresentationId: targetSourceRepresentationId, schemaRevisionId: revision.schemaRevisionId }
      for (let round = 0; round < 2; round += 1) {
        const savedState = await saved.refresh()
        if (!stillHere()) return
        if (!savedState) throw new Error('Saved advanced settings could not be read. Nothing was started.')
        // The unified Catalog has no recipe: one Catalog method for every new Catalog Extraction.
        const catalogRecipe = savedState.unifiedCatalog ? null : nextCatalogRecipe || null
        refusalRef.current = null
        const acknowledged = await extraction.runExtraction(savedMethodFor(savedState, strategy, catalogRecipe), target, strategy, catalogRecipe)
        if (!stillHere()) return
        if (acknowledged) {
          selectNextRunAfter(acknowledged)
          if (acknowledged.executionStatus === 'COMPLETED' || acknowledged.executionStatus === 'FAILED') {
            if (acknowledged.outcome === 'SUCCEEDED')
              setFinishedExtractionReport({ attempt: acknowledged, schemaNodes: revision.schemaNodes })
          } else pendingReportRef.current = { extractionId: acknowledged.extractionId, schemaNodes: revision.schemaNodes }
          return
        }
        const refusal = refusalRef.current
        if (refusal?.code !== METHOD_CHANGED) {
          // A superseded source or a definite rejection already spoke through its own callback; the other refusals
          // (migration, record scope) are told here, now that the saved-method summary is gone.
          if (refusal) showToast(refusal.message, { durationMs: 6000 })
          return
        }
        if (round === 1) showToast('Your saved settings changed. Run again.', { durationMs: 6000 })
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Save the Current Schema Revision before extraction.')
    } finally {
      setSavingForRun(false)
    }
  }
```
4. Completion toasts (599-600): `'↻ Re-run complete — review it in the Results tab'` and `'✓ Extraction complete — review it in the Results tab'`.
5. The portal slot (820-978) becomes:

```tsx
      {tabBarSlot && createPortal(
        <>
          {/* A scope choice saves at once; field edits wait out the debounce. Run waits for either, and a failed save
              blocks it until Retry saves the latest draft and scope. Saved, this renders nothing (the panel footer says so). */}
          <SchemaSaveStatus save={schemaSnap.save} onRetry={retrySchemaSave} className="max-w-72" />
          <Button
            variant="positive"
            size="md"
            disabled={running ? extraction.cancellationRequested : runExtractionUnavailable}
            title={
              running
                ? extraction.cancellationRequested ? 'Waiting for the Extraction to stop' : 'Cancel the active Extraction'
                : !sourceRepresentationCurrent
                  ? 'This view shows an Extraction on an earlier Source Representation. Go back to the current one to run a new Extraction.'
                  : schemaSnap.save?.status === 'error'
                    ? 'The schema is not saved. Retry the save first.'
                    : schemaSnap.save?.status === 'conflict'
                      ? 'The schema changed elsewhere. Reload it in the Schema tab first.'
                      : indexing
                        ? 'The document is still being indexed'
                        : !schemaReady
                          ? 'Generate a schema in the Schema tab first'
                          : nextExtractionStrategy === null
                            ? 'Choose Article or Catalog in the schema header'
                            : nextExtractionStrategy === 'CATALOG'
                              ? 'Find catalogue entries and extract one record per entry'
                              : 'Run one values extraction across the whole Source Document'
            }
            onClick={() => (running ? void extraction.requestCancellation() : void runExtraction())}
          >
            {runLabel}
            {running && badge && <span className="font-medium opacity-80"> · {badge.label}</span>}
          </Button>
        </>,
        tabBarSlot,
      )}
```
6. Work surface and toolbar (979-1021): the outer `div` loses `p-1 sm:p-3`; the inner loses `rounded-lg border border-line sm:rounded-2xl` (keep `relative flex h-full min-h-0 overflow-hidden`). The toolbar replaces 983-991:

```tsx
            <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
              <Button ref={pagesToggleRef} aria-expanded={pagesOpen} aria-controls={pageNavigationId}
                disabled={loadState.status !== 'ready'} onClick={() => setPagesOpen((open) => !open)}>
                <span aria-hidden="true">☰</span> Pages
              </Button>
              {loadState.status === 'ready' ? (
                <PagePager key={currentPage} page={currentPage} pageCount={loadState.pageCount}
                  onNavigate={(page) => { if (pdfViewerRef.current) pdfViewerRef.current.currentPageNumber = page }} />
              ) : (
                <p role="status" aria-live="polite" className={`text-compact font-medium ${loadState.status === 'error' ? 'text-danger' : 'text-ink-muted'}`}>
                  {loadState.status === 'loading' ? 'Loading PDF…' : loadState.message}
                </p>
              )}
              {loadState.status === 'ready' && (
                <div className="flex shrink-0 items-center rounded-full border border-line bg-surface-muted p-0.5" role="group" aria-label="PDF zoom">
                  …the three zoom buttons exactly as at 858-889, `text-xs` → `text-compact`…
                </div>
              )}
            </div>
```
   The `PageNavigation` keeps rendering `pagesOpen && loadState.status === 'ready'` (Task 5 replaces its body). Delete the hint pill block (1016-1021).
7. `<RightRail>` gains `resultsHeaderExtras`:

```tsx
              resultsHeaderExtras={
                <>
                  {indexing && <span className="text-compact font-medium text-ink-muted">Indexing document…</span>}
                  {docIndex.status === 'error' && (
                    <span className="text-compact font-medium text-danger" title={docIndex.message}>Indexing failed</span>
                  )}
                  {inspectionChoices.length > 1 && (
                    <select aria-label="Extraction snapshot" value={inspectedAttempt?.extractionId ?? ''}
                      onChange={(event) => setSelectedInspectionId(event.target.value)}
                      className="rounded-[3px] border border-line bg-surface px-2 py-1 text-compact">
                      {inspectionChoices.map((choice) => <option key={choice.extractionId} value={choice.extractionId}>{choice.label}</option>)}
                    </select>
                  )}
                  {reviewedOnAnotherSource && latestReviewedExtraction && (
                    <Button variant="secondary" onClick={() => onOpenExtraction(latestReviewedExtraction.extractionId)}>Open latest reviewed</Button>
                  )}
                </>
              }
```
   `RightRail` passes it as `headerExtras` to `ResultsTab`, whose header (736-739) becomes `<div className="flex items-center justify-between gap-2 px-4 py-2.5"><Overline as="h2">Extraction results</Overline><div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{headerExtras}{attempt && <AttemptDetails attempt={attempt} />}</div></div>`.
8. The `boundaries` prop must not flicker: `saved.refresh()` puts `saved.state` through `loading` on every run click, so compute it from the last ready state, not the live one — `const unifiedCatalogRef = useRef(false)`, set `unifiedCatalogRef.current = saved.state.unifiedCatalog === true` whenever `saved.state.status === 'ready'`, and pass `boundaries={!running && nextExtractionStrategy === 'CATALOG' && !unifiedCatalogRef.current ? {…} : null}`. The record-scope and boundaries props to `RightRail` were added in Task 3; remove the toolbar's own `<label>Strategy…</label>` and `<label>Boundaries…</label>` and the `SavedMethodSummary` block with the rest of the slot.

- [ ] **Step 9: `SavedMethodSummary.tsx`**: remove the `variant` prop and the `toolbar` branches (the `details` is `text-secondary`, the body `mt-1 rounded-md border border-line bg-surface p-3`); `BatchExtractionsPanel.tsx:1077, 1336` drop `variant="panel"`; `SavedMethodSummary.test.tsx` second case renders without `variant`.

- [ ] **Step 10: Update tests and e2e.** `App.test.tsx`: 469 `findByText('3 pages')` → `findByText('/ 3')`; 1223 and 2475 → the new toast copy; 1346-1406 `getByLabelText('Extraction strategy')` → `getByLabelText('Record scope')`, `'Record boundaries'` → `'Boundaries'`; 1408-1437 delete the `Saved advanced settings` click and the `Unified Catalog, defaults version 1` assertion, expect `extractionRequests` to have length 2 (the retry) each matching the unified method, and the toast "Your saved settings changed. Run again."; 2061 delete the `Saved advanced settings` assertion; 2712 delete the hint assertion; 2816 click the Results tab before looking for "Open latest reviewed"; any `getByText('Indexing document…')` waits keep working (the text now lives in the Results header, still in the document). `RightRail.test.tsx`: `defaultController` is unchanged; a case asserting the `✓` badge, if any, asserts "n to check". `e2e/canonical-evidence-lifecycle.spec.ts`: 268 and 939 `'6 pages'` → `page.getByText('/ 6', { exact: true })`; 278, 318, 672, 688, 694, 729, 813 `combobox 'Extraction strategy'` → `combobox 'Record scope'`; 280 and 323: replace the `'↻ Re-run extraction'` visibility wait with `await expect(page.getByRole('dialog', { name: 'Extraction finished', exact: true })).toBeVisible({ timeout: 20_000 })` followed by `await page.getByRole('button', { name: 'Dismiss', exact: true }).click()` at 280 only (329-331 already assert and use that dialog for the second document — keep those); 673, 730 `'↻ Re-run extraction'` → `'▶ Run extraction'`; 814, 835 → `{ name: '▶ Run extraction' }`; delete 379-384 (the saved-settings summary no longer exists; keep the review-progress, approve-remaining and scroll-width checks); 642-645: insert `await freshPage.getByRole('tab', { name: /Results/ }).click()` before the "Open latest reviewed" click. `e2e/real-application-route.spec.ts`: 216, 227, 332 `'Extraction strategy'` → `'Record scope'`.

- [ ] **Step 11: Verify** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/resultsBadge.test.ts src/DocumentTabBar.test.tsx src/App.test.tsx src/useExtraction.test.tsx src/SavedMethodSummary.test.tsx src/RightRail.test.tsx src/ProjectNavigation.test.tsx src/projectContexts` → pass. `grep -n "hintText\|SavedMethodSummary\|Extraction strategy\|Breadcrumb" prototypes/studio/src/App.tsx prototypes/studio/src/DocumentTabBar.tsx` → nothing.

- [ ] **Step 12: Commit** — `feat(studio): one tab-strip row with a project chip and a green Run; document toolbar and edge-to-edge surface`.

---

### Task 5: The thumbnail page rail (§3)

**Files:**
- Create: `prototypes/studio/src/PageThumbnails.ts`, `prototypes/studio/src/PageThumbnails.test.ts`, `prototypes/studio/src/PageNavigation.test.tsx`
- Modify: `prototypes/studio/src/PageNavigation.tsx`, `prototypes/studio/src/App.tsx` (the PDF effect 352-405 keeps the loaded `PDFDocumentProxy`; the `PageNavigation` call 993-996)
- Test: `prototypes/studio/src/App.test.tsx` (the keyboard case at 1321 keeps passing)

**Interfaces:**
- Consumes: the viewer's `pdfjsLib.PDFDocumentProxy` (`getPage(n)` → `getViewport({ scale })`, `render({ canvasContext, viewport }).promise`).
- Produces: `createThumbnailRenderer(pdf, paint?) : ThumbnailRenderer` with `ThumbnailRenderer = { render(page: number): Promise<ImageBitmap | null>; dispose(): void }` and `THUMBNAIL_SCALE = 0.12`; `PageNavigation` gains the prop `thumbnails: ThumbnailRenderer | null`; each page card is `button[aria-label="Go to page n"]` holding `canvas[data-thumbnail="pending" | "drawn" | "unavailable"]` and the page number.

- [ ] **Step 1: Write the failing tests.** `src/PageThumbnails.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createThumbnailRenderer } from './PageThumbnails'

const bitmap = () => ({ close: vi.fn() }) as unknown as ImageBitmap
const pdf = { getPage: vi.fn() } as never

describe('createThumbnailRenderer', () => {
  it('paints each page once and hands out the same bitmap again', async () => {
    const paint = vi.fn(async (_pdf: unknown, page: number) => (page === 2 ? null : bitmap()))
    const renderer = createThumbnailRenderer(pdf, paint)
    const [first, again, missing] = await Promise.all([renderer.render(1), renderer.render(1), renderer.render(2)])
    expect(first).toBe(again)
    expect(missing).toBeNull()
    expect(paint).toHaveBeenCalledTimes(2)
  })

  it('a failing paint is a blank thumbnail, never an error', async () => {
    const renderer = createThumbnailRenderer(pdf, vi.fn(async () => { throw new Error('no page') }))
    await expect(renderer.render(1)).resolves.toBeNull()
  })

  it('dispose closes every bitmap and forgets the cache', async () => {
    const first = bitmap()
    const paint = vi.fn(async () => first)
    const renderer = createThumbnailRenderer(pdf, paint)
    await renderer.render(1)
    renderer.dispose()
    await Promise.resolve()
    expect(first.close).toHaveBeenCalledOnce()
    await renderer.render(1)
    expect(paint).toHaveBeenCalledTimes(2)
  })
})
```

`src/PageNavigation.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PageNavigation } from './PageNavigation'
import type { ThumbnailRenderer } from './PageThumbnails'

HTMLElement.prototype.scrollIntoView = vi.fn()
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const rail = (thumbnails: ThumbnailRenderer | null, currentPage = 2) => {
  const onNavigate = vi.fn()
  render(<PageNavigation id="pages" pageCount={3} currentPage={currentPage} onNavigate={onNavigate} onClose={vi.fn()} thumbnails={thumbnails} />)
  return onNavigate
}

it('renders one thumbnail card per page, numbered, and rings the current page', () => {
  rail(null)
  const buttons = screen.getAllByRole('button', { name: /^Go to page \d$/ })
  expect(buttons).toHaveLength(3)
  expect(buttons[1]).toHaveAttribute('aria-current', 'page')
  expect(buttons[1]!.className).toMatch(/ring-ink/)
  expect(buttons[0]!.className).not.toMatch(/ring-ink/)
  expect(buttons.map((button) => button.textContent)).toEqual(['1', '2', '3'])
  expect(buttons[0]!.querySelector('canvas')).toHaveAttribute('data-thumbnail', 'pending')
})

it('draws each bitmap once it arrives and marks a missing one unavailable', async () => {
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  const render = vi.fn(async (page: number) => (page === 3 ? null : ({} as ImageBitmap)))
  rail({ render, dispose: vi.fn() })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Go to page 1' }).querySelector('canvas')).toHaveAttribute('data-thumbnail', 'drawn'))
  expect(screen.getByRole('button', { name: 'Go to page 3' }).querySelector('canvas')).toHaveAttribute('data-thumbnail', 'unavailable')
  expect(drawImage).toHaveBeenCalledTimes(2)
  expect(render).toHaveBeenCalledTimes(3)
})

it('keeps the keyboard model: arrows, Home and End move and navigate, Escape closes', () => {
  const onNavigate = rail(null, 1)
  const first = screen.getByRole('button', { name: 'Go to page 1' })
  first.focus()
  fireEvent.keyDown(first, { key: 'End' })
  expect(onNavigate).toHaveBeenLastCalledWith(3)
  fireEvent.keyDown(screen.getByRole('button', { name: 'Go to page 3' }), { key: 'ArrowUp' })
  expect(onNavigate).toHaveBeenLastCalledWith(2)
})
```

- [ ] **Step 2: Run them to verify they fail** — `pnpm -C prototypes/studio exec vitest run src/PageThumbnails.test.ts src/PageNavigation.test.tsx` → FAIL.

- [ ] **Step 3: Create `src/PageThumbnails.ts`**

```ts
import type { PDFDocumentProxy } from 'pdfjs-dist'

/** The rail's cards are 46×58; a letter page at 0.12 is 73×95, downscaled on draw. */
export const THUMBNAIL_SCALE = 0.12

export type ThumbnailRenderer = {
  /** Resolves the page's bitmap, or null when it could not be rendered (the card then shows its number only). */
  render(page: number): Promise<ImageBitmap | null>
  /** Drops the cached bitmaps; called when the document closes. */
  dispose(): void
}

type ThumbnailSource = Pick<PDFDocumentProxy, 'getPage'>

async function paintPage(pdf: ThumbnailSource, pageNumber: number): Promise<ImageBitmap | null> {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale: THUMBNAIL_SCALE })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d')
  if (!context) return null
  await page.render({ canvasContext: context, viewport }).promise
  return typeof createImageBitmap === 'function' ? createImageBitmap(canvas) : null
}

/** Renders the pages of one document at THUMBNAIL_SCALE, once each, from the viewer's own `PDFDocumentProxy`. */
export function createThumbnailRenderer(
  pdf: ThumbnailSource,
  paint: (pdf: ThumbnailSource, page: number) => Promise<ImageBitmap | null> = paintPage,
): ThumbnailRenderer {
  const cache = new Map<number, Promise<ImageBitmap | null>>()
  return {
    render(page) {
      let pending = cache.get(page)
      if (!pending) {
        pending = paint(pdf, page).catch(() => null)
        cache.set(page, pending)
      }
      return pending
    },
    dispose() {
      for (const pending of cache.values()) void pending.then((bitmap) => bitmap?.close())
      cache.clear()
    },
  }
}
```

- [ ] **Step 4: Rewrite `src/PageNavigation.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import type { ThumbnailRenderer } from './PageThumbnails'

export const THUMBNAIL_WIDTH = 46
export const THUMBNAIL_HEIGHT = 58

type PageNavigationProps = {
  id: string
  pageCount: number
  currentPage: number
  onNavigate: (page: number) => void
  onClose: () => void
  /** Renders a page's thumbnail; null until the document has loaded (cards then show their numbers only). */
  thumbnails: ThumbnailRenderer | null
}

function ThumbnailCanvas({ page, thumbnails, visible }: { page: number; thumbnails: ThumbnailRenderer | null; visible: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<'pending' | 'drawn' | 'unavailable'>('pending')
  useEffect(() => {
    if (!visible || !thumbnails || state !== 'pending') return
    let cancelled = false
    void thumbnails.render(page).then((bitmap) => {
      if (cancelled) return
      const context = bitmap ? canvasRef.current?.getContext('2d') : null
      if (!bitmap || !context) {
        setState('unavailable')
        return
      }
      context.drawImage(bitmap, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)
      setState('drawn')
    })
    return () => {
      cancelled = true
    }
  }, [page, state, thumbnails, visible])
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      width={THUMBNAIL_WIDTH}
      height={THUMBNAIL_HEIGHT}
      data-thumbnail={state}
      className="block rounded-[2px] border border-line-strong bg-surface shadow-sm"
    />
  )
}

/** The page rail: a thumbnail card per page, rendered lazily while the rail is open and the page is within one rail
 *  height of view. The current page carries a 2px ink ring; the keyboard model is a roving tab stop with arrows, Home and End. */
export function PageNavigation({ id, pageCount, currentPage, onNavigate, onClose, thumbnails }: PageNavigationProps) {
  const pageButtons = useRef(new Map<number, HTMLButtonElement>())
  const navRef = useRef<HTMLElement>(null)
  // Without IntersectionObserver (tests) every page counts as in view.
  const [visible, setVisible] = useState<ReadonlySet<number>>(() =>
    typeof IntersectionObserver === 'undefined' ? new Set(Array.from({ length: pageCount }, (_, index) => index + 1)) : new Set(),
  )

  useEffect(() => {
    pageButtons.current.get(currentPage)?.parentElement?.scrollIntoView({ block: 'nearest' })
  }, [currentPage])

  useEffect(() => {
    const nav = navRef.current
    if (!nav || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((current) => {
          const next = new Set(current)
          for (const entry of entries) if (entry.isIntersecting) next.add(Number((entry.target as HTMLElement).dataset.page))
          return next.size === current.size ? current : next
        })
      },
      { root: nav, rootMargin: `${nav.clientHeight}px 0px` },
    )
    nav.querySelectorAll<HTMLElement>('[data-page]').forEach((item) => observer.observe(item))
    return () => observer.disconnect()
  }, [pageCount])

  return (
    <nav
      id={id}
      ref={navRef}
      aria-label="Page navigation"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
      className="scrollbar-subtle z-20 w-[76px] shrink-0 overflow-y-auto overscroll-contain border-r border-line bg-surface-muted max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:shadow-lg"
    >
      <ol className="flex flex-col items-center gap-2 px-1 py-2">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
          <li key={page} data-page={page} className="flex w-full flex-col items-center">
            <button
              type="button"
              aria-label={`Go to page ${page}`}
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
              className={`flex w-[62px] cursor-pointer flex-col items-center gap-1 rounded-[3px] p-1 outline-none transition-colors hover:bg-accent-ghost ${
                page === currentPage ? 'ring-2 ring-ink ring-offset-1 ring-offset-surface-muted' : ''
              }`}
            >
              <ThumbnailCanvas page={page} thumbnails={thumbnails} visible={visible.has(page)} />
              <span className="text-compact tabular-nums text-ink-muted">{page}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
```

(`:focus-visible` is the global ring from `index.css`; the `ring-ink` ring is the current-page mark only, so a focused non-current card shows the accent ring and the current one both.)

- [ ] **Step 5: `App.tsx`**: add `const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null)`; in `loadPdf` after `const pdf = await loadingTask.promise` and the abort check: `setPdfDocument(pdf)`; in the effect cleanup (396-405): `setPdfDocument(null)`. Then `const thumbnails = useMemo(() => (pdfDocument ? createThumbnailRenderer(pdfDocument) : null), [pdfDocument])` and `useEffect(() => () => thumbnails?.dispose(), [thumbnails])`. Pass `thumbnails={thumbnails}` to `<PageNavigation>`. In `App.test.tsx` the `getDocument` mock resolves `{ numPages: 3 }` without `getPage`, so every card ends `unavailable` and the keyboard case at 1321 still passes; add to that case `expect(navigation.getAllByRole('button', { name: /^Go to page/ })[0]!.querySelector('canvas')).toBeInTheDocument()`.

- [ ] **Step 6: Verify** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/PageThumbnails.test.ts src/PageNavigation.test.tsx src/App.test.tsx` → pass.

- [ ] **Step 7: Commit** — `feat(studio): thumbnail page rail rendered lazily from the viewer's own document`.

---

### Task 6: Field rows: pills, hover actions, one-click delete with undo, blank new field, keyboard (§6, §11)

**Files:**
- Create: `prototypes/studio/src/FieldRow.tsx`, `prototypes/studio/src/fieldTypeWords.ts`, `prototypes/studio/src/fieldTypeWords.test.ts`
- Modify: `prototypes/studio/src/SchemaPanel.tsx` (delete `AllowedValuesBadge` 137-161, `FieldTypeBadge` 224-244, `fieldTypeLabel`, `subtreeIdsOf`, `bulkRemoveNodes` 914-927, `toggleSelected` 929-940, the selection bar 1635-1657, the `selectedIds` state and its resets; merge `renderRootField`/`renderChildField` 1108-1370 into one `renderField`; `addField` 957-968; `saveEdit` 870; `FieldEditForm` Save button 361), `prototypes/studio/src/schemaEditorTree.ts` (export `restoreSchemaNode`)
- Test: `prototypes/studio/src/SchemaPanel.test.tsx`, `prototypes/studio/src/schemaEditorTree.test.ts`, `prototypes/studio/src/App.test.tsx`

**Interfaces:**
- Consumes: `Toast`/`useToast` (Task 2), `Pill` (`tone="neutral"`, `outline`), `PencilIcon` from `./ui/ResultValue`, `removeSchemaNode`.
- Produces: `fieldTypeWords(node: SchemaNode): string`; `restoreSchemaNode(nodes, node, parentId, index): SchemaNode[] | null`; `FieldRow` (one row's line and its note line; the panel keeps recursion, slots, edit forms and children); rows are `role="listitem"` named by the field inside `div[role="list"][aria-label="Schema fields"]`; actions are `button[aria-label="Edit <name>"]`, `"Add note to <name>"`, `"Delete <name>"`; the type pill's `title` is `Type: <words> — click to edit`; the values pill reads `<n> values` with `title="Allowed values — click to edit: a, b"`; the undo toast reads "Field removed" with an "Undo" action for 8 s; the failed restore toast reads "Could not restore the field".

- [ ] **Step 1: Write the failing tests.** `src/fieldTypeWords.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { fieldTypeWords } from './fieldTypeWords'

describe('fieldTypeWords', () => {
  it('says scalar types in words', () => {
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'string' })).toBe('string')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'verbatim-string' })).toBe('verbatim')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'number' })).toBe('number')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'boolean' })).toBe('boolean')
  })
  it('lists and groups', () => {
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'array', itemType: 'string' })).toBe('list of strings')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'array', itemType: 'date' })).toBe('list of dates')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'array', itemType: 'verbatim-string' })).toBe('list of verbatim strings')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'array', children: [] })).toBe('list of objects')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'object', children: [] })).toBe('object')
  })
})
```

Add to `src/schemaEditorTree.test.ts`:

```ts
describe('restoreSchemaNode', () => {
  const tree: SchemaNode[] = [
    { id: 'g', name: 'grave', type: 'object', children: [{ id: 'g1', name: 'depth', type: 'number' }, { id: 'g2', name: 'width', type: 'number' }] },
    { id: 't', name: 'title', type: 'string' },
  ]
  it('puts a removed node back under its parent at its index', () => {
    const [removed, without] = removeSchemaNode(tree, 'g1')
    expect(restoreSchemaNode(without, removed!, 'g', 0)![0]!.children!.map((node) => node.id)).toEqual(['g1', 'g2'])
    const [root, rest] = removeSchemaNode(tree, 't')
    expect(restoreSchemaNode(rest, root!, null, 1)!.map((node) => node.id)).toEqual(['g', 't'])
  })
  it('is null when the parent no longer exists', () => {
    const [removed, without] = removeSchemaNode(tree, 'g1')
    const [, withoutGroup] = removeSchemaNode(without, 'g')
    expect(restoreSchemaNode(withoutGroup, removed!, 'g', 0)).toBeNull()
  })
})
```

Add to `src/SchemaPanel.test.tsx` (rows are found with `screen.getByRole('listitem', { name: 'gender' })`; the `nodes` fixture already has `gender` with two allowed values):

```tsx
describe('field rows (redesign §6)', () => {
  it('shows the name in full beside word pills, keeps actions until hover or focus, and has no selection checkboxes', () => {
    renderPanel({ panelNodes: [...nodes, { id: 'dates', name: 'dates', type: 'array', itemType: 'date' },
      { id: 'sex', name: 'sex', type: 'string', allowedValues: ['f', 'm', 'unknown', 'child', 'adult', 'elder'] }] })
    const row = screen.getByRole('listitem', { name: 'sex' })
    expect(within(row).getByText('sex').className).toMatch(/shrink-0/)
    expect(within(row).getByText('sex').className).toMatch(/max-w-\[60%\]/)
    expect(within(row).getByText('6 values')).toBeInTheDocument()
    expect(within(row).getByTitle('Type: string — click to edit')).toBeInTheDocument()
    expect(within(screen.getByRole('listitem', { name: 'dates' })).getByTitle('Type: list of dates — click to edit')).toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    const actions = within(row).getByRole('button', { name: 'Delete sex' }).parentElement!
    expect(actions.className).toMatch(/group-hover:opacity-100/)
    expect(actions.className).toMatch(/group-focus-within:opacity-100/)
    expect(within(row).getByRole('button', { name: 'Delete sex' }).className).toMatch(/size-7/)
  })

  it('deletes a field in one click and Undo restores it in place', async () => {
    const setup = renderPanel()
    fireEvent.click(within(screen.getByRole('listitem', { name: 'title' })).getByRole('button', { name: 'Delete title' }))
    expect(screen.queryByRole('listitem', { name: 'title' })).not.toBeInTheDocument()
    expect(setup.edits.at(-1)!.schemaNodes.map((node) => node.name)).toEqual(['gender'])
    expect(screen.getByRole('status')).toHaveTextContent('Field removed')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(setup.edits.at(-1)!.schemaNodes.map((node) => node.name)).toEqual(['title', 'gender'])
    expect(screen.getByRole('listitem', { name: 'title' })).toBeInTheDocument()
  })

  it('Undo after the parent group was deleted says it could not restore', () => {
    renderPanel({ panelNodes: [{ id: 'g', name: 'grave', type: 'object', children: [{ id: 'g1', name: 'depth', type: 'number' }] }] })
    fireEvent.click(within(screen.getByRole('listitem', { name: 'depth' })).getByRole('button', { name: 'Delete depth' }))
    fireEvent.click(within(screen.getByRole('listitem', { name: 'grave' })).getByRole('button', { name: 'Delete grave' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByRole('status')).toHaveTextContent('Could not restore the field')
    expect(screen.queryByRole('listitem', { name: 'depth' })).not.toBeInTheDocument()
  })

  it('a new field opens an empty edit form whose Save waits for a name', () => {
    const setup = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }))
    const name = screen.getByPlaceholderText('field_name')
    expect(name).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(name, { target: { value: 'Grave goods' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(setup.edits.at(-1)!.schemaNodes.at(-1)!.name).toBe('grave_goods')
    expect(screen.queryByText('nyt_felt')).not.toBeInTheDocument()
  })

  it('a note renders in full as a second line and opens the note form', () => {
    renderPanel()
    const row = screen.getByRole('listitem', { name: 'title' })
    expect(within(row).getByText('Research rule')).toBeInTheDocument()
    fireEvent.click(within(row).getByText('Research rule'))
    expect(screen.getByPlaceholderText('Add another note…')).toBeInTheDocument()
  })

  it('keyboard: Enter edits, Delete removes with undo, Space toggles a group', () => {
    renderPanel({ panelNodes: [{ id: 'g', name: 'grave', type: 'object', children: [{ id: 'g1', name: 'depth', type: 'number' }] }, ...nodes] })
    const group = screen.getByRole('listitem', { name: 'grave' })
    expect(screen.getByRole('listitem', { name: 'depth' })).toBeInTheDocument()
    fireEvent.keyDown(group, { key: ' ' })
    expect(screen.queryByRole('listitem', { name: 'depth' })).not.toBeInTheDocument()
    expect(within(group).getByText(/object · 1 field$/)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'title' }), { key: 'Enter' })
    expect(screen.getByDisplayValue('title')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByDisplayValue('title'), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'gender' }), { key: 'Delete' })
    expect(screen.queryByRole('listitem', { name: 'gender' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })
})
```

Then update the existing cases: 451-483 `getByTitle('Add description')` → `getByRole('button', { name: /^Add note to / })` (the "i" button is gone; the note-plus action opens the same form); 512-560 `getByDisplayValue('nyt_felt')` → `getByPlaceholderText('field_name')` and the Enter/Save cases type a name first; 575-607 titles `Type: array<date> — click to edit` → `Type: list of dates — click to edit`, `array<integer>` → `list of integers`; 656-690 keep their `Allowed values — click to edit: woman, man` titles (unchanged) and assert the pill text `2 values`; any `screen.getByText('new_field').parentElement!` row lookups become `closest('[role="listitem"]')`; the 842-1012 proposal cases keep their `Accept change to …` checkboxes (proposal review is unchanged).

- [ ] **Step 2: Run them to verify they fail** — `pnpm -C prototypes/studio exec vitest run src/fieldTypeWords.test.ts src/schemaEditorTree.test.ts src/SchemaPanel.test.tsx` → FAIL.

- [ ] **Step 3: `src/fieldTypeWords.ts`**

```ts
import pluralize from 'pluralize'
import type { SchemaNode } from 'extraction/schema'

const WORDS: Record<string, string> = {
  string: 'string',
  'verbatim-string': 'verbatim',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  date: 'date',
}

const PLURALS: Record<string, string> = { 'verbatim-string': 'verbatim strings' }

function word(type: string): string {
  return WORDS[type] ?? type
}

/** A field's type in words for its pill (§6): "string", "verbatim", "list of strings", "list of objects", "object". */
export function fieldTypeWords(node: SchemaNode): string {
  if (node.type === 'array')
    return node.children === undefined
      ? `list of ${PLURALS[node.itemType ?? 'string'] ?? pluralize(word(node.itemType ?? 'string'))}`
      : 'list of objects'
  if (node.children !== undefined || node.type === 'object') return 'object'
  return word(node.type)
}
```

- [ ] **Step 4: `schemaEditorTree.ts`**: export

```ts
/** Puts a removed node back under `parentId` at `index`; null when that parent no longer exists. Sibling names are
 *  checked by the commit gate, not here. */
export function restoreSchemaNode(
  nodes: readonly SchemaNode[],
  node: SchemaNode,
  parentId: string | null,
  index: number,
): SchemaNode[] | null {
  if (parentId !== null && !enumerateFieldPaths(nodes).some((field) => field.id === parentId)) return null
  return insertAtSlot(deepClone(nodes), parentId, index, node)
}
```

(`enumerateFieldPaths` lists groups too; if the Step 1 test shows it does not, walk the tree with a small local `hasNode(nodes, id)` instead.)

- [ ] **Step 5: Create `src/FieldRow.tsx`.** Move `FieldChangeLabel` (246-280, its name span becomes `font-mono text-content font-semibold shrink-0 max-w-[60%] truncate`, before/after types through `fieldTypeWords`), `ChangeBadge` (163-198, `text-[9px]` → `text-overline`) and `AcceptanceControl` (200-218, `text-[10px]` → `text-overline`) here, then:

```tsx
import type { SchemaNode } from 'extraction/schema'
import type { Change, ReplayOutcome } from '../shared/schemaChanges'
import { Pill } from './ui'
import { PencilIcon } from './ui/ResultValue'
import { fieldTypeWords } from './fieldTypeWords'

export type FieldRowProps = {
  node: SchemaNode
  isGroup: boolean
  expanded: boolean
  onToggleExpanded?: () => void
  change?: Change
  outcome?: ReplayOutcome
  impliedRemoved?: boolean
  acceptance?: { accepted: boolean; onToggle: (id: string) => void }
  readOnly: boolean
  editDisabled: boolean
  dragging: boolean
  intoGroup: boolean
  onStartDrag: (event: React.MouseEvent) => void
  onEdit: () => void
  onAddNote: () => void
  onDelete: () => void
  nodeRef?: (element: HTMLDivElement | null) => void
}

const ACTION = 'grid size-7 cursor-pointer place-items-center rounded-[3px] text-ink-muted outline-none transition-colors hover:bg-surface-muted hover:text-accent disabled:cursor-default disabled:opacity-40'

function CollapseArrow({ expanded }: { expanded: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
      <polygon points="0,0 8,4 0,8" />
    </svg>
  )
}

function NotePlusIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h9l3 3v9H4z" /><path d="M7 10h6M7 13h4" /><path d="M14 2v4h4" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M8 2a1 1 0 00-1 1v1H4a1 1 0 000 2h12a1 1 0 100-2h-3V3a1 1 0 00-1-1H8zM5 7a1 1 0 011 1v8a2 2 0 002 2h4a2 2 0 002-2V8a1 1 0 112 0v8a4 4 0 01-4 4H8a4 4 0 01-4-4V8a1 1 0 011-1z" clipRule="evenodd" />
    </svg>
  )
}

/** One schema field's row (§6): grip, disclosure, name, type and values pills, proposal badges, then the actions revealed
 *  on hover and focus-within. A note renders below in full. The panel owns recursion, drag targets and edit forms. */
export default function FieldRow({ node, isGroup, expanded, onToggleExpanded, change, outcome, impliedRemoved, acceptance, readOnly, editDisabled, dragging, intoGroup, onStartDrag, onEdit, onAddNote, onDelete, nodeRef }: FieldRowProps) {
  const diffStatus = change?.kind ?? (impliedRemoved ? 'removed' : null)
  const isDiff = diffStatus !== null
  const diffBg = diffStatus === 'added' ? 'bg-green-soft' : diffStatus === 'removed' ? 'bg-danger-soft' : diffStatus === 'modified' ? 'bg-stale-soft' : ''
  const count = node.children?.length ?? 0
  const typeWords = `${fieldTypeWords(node)}${isGroup && !expanded ? ` · ${count} field${count === 1 ? '' : 's'}` : ''}`
  return (
    <>
      <div
        role="listitem"
        aria-label={node.name}
        tabIndex={0}
        ref={nodeRef}
        className={`group -mx-2 flex min-h-[30px] items-center gap-1 rounded-[3px] border px-2 outline-none transition-[background,border,opacity] duration-150 ${
          intoGroup || dragging ? 'border-accent' : 'border-transparent'
        } ${intoGroup ? 'bg-accent-ghost' : ''} ${dragging ? 'opacity-40' : ''} ${diffBg}`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || readOnly || isDiff) return
          if (event.key === 'Enter') { event.preventDefault(); onEdit() }
          else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onDelete() }
          else if (event.key === ' ' && isGroup) { event.preventDefault(); onToggleExpanded?.() }
        }}
      >
        {!isDiff && !readOnly ? (
          <span aria-hidden="true" className="shrink-0 cursor-grab select-none px-0.5 text-sm leading-none text-ink-faint opacity-60" onMouseDown={onStartDrag}>⠿</span>
        ) : <span className="w-3.5 shrink-0" />}
        {isGroup ? (
          <button type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.name}`} aria-expanded={expanded}
            className="grid size-5 shrink-0 cursor-pointer place-items-center text-ink-faint outline-none hover:text-accent" onClick={onToggleExpanded}>
            <CollapseArrow expanded={expanded} />
          </button>
        ) : <span className="w-5 shrink-0" />}
        <FieldChangeLabel node={node} change={change} impliedRemoved={impliedRemoved} />
        {!isDiff && (
          <button type="button" className="shrink-0 cursor-pointer rounded-full outline-none disabled:cursor-default disabled:opacity-60"
            title={`Type: ${typeWords} — click to edit`} disabled={editDisabled || readOnly} onClick={onEdit}>
            <Pill tone="neutral" className="text-compact font-medium">{typeWords}</Pill>
          </button>
        )}
        {!isDiff && node.allowedValues && (
          <button type="button" className="shrink-0 cursor-pointer rounded-full outline-none disabled:cursor-default disabled:opacity-60"
            title={`Allowed values — click to edit: ${node.allowedValues.join(', ')}`} disabled={editDisabled || readOnly} onClick={onEdit}>
            <Pill outline className="text-compact font-medium">{node.allowedValues.length} values</Pill>
          </button>
        )}
        <ChangeBadge change={change} outcome={outcome} />
        {intoGroup && !isDiff && (
          <span className="shrink-0 whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 font-sans text-overline font-semibold tracking-wide text-white">into {node.name}</span>
        )}
        <span className="min-w-0 flex-1" />
        {change && acceptance && <AcceptanceControl id={change.id} name={change.after?.name ?? node.name} accepted={acceptance.accepted} onChange={acceptance.onToggle} />}
        {!isDiff && !readOnly && (
          <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button type="button" className={ACTION} title={`Edit ${node.name}`} aria-label={`Edit ${node.name}`} disabled={editDisabled} onClick={onEdit}><PencilIcon /></button>
            <button type="button" className={ACTION} title="Add note" aria-label={`Add note to ${node.name}`} disabled={editDisabled} onClick={onAddNote}><NotePlusIcon /></button>
            <button type="button" className={`${ACTION} text-danger hover:bg-danger-soft hover:text-danger`} title={`Delete ${node.name}`} aria-label={`Delete ${node.name}`} disabled={editDisabled} onClick={onDelete}><TrashIcon /></button>
          </span>
        )}
      </div>
      {node.description && !isDiff && (
        <button type="button" onClick={onAddNote}
          className="-mx-2 block w-[calc(100%+1rem)] cursor-text px-2 pb-1 pl-11 text-left text-secondary leading-snug text-ink-muted whitespace-pre-line outline-none hover:text-ink">
          {node.description}
        </button>
      )}
    </>
  )
}
```

(The existing `getByTitle('Edit title')` lookups keep working through the `title`; `bg-amber-100` for modified rows becomes `bg-stale-soft`, a token.)

- [ ] **Step 6: `SchemaPanel.tsx`.**

1. Imports: `FieldRow`, `restoreSchemaNode`, `useToast`, `Toast`; remove `Pill`-less badge components and `FieldChangeLabel`/`ChangeBadge`/`AcceptanceControl` definitions (moved); delete `fieldTypeLabel`, `subtreeIdsOf`, `selectedIds`, `toggleSelected`, `bulkRemoveNodes`, the `setSelectedIds` lines in `resetEditorUi`, the selection bar.
2. Expansion: `const [expandedIds, setExpandedIds] = useState<Set<string>>(() => rootGroupIds(nodes))` where `const rootGroupIds = (list: readonly SchemaNode[]) => new Set(list.filter((node) => node.children !== undefined).map((node) => node.id))`; `resetEditorUi` sets `setExpandedIds(rootGroupIds(schema.snapshot().draft?.schemaNodes ?? EMPTY_NODES))`. Every group (root included) shows the disclosure; the slot/drag code is unchanged.
3. One recursive renderer replaces 1108-1370:

```tsx
  function renderField(node: SchemaNode, parentId: string | null, index: number, ancestorRemoved = false): React.ReactNode {
    const isGroup = node.children !== undefined
    const isDragging = dragging?.id === node.id
    const intoGroup = dragMode === 'normal' && overTarget?.type === 'group' && overTarget.id === node.id
    const isExpanded = expandedIds.has(node.id) || intoGroup
    const change = pending?.changes.find((item) => item.id === node.id)
    const diffStatus = change?.kind ?? (ancestorRemoved ? 'removed' : null)
    const isDiff = diffStatus !== null
    const isEditing = editing?.id === node.id
    return (
      <div key={node.id} data-schema-node-id={node.id}
        onMouseEnter={() => !isDiff && setGroupTarget(node.id, node.name)}
        onMouseLeave={() => !isDiff && clearGroupTarget(node.id)}>
        <div className={slotCls(parentId, index)} onMouseEnter={(event) => { event.stopPropagation(); setSlotTarget(parentId, index) }} />
        {isEditing && editing && !isDiff ? (
          <FieldEditForm editing={editing} error={editingError} onChange={(next) => { setEditing(next); setEditingError(null) }} onSave={saveEdit} onCancel={cancelEdit} />
        ) : (
          <FieldRow node={node} isGroup={isGroup} expanded={isExpanded}
            onToggleExpanded={() => setExpandedIds((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })}
            change={change} outcome={change && replay?.outcomes.get(change.id)} impliedRemoved={ancestorRemoved}
            acceptance={change ? { accepted: acceptedChangeIds.has(change.id), onToggle: proposalReview.toggle } : undefined}
            readOnly={editorReadOnly} editDisabled={editDisabled} dragging={isDragging} intoGroup={intoGroup}
            onStartDrag={(event) => startDrag(event, node.id, parentId, node.name, isGroup)}
            onEdit={() => { setEditing(editingOf(node)); setEditingError(null) }}
            onAddNote={() => { const next = openDescId === node.id ? null : node.id; if (next) setDescDraft(''); setOpenDescId(next) }}
            onDelete={() => deleteField(node, parentId, index)}
            nodeRef={fieldContext?.nodeId === node.id ? focusField : undefined} />
        )}
        {openDescId === node.id && (
          <DescriptionEditForm existing={node.description ?? ''} value={descDraft} onChange={setDescDraft}
            onAdd={() => addNodeDescriptionNote(node.id, node.description, descDraft)}
            onDelete={() => { updateNodeDescription(node.id, undefined); setOpenDescId(null) }} onCancel={() => setOpenDescId(null)} />
        )}
        {isGroup && isExpanded && ((node.children ?? []).length > 0 || !!dragging) && (
          <div role="list" aria-label={`Fields of ${node.name}`} className="ml-4 mt-0.5 border-l border-line pl-3">
            {(node.children ?? []).map((child, childIndex) => renderField(child, node.id, childIndex, ancestorRemoved || diffStatus === 'removed'))}
            <div className={slotCls(node.id, (node.children ?? []).length)} onMouseEnter={() => setSlotTarget(node.id, (node.children ?? []).length)} />
          </div>
        )}
      </div>
    )
  }
```
   The fields container (1658) becomes `<div role="list" aria-label="Schema fields" className="flex flex-col">` and maps `(pending ? pending.reviewNodes : nodes).map((node, i) => renderField(node, null, i))`.
4. Delete with undo and the toast host:

```tsx
  const { toast: panelToast, showToast: showPanelToast, dismissToast: dismissPanelToast } = useToast()

  /** One click removes the field and its subtree; Undo puts it back where it was for eight seconds (§6). */
  function deleteField(node: SchemaNode, parentId: string | null, index: number) {
    const result = schema.commit((current) => removeSchemaNode(current, node.id)[1], 'Field removed')
    if (!result.ok) {
      setMutationError('No schema draft is open.')
      return
    }
    if (editing?.id === node.id) cancelEdit()
    if (openDescId === node.id) setOpenDescId(null)
    showPanelToast('Field removed', {
      durationMs: 8_000,
      action: {
        label: 'Undo',
        onAction: () => {
          const restored = schema.commit((current) => restoreSchemaNode(current, node, parentId, index) ?? current, 'Field restored')
          const changed = restored.ok && (schema.snapshot().draft?.schemaNodes ?? EMPTY_NODES).some((root) => root.id === node.id || root.children?.some((child) => child.id === node.id))
          if (!restored.ok || !changed) showPanelToast('Could not restore the field')
        },
      },
    })
  }
```
   (A commit that returns the tree unchanged still "succeeds"; the `changed` check tells a vanished parent from a real restore. For nodes deeper than one level, replace the inline `some` with `enumerateFieldPaths(...).some((field) => field.id === node.id)`.) The panel root `div` gains `relative`; render the toast right before the footer:

```tsx
      {panelToast && (
        <div className="pointer-events-none absolute inset-x-3 bottom-14 z-20 flex justify-center">
          <Toast message={panelToast.message} action={panelToast.action} onDismiss={dismissPanelToast} />
        </div>
      )}
```
5. `addField` builds `{ id, name: '', type: 'verbatim-string' as const }` (no `nyt_felt`, no suffix loop); `saveEdit` replaces `|| 'field'` with `if (!name) { setEditingError('Enter a field name.'); return }`; `FieldEditForm`'s Save button gets `disabled={!editing.name.trim()}` and `variant`-like classes stay (it is not a `Button`; convert it to `<Button variant="positive">Save</Button>` while here, and the cancel to `<Button aria-label="Cancel field edit">✗</Button>`).
6. `DescriptionEditForm` placeholders stay (`Add another note…`, `Describe this field for the extraction model…`).

- [ ] **Step 7: Verify** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/fieldTypeWords.test.ts src/schemaEditorTree.test.ts src/SchemaPanel.test.tsx src/App.test.tsx src/RightRail.test.tsx src/projectContexts/BatchExtractionsPanel.test.tsx` → pass. `grep -n "selectedIds\|nyt_felt\|Add description\|fieldTypeLabel" prototypes/studio/src/SchemaPanel.tsx` → nothing.

- [ ] **Step 8: Commit** — `feat(studio): field rows with word pills, hover actions and one-click delete with undo`.

---

### Task 7: The chat composer and drawer (§7)

**Files:**
- Create: `prototypes/studio/src/ChatDrawer.tsx`
- Modify: `prototypes/studio/src/SchemaPanel.tsx` (the `!ready` block 1697-1713, the `ready` chat block 1719-1858, `CHAT_GREETING`, `chat` initial state, `sendChatMessage`, apply/discard), `prototypes/studio/src/SchemaInstructions.tsx` (`SchemaInstructionsChat` becomes the list only)
- Test: `prototypes/studio/src/SchemaPanel.test.tsx`, `prototypes/studio/e2e/critical-flows.spec.ts:132, 155` (placeholder and button names are unchanged; verify)

**Interfaces:**
- Produces: `ChatDrawer({ open, onCollapse, onExpand, title, headerAction?, dot?, bar?, composer, children })`; the drawer body is `section[aria-label="Conversation"]`; the collapse control is `button[aria-label="Collapse conversation"]`; the collapsed reopen control is `button[aria-label="Show conversation"]` (or `"An earlier request is still running"` while one runs); the composers keep their placeholders `Describe a change to the schema…` and `Add a generation instruction (e.g. "Focus on names, dates, and locations")…`.

- [ ] **Step 1: Write the failing tests** in `SchemaPanel.test.tsx` (reuse the chat helpers around line 170 that stub `requestSchemaEdit`):

```tsx
describe('chat composer and drawer (redesign §7)', () => {
  it('is one composer line at rest, with no greeting, and expands on send', async () => {
    renderPanel({ durableScope: true })
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Edit through drag and drop/)).not.toBeInTheDocument()
    requestSchemaEdit.mockResolvedValueOnce(proposalResponse)   // the fixture the existing chat cases use
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Rename title to heading' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('region', { name: 'Conversation' })).toBeInTheDocument()
    expect(screen.getByText('Rename title to heading')).toBeInTheDocument()
    await screen.findByRole('button', { name: 'Apply changes' })
  })

  it('a pending proposal keeps the drawer open; the chevron hides it without discarding and the dot brings it back', async () => {
    renderPanel({ durableScope: true })
    requestSchemaEdit.mockResolvedValueOnce(proposalResponse)
    const input = screen.getByPlaceholderText('Describe a change to the schema…')
    fireEvent.change(input, { target: { value: 'Rename title to heading' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await screen.findByRole('button', { name: 'Apply changes' })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse conversation' }))
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show conversation' }))
    expect(screen.getByRole('button', { name: 'Apply changes' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply changes' }))
    expect(screen.queryByRole('region', { name: 'Conversation' })).not.toBeInTheDocument()
  })

  it('before a schema exists the instructions conversation is open with Generate schema in its header', () => {
    const onGenerateInstructions = vi.fn()
    renderPanel({ durableScope: true, noSchema: true }, { onGenerateInstructions })
    const drawer = screen.getByRole('region', { name: 'Conversation' })
    expect(within(drawer).getByRole('button', { name: /^Generate schema/ })).toBeInTheDocument()
    const input = screen.getByPlaceholderText(/Add a generation instruction/)
    fireEvent.change(input, { target: { value: 'Focus on dates' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(within(drawer).getByText('Focus on dates')).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: /^Generate schema/ }))
    expect(onGenerateInstructions).toHaveBeenCalledWith('Focus on dates')
  })
})
```

Add a recovery case next to the existing `useModelOperationRecovery` tests in this file: with `listModelOperations` resolving one running edit operation and the drawer collapsed, `screen.getByRole('button', { name: 'An earlier request is still running' })` is present and opens the drawer showing the `Still working on an earlier request` row.

- [ ] **Step 2: Run them to verify they fail** — FAIL (no region, greeting present).

- [ ] **Step 3: Create `src/ChatDrawer.tsx`**

```tsx
import type { ReactNode } from 'react'

export type ChatDrawerProps = {
  open: boolean
  onCollapse: () => void
  onExpand: () => void
  title: string
  /** A command in the header, e.g. "Generate schema" before a schema exists. */
  headerAction?: ReactNode
  /** While collapsed, marks the composer: an open conversation or an earlier request still running. */
  dot?: { title: string } | null
  /** Sticky controls between the conversation and the composer, e.g. the proposal's Apply / Discard bar. */
  bar?: ReactNode
  composer: ReactNode
  children: ReactNode
}

/** The rail's conversation: a composer line at rest; sending opens a drawer of 40% of the rail with the conversation,
 *  a header and a collapse chevron. Collapsing hides, never discards. */
export default function ChatDrawer({ open, onCollapse, onExpand, title, headerAction, dot, bar, composer, children }: ChatDrawerProps) {
  return (
    <div className={`flex shrink-0 flex-col border-t border-line bg-surface-muted ${open ? 'h-[40%] min-h-48' : ''}`}>
      {open && (
        <section aria-label="Conversation" className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3.5 py-1.5">
            <span className="text-overline font-bold uppercase tracking-[0.12em] text-ink-muted">{title}</span>
            <div className="flex items-center gap-1.5">
              {headerAction}
              <button type="button" aria-label="Collapse conversation" title="Collapse"
                className="grid size-6 cursor-pointer place-items-center rounded-[3px] text-ink-muted outline-none hover:text-accent" onClick={onCollapse}>
                <span aria-hidden="true">⌄</span>
              </button>
            </div>
          </div>
          <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5">{children}</div>
          {bar}
        </section>
      )}
      <div className="flex shrink-0 items-center gap-2 px-3.5 pb-3 pt-1.5">
        {!open && dot && (
          <button type="button" aria-label={dot.title} title={dot.title}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full outline-none hover:bg-surface" onClick={onExpand}>
            <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
          </button>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-2.5 py-1.5">{composer}</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: `SchemaInstructions.tsx`**: `SchemaInstructionsChat` renders only the message list (its empty-state paragraph and the `instruction.items` map, scrolled by the drawer); delete its composer (70-94) — the panel composes it. Keep `SchemaInstructionsDrawer` for the Regenerate dialog.

- [ ] **Step 5: `SchemaPanel.tsx`.**

1. `const [chat, setChat] = useState<ChatMsg[]>([])`; delete `CHAT_GREETING`'s bubble seeding in `resetEditorUi` (`setChat([])`); keep the text as `const CONVERSATION_EMPTY = "Edit through drag and drop, or describe a change. I'll show you the changes before you apply them."`, rendered in the drawer body when `chat.length === 0 && runningRows.length === 0 && !chatLoading`.
2. `const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null)`; `const drawerShown = drawerOpen ?? !ready` (open by default before a schema exists). `sendChatMessage` begins with `setDrawerOpen(true)`. Wrap the proposal actions: `const applyProposal = () => { proposalReview.apply(); setDrawerOpen(false) }`, `const discardProposal = () => { proposalReview.discard(); setDrawerOpen(false) }`. `resetEditorUi(true)` sets `setDrawerOpen(null)`.
3. `const dot = !drawerShown && (runningRows.length > 0 ? { title: 'An earlier request is still running' } : chat.length > 0 || pending ? { title: 'Show conversation' } : null)`.
4. Replace both chat blocks (1697-1713 and 1719-1858) with one:

```tsx
      {(!ready || !editorReadOnly) && (
        <ChatDrawer open={drawerShown} onCollapse={() => setDrawerOpen(false)} onExpand={() => setDrawerOpen(true)}
          title={ready ? 'Conversation' : 'Instructions for generation'} dot={dot}
          headerAction={!ready && snap.view === 'empty' && onGenerateInstructions ? (
            <Button variant="positive" onClick={() => onGenerateInstructions(instructions.text)}>Generate schema{instructions.countLabel}</Button>
          ) : undefined}
          bar={ready && pending ? <ProposalReviewBar proposal={pending} canApply={canApply} onApply={applyProposal} onDiscard={discardProposal} /> : undefined}
          composer={ready ? (
            <>
              <input className="min-w-0 flex-1 bg-transparent font-sans text-secondary text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
                placeholder="Describe a change to the schema…" value={chatInput} disabled={chatBlocked}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void sendChatMessage(chatInput) }} />
              {chatLoading ? (
                <button type="button" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-danger text-compact text-white outline-none hover:brightness-108"
                  onClick={cancelChat} title="Stop schema edit request" aria-label="Stop schema edit request">■</button>
              ) : (
                <button type="button" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-green text-compact text-white outline-none hover:brightness-108 disabled:opacity-40"
                  aria-label="Send" disabled={!chatInput.trim() || chatBlocked} onClick={() => void sendChatMessage(chatInput)}>↑</button>
              )}
            </>
          ) : (
            <>
              <textarea className="min-w-0 flex-1 resize-none bg-transparent font-sans text-secondary text-ink outline-none placeholder:text-ink-faint" rows={1}
                placeholder={'Add a generation instruction (e.g. "Focus on names, dates, and locations")…'} value={instructions.draft}
                onChange={(event) => instructions.setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); setDrawerOpen(true); instructions.send() } }} />
              <button type="button" aria-label="Add instruction" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-green text-compact text-white outline-none hover:brightness-108 disabled:opacity-40"
                disabled={!instructions.draft.trim()} onClick={() => { setDrawerOpen(true); instructions.send() }}>↑</button>
            </>
          )}>
          {ready ? (
            <div ref={chatRef} className="flex flex-col gap-2">
              {runningRows}
              {chat.length === 0 && runningRows.length === 0 && !chatLoading && (
                <p className="text-secondary leading-relaxed text-ink-faint">{CONVERSATION_EMPTY}</p>
              )}
              {chat.map((message, index) => <div key={index} className={msgCls(message.role)}>{message.text}</div>)}
              {chatLoading && (…the typing indicator of 1803-1811…)}
            </div>
          ) : (
            <>
              {runningRows.length > 0 && <div className="mb-2 flex flex-col gap-2">{runningRows}</div>}
              <SchemaInstructionsChat instructions={instructions} messageClass={msgCls} />
            </>
          )}
        </ChatDrawer>
      )}
```
   The newest-message effect (687-690) scrolls the drawer body: attach `chatRef` to the drawer's scroll container instead (`ChatDrawer` takes a `bodyRef?: RefObject<HTMLDivElement | null>`; add the prop). Stop and Send buttons: red for Stop (destructive), green for Send (positive).
5. `msgCls` keeps the bubble classes with `text-xs` → `text-secondary`.

- [ ] **Step 6: Verify** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/SchemaPanel.test.tsx src/App.test.tsx src/projectContexts/BatchExtractionsPanel.test.tsx` → pass; `grep -n "Add a generation instruction\|Generate schema" prototypes/studio/e2e/critical-flows.spec.ts prototypes/studio/e2e/interactive-*.spec.ts` names still resolve (placeholders unchanged; the pre-schema "Generate schema" button is in the drawer header).

- [ ] **Step 7: Commit** — `feat(studio): chat as a composer line that opens a drawer; the instructions chat shares it`.

---

### Task 8: Results tab: value states, review attention rows, "Values as code" (§8)

**Files:**
- Modify: `prototypes/studio/src/ui/ResultValue.tsx` (`ValueState`, `getValueState`, the three streaming markers, `RecordHeader`), `prototypes/studio/src/ui/index.ts` (exports), `prototypes/studio/src/ReviewAttention.tsx`, `prototypes/studio/src/ResultsTab.tsx:721-725` (view labels), `:740-741` (attention), `:1036-1085` (record header and `getValueState`)
- Test: `prototypes/studio/src/ResultValue.test.tsx`, `prototypes/studio/src/ResultsTab.test.tsx` (six "Raw JSON" lookups), `prototypes/studio/src/RightRail.test.tsx:150-151`, `prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts:420, 618, 691, 710`

**Interfaces:**
- Produces: `export type ValueState = 'grounded' | 'checking' | 'reading' | 'queued' | 'empty' | 'contested'` and `ResultValueProps.getValueState?: (path: ResultPath) => ValueState | undefined` (threaded through `ObjectSection`/`ArraySection` like `getEvidenceAnchorId`); `export function RecordHeader({ label, page }: { label: string; page: number | null })`; the Results view tabs read "Review", "Values as code", "Markdown" (ids unchanged); `ReviewAttention` renders `details > summary` "Review attention · n to check", a `SegmentedControl` labelled "Review attention" with Required · Ungrounded · Missing · All, and one row per cell with an "Edit field" button. The streaming spec populates `checking`, `reading` and `queued`; this task only styles them.

- [ ] **Step 1: Write the failing tests.** In `src/ResultValue.test.tsx` (follow its render helper):

```tsx
describe('value states (redesign §8)', () => {
  const states = (state: ValueState) => ({ getValueState: () => state })
  it('reading shows a placeholder and never text', () => {
    render(<ResultValue name="title" value="not yet" path={['title']} {...states('reading')} />)
    expect(screen.queryByText('not yet')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Reading')).toBeInTheDocument()
  })
  it('checking shows the candidate muted with a hollow marker', () => {
    render(<ResultValue name="title" value="Candidate" path={['title']} {...states('checking')} />)
    const value = screen.getByText('Candidate')
    expect(value.className).toMatch(/text-ink-muted/)
    expect(screen.getByTitle('Candidate · being verified')).toBeInTheDocument()
  })
  it('queued shows a line marker and the name only', () => {
    render(<ResultValue name="title" value={null} path={['title']} {...states('queued')} />)
    expect(screen.getByLabelText('Queued')).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
  })
  it('grounded, empty and contested render as before', () => {
    render(<ResultValue name="title" value="Report" path={['title']} {...states('grounded')} getEvidenceAnchorId={() => 'a1'} onSelectEvidence={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'View Evidence for title' })).toBeInTheDocument()
    cleanup()
    render(<ResultValue name="title" value={null} path={['title']} {...states('empty')} />)
    expect(screen.getByText('Missing')).toBeInTheDocument()
    cleanup()
    render(<ResultValue name="title" value={null} path={['title']} {...states('contested')} getContested={() => ['a', 'b']} />)
    expect(screen.getByText('Contested')).toBeInTheDocument()
  })
  it('a record header names the record and its page', () => {
    render(<RecordHeader label="Record 3" page={6} />)
    expect(screen.getByText('Record 3')).toBeInTheDocument()
    expect(screen.getByText('· page 6')).toBeInTheDocument()
  })
})
```

In `ResultsTab.test.tsx` the six `getByRole('tab', { name: 'Raw JSON' })` become `{ name: 'Values as code' }`; add a case: with an attention fixture (reuse the fixture of the RightRail case at 120-158), the summary reads "Review attention · 1 to check", the "Required" segment is pressed, rows show `Record 1 · title` with a pill "to check" and an "Edit field" button, and choosing "All" lists every cell. `RightRail.test.tsx:150-151`: `getByText(/Review attention · 1 to check/)` then `getByRole('button', { name: 'Edit field' })`.

- [ ] **Step 2: Run them to verify they fail** — `pnpm -C prototypes/studio exec vitest run src/ResultValue.test.tsx src/ResultsTab.test.tsx src/RightRail.test.tsx` → FAIL.

- [ ] **Step 3: `ui/ResultValue.tsx`.** Add after `ClaimStatusNote`:

```ts
/** The six per-value states of §8: this component styles them; the settled attempt supplies grounded, empty and
 *  contested, the streaming view later supplies checking, reading and queued. */
export type ValueState = 'grounded' | 'checking' | 'reading' | 'queued' | 'empty' | 'contested'
```

`ResultValueProps` gains `getValueState?: (path: ResultPath) => ValueState | undefined`; `ObjectSection` and `ArraySection` accept and forward it; `ResultValue` passes `state={getValueState?.(path)}` to `PrimitiveRow`, which gains `state?: ValueState`. In `PrimitiveRow`, before the `editing` branch:

```tsx
  if (state === 'reading' || state === 'queued') {
    return (
      <div className="-mx-2 grid grid-cols-[14px_minmax(7rem,max-content)_minmax(0,1fr)] items-center gap-x-2 rounded-[3px] px-2 py-1.5">
        <span className="w-3.5 shrink-0" />
        <span className={`font-mono text-content font-medium ${state === 'queued' ? 'text-ink-muted' : 'text-ink'}`}>{name}</span>
        {state === 'reading'
          ? <span role="img" aria-label="Reading" className="h-3 w-24 animate-pulse rounded-sm border border-dashed border-line-strong" />
          : <span role="img" aria-label="Queued" className="h-px w-16 bg-line-strong" />}
      </div>
    )
  }
```

and in the non-expanded value span, when `state === 'checking'`: render `<span className="flex min-w-0 items-center gap-1.5 text-content leading-snug text-ink-muted" title="Candidate · being verified"><span aria-hidden="true" className="size-2 shrink-0 rounded-full border border-ink-muted" /><span className="min-w-0 line-clamp-2">{text}</span></span>` instead of the plain text (the `text` node keeps the same `className` match the test expects: put `text-ink-muted` on the outer span and query the inner by text — adjust the test's `className` assertion to the element's closest `[title]` if needed). Add at the end of the file:

```tsx
/** A record's heading in a Catalog result: its label and the page its first Evidence names. */
export function RecordHeader({ label, page }: { label: string; page: number | null }) {
  return (
    <p className="flex items-baseline gap-2 px-2 pt-2 text-secondary font-semibold text-ink">
      <span>{label}</span>
      {page !== null && <span className="text-compact font-medium text-ink-muted">· page {page}</span>}
    </p>
  )
}
```

Export `RecordHeader` and `type ValueState` from `ui/index.ts`. Convert this file's `text-[13.5px]` to `text-content`, `text-[11.5px]`/`text-[11px]` to `text-compact`, `text-[10.5px]`/`text-[10px]` to `text-overline` (pills keep `text-overline`).

- [ ] **Step 4: `ReviewAttention.tsx`**

```tsx
import { useState } from 'react'
import type { reviewAttention } from 'extraction/review-attention'
import { resultPathKey } from '../shared/groundedExtraction'
import { Button, Pill, SegmentedControl } from './ui'

type Filter = 'required' | 'ungrounded' | 'missing' | 'all'

/** The values that still need the researcher: required decisions first, then the optional attention (ungrounded,
 *  missing), each row a path, its state and a way to the field. */
export function ReviewAttention({ attention, onSelect, onEditField }: {
  attention: ReturnType<typeof reviewAttention>
  onSelect: (path: (string | number)[]) => void
  onEditField?: (nodeId: string, path: (string | number)[]) => void
}) {
  const [filter, setFilter] = useState<Filter>('required')
  const cells = attention.cells.filter((cell) =>
    filter === 'all' || (filter === 'required' ? cell.presence === 'grounded' && !cell.decision : cell.presence === filter))
  return (
    <details className="border-b border-line px-3 py-2 text-secondary">
      <summary className="cursor-pointer font-semibold text-ink">Review attention · {attention.requiredRemaining} to check</summary>
      <p className="mt-1 text-compact text-ink-muted">
        {attention.grounded} grounded · {attention.ungrounded} ungrounded · {attention.missing} missing. Missing and ungrounded values are optional attention; they do not block finalization.
      </p>
      <SegmentedControl className="mt-2" aria-label="Review attention" value={filter} onChange={setFilter}
        options={[{ value: 'required', label: 'Required' }, { value: 'ungrounded', label: 'Ungrounded' }, { value: 'missing', label: 'Missing' }, { value: 'all', label: 'All' }]} />
      <ul className="mt-2 flex flex-col gap-1">
        {cells.map((cell) => (
          <li key={resultPathKey([...cell.resultPath])} className="flex items-center gap-2">
            <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-compact text-ink outline-none hover:text-accent"
              onClick={() => onSelect([...cell.resultPath])}>
              Record {Number(cell.resultPath[1]) + 1} · {cell.resultPath.slice(2).join(' / ')}
            </button>
            <Pill tone={cell.decision ? 'success' : cell.presence === 'grounded' ? 'accent' : 'neutral'}>
              {cell.decision ? cell.decision.action.toLowerCase() : cell.presence === 'grounded' ? 'to check' : cell.presence}
            </Pill>
            {onEditField && <Button onClick={() => onEditField(cell.nodeId, [...cell.resultPath])}>Edit field</Button>}
          </li>
        ))}
        {cells.length === 0 && <li className="text-ink-muted">Nothing in this view.</li>}
      </ul>
    </details>
  )
}
```

- [ ] **Step 5: `ResultsTab.tsx`**: `resultViewTabs` label `'Raw JSON'` → `'Values as code'`; pass `getValueState` to each `<ResultValue>` (1038-1083):

```tsx
                    getValueState={(path) => {
                      const key = JSON.stringify(path)
                      if (evidenceLinkByPath.has(key)) return 'grounded'
                      if (contestedByPath.has(key)) return 'contested'
                      const value = getAtPath(displayResult, path)
                      return value === null || value === undefined || value === '' ? 'empty' : undefined
                    }}
```

and, when the view is inside one record of several (`articleRecords && articleRecords.length > 1 && navPath.length === 1 && /^\d+$/.test(navPath[0]!)`), render `<RecordHeader label={singularItemLabel('records', Number(navPath[0]))} page={recordPage} />` above the entries, where `recordPage` is `evidencePages?.get(firstLink.evidenceAnchorId) ?? null` for the first evidence link whose `resultPath` starts `['records', Number(navPath[0])]`. Convert the file's `text-[11px]`/`text-[11.5px]` to `text-compact` and `text-[13px]`/`text-[13.5px]` to `text-content` in the lines this task touches.

- [ ] **Step 6: e2e** `canonical-evidence-lifecycle.spec.ts:420, 618, 691, 710`: `{ name: 'Raw JSON' }` → `{ name: 'Values as code' }`. Grep `e2e` for `Review attention`, `Edit this field` and `required decisions remaining` (the last is the Review progress line, unchanged) and update any ReviewAttention lookups.

- [ ] **Step 7: Verify** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/ResultValue.test.tsx src/ResultsTab.test.tsx src/RightRail.test.tsx src/App.test.tsx` → pass.

- [ ] **Step 8: Commit** — `feat(studio): results tab value states, review-attention rows and Values as code`.

---

### Task 9: The import dialog (§9)

**Files:**
- Modify: `prototypes/studio/src/SchemaImport.tsx`, `prototypes/studio/src/SchemaPanel.tsx` (the always-mounted `<SchemaImport>`, the menu's first item, the empty state's second action), `prototypes/studio/src/SchemaImport.test.tsx`, `prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts:942-947`
- Test: `prototypes/studio/src/SchemaPanel.test.tsx` (one new case)

**Interfaces:**
- Consumes: `ModalDialog`, `Button variant="positive"`, `fieldTypeWords` (Task 6), `defaultSchemaName` (Task 3), `ActionItem` (Task 3).
- Produces: `SchemaImport({ schema, disabled, open, onClose, onImported? })` renders nothing while `!open`; dialog `aria-label="Import from Excel codebook"`; the file input is `input[type=file][aria-label="Excel codebook file"]` (`sr-only`, focusable) behind a `Button` "Choose workbook…"; the other control labels are unchanged (`Import worksheet`, `Header row`, `Preview worksheet`, `Imported record description`, `Nesting separator`, `Column <n> name/type`, the confirm label); the footer has `Cancel` and the positive confirm button; the menu item and empty-state action read "Import from Excel codebook…".

- [ ] **Step 1: Write the failing tests.** Rewrite `SchemaImport.test.tsx`'s `upload` helper to use `getByLabelText('Excel codebook file')`, render `<SchemaImport schema={schema} disabled={false} open onClose={onClose} onImported={onImported} />`, replace `Cancel import` with `Cancel` (asserting `onClose` was called and `initialize` not), and after the confirm assert `onImported` and `onClose` were each called once and the dialog (`getByRole('dialog', { name: 'Import from Excel codebook' })`) was rendered. Add a layout assertion: the columns render in `role="table"` with the column headers `Include`, `Name`, `Type`, `Allowed values`, `Examples`, and the preview lists `identifier — string` instead of a `<pre>`. In `SchemaPanel.test.tsx`, Task 3's header case asserts the menu items as a four-item list: make it `['Import from Excel codebook…', 'Edit as code', 'History', 'Regenerate from the document…', 'Clear schema']`. Then add: "the actions menu opens the import dialog" (menu → `Import from Excel codebook…` → `getByRole('dialog', { name: 'Import from Excel codebook' })`; the empty state also offers the action when `noSchema`).

- [ ] **Step 2: Run them to verify they fail** — FAIL (no dialog, old labels).

- [ ] **Step 3: `SchemaImport.tsx`.** Keep every piece of state and `preview`/`close`/confirm logic; change the shell:

```tsx
export function SchemaImport({ schema, disabled, open, onClose, onImported }: {
  schema: SchemaEditorController; disabled: boolean; open: boolean; onClose: () => void; onImported?: () => void
}) {
  …existing state…
  const fileInput = useRef<HTMLInputElement>(null)
  const project = schema.operationScope()?.projectContextId
  if (!project || !open) return null
  const dismiss = () => { close(); onClose() }
  return (
    <ModalDialog ariaLabel="Import from Excel codebook" onDismiss={dismiss} dismissDisabled={busy}
      className="m-auto w-[calc(100%-2rem)] max-w-2xl rounded-card border border-line bg-surface p-4 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]">
      <h2 className="text-content font-semibold">Import from Excel codebook</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-secondary">
        <Button onClick={() => fileInput.current?.click()} disabled={disabled || busy}>Choose workbook…</Button>
        <input ref={fileInput} className="sr-only" type="file" accept=".xlsx" aria-label="Excel codebook file" disabled={disabled || busy}
          onChange={(event) => { const upload = event.target.files?.[0]; if (!upload) return; close(); base.current = schema.snapshot().draftVersion; setFile(upload); void preview(upload, null); event.target.value = '' }} />
        <span className="min-w-0 truncate text-ink-muted">{file ? file.name : 'An .xlsx workbook of at most 5 MiB'}</span>
      </div>
      {file && (<>
        <p className="mt-2 text-compact text-ink-muted">The workbook and column data are transient. Closing or reloading an unconfirmed preview requires re-upload.</p>
        <div className="mt-2 flex flex-wrap items-end gap-3 text-secondary">
          <label className="flex items-center gap-1">Worksheet <select aria-label="Import worksheet" …as today… /></label>
          <label className="flex items-center gap-1">Header row <input aria-label="Header row" …as today… className="w-16 …" /></label>
          <Button disabled={!worksheet || busy} onClick={() => void preview(file, worksheet)}>Preview worksheet</Button>
        </div>
        {columns.length > 0 && (<fieldset disabled={busy} className="mt-3 flex flex-col gap-2 text-secondary">
          <label>Record description <input aria-label="Imported record description" … /></label>
          <label>Nesting separator <input aria-label="Nesting separator" … /></label>
          <p className="text-compact text-ink-muted">Flat mode keeps separators literal. In nested mode rename literal separators into unambiguous paths. Types are hints; allowed values require choosing each field.</p>
          <table className="w-full text-compact"><thead><tr className="text-left text-overline font-bold uppercase tracking-[0.12em] text-ink-muted">
            <th className="py-1">Include</th><th>Name</th><th>Type</th><th>Allowed values</th><th>Examples</th></tr></thead>
            <tbody>{columns.map((column, index) => { const update = …as today…; return (
              <tr key={column.id} className="border-t border-line align-top">
                <td className="py-1"><input type="checkbox" aria-label={`Include column ${column.column}`} checked={column.include} onChange={(event) => update({ include: event.target.checked })} /></td>
                <td><input aria-label={`Column ${column.column} name`} className="w-full rounded-[3px] border border-line px-1 font-mono" value={column.name} onChange={(event) => update({ name: event.target.value })} /></td>
                <td><select aria-label={`Column ${column.column} type`} …as today… /></td>
                <td><label className="flex items-start gap-1"><input type="checkbox" disabled={column.choices.length < 2} checked={column.enum ?? false} onChange={(event) => update({ enum: event.target.checked, type: 'string' })} /><span className="min-w-0 truncate" title={column.choices.join(', ')}>{column.choices.length} values</span></label></td>
                <td className="text-ink-muted">{column.kinds.join(', ')} · suggested {column.suggestedType} · {column.examples.join(' | ')}</td>
              </tr>) })}</tbody></table>
          {validation && <p role="alert" className="text-danger">{validation}</p>}
          {definition && (<ul aria-label="Fields to import" className="rounded-[3px] border border-line bg-canvas p-2 font-mono text-compact">
            {definition.schemaNodes.map((node) => <li key={node.id}>{node.name} — {fieldTypeWords(node)}</li>)}</ul>)}
        </fieldset>)}
      </>)}
      {error && <p role="alert" className="mt-2 text-compact text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={dismiss} disabled={busy}>Cancel</Button>
        {file && columns.length > 0 && (
          <Button variant="positive" disabled={!definition || busy || disabled} onClick={async () => {
            if (!definition) return
            if (schema.snapshot().draftVersion !== base.current) { setError('The editor changed during preview. Close and re-upload to keep those edits.'); return }
            setBusy(true); setError(null)
            try { await schema.confirmDefinition(definition); onImported?.(); dismiss() }
            catch (error) { setError(error instanceof Error ? error.message : 'Schema could not be confirmed.'); setBusy(false) }
          }}>{schema.snapshot().extractionSchemaId ? 'Confirm as a new revision of the selected schema' : 'Confirm schema'}</Button>
        )}
      </div>
    </ModalDialog>
  )
}
```

(`Include column n` labels the checkbox; the e2e selects `Column 2 type` and fills `Imported record description` as before.)

- [ ] **Step 4: `SchemaPanel.tsx`**: `const [importOpen, setImportOpen] = useState(false)`; `const importDisabled = editorReadOnly || editing !== null || openDescId !== null || snap.generating`; menu item first: `{ id: 'import', label: 'Import from Excel codebook…', onSelect: () => setImportOpen(true), disabled: importDisabled }`; empty-state second action `<Button onClick={() => setImportOpen(true)}>Import from Excel codebook…</Button>`; replace the always-mounted `<SchemaImport …/>` (1375) with `<SchemaImport schema={schema} disabled={importDisabled} open={importOpen} onClose={() => setImportOpen(false)} onImported={() => { if (!schemaName) void onRenameSchema?.(defaultSchemaName(sourceDocumentName)) }} />` rendered beside the other dialogs.

- [ ] **Step 5: e2e** `canonical-evidence-lifecycle.spec.ts:942`: before `setInputFiles`, `await page.getByRole('button', { name: 'Schema actions' }).click(); await page.getByRole('menuitem', { name: 'Import from Excel codebook…' }).click()`, then `page.getByLabel('Excel codebook file').setInputFiles(…)`; the rest of 943-954 is unchanged.

- [ ] **Step 6: Verify** — `pnpm -C prototypes/studio typecheck && pnpm -C prototypes/studio lint && pnpm -C prototypes/studio exec vitest run src/SchemaImport.test.tsx src/SchemaPanel.test.tsx src/App.test.tsx` → pass.

- [ ] **Step 7: Commit** — `feat(studio): Excel codebook import as a dialog from the schema actions`.

---

### Task 10: The weekly journey, the documentation sweep and the full gates (Testing, Files)

**Files:**
- Modify: `prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts` (the codebook test, 936-960), `prototypes/studio/src/ui/README.md`, `prototypes/studio/DESIGN.md` (§5), `docs/superpowers/specs/2026-10-02-studio-workspace-redesign-design.md` (Status line)

- [ ] **Step 1: Extend the codebook journey** so the weekly e2e covers §Testing's browser list ("open a document, run, see 'n to check', delete and undo a field, import a codebook through the dialog"). After `await page.getByRole('button', { name: 'Review now', exact: true }).click()` (958) and before `approveRemaining`:

```ts
  // The Results badge counts what is left to check and empties once the review is saved (§4).
  await expect(page.getByRole('tab', { name: /^Results \d+ to check$/ })).toBeVisible({ timeout: 20_000 })
```

and after `await expect(page.getByText('Review saved', { exact: true })).toBeVisible(…)`:

```ts
  await expect(page.getByRole('tab', { name: 'Results', exact: true })).toBeVisible()
  // One click deletes a field; Undo puts it back (§6).
  await page.getByRole('tab', { name: /^Schema/ }).click()
  const titleRow = page.getByRole('listitem', { name: 'title' })
  await titleRow.hover()
  await titleRow.getByRole('button', { name: 'Delete title' }).click()
  await expect(page.getByRole('listitem', { name: 'title' })).toHaveCount(0)
  await expect(page.getByRole('status').filter({ hasText: 'Field removed' })).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('listitem', { name: 'title' })).toBeVisible()
  await expect.poll(async () => (await db.orm.public.SchemaRevision.where({ extractionSchemaId }).select('id').all()).length).toBe(4)
```

(The delete and the restore each save a revision after the debounce; if the count differs because the save coalesces, assert `>= 3` and say so in the report.) The tab's accessible name is "Results" plus the badge text; check the exact rendering with `toHaveAccessibleName` if the regex does not match.

- [ ] **Step 2: Documentation.** `src/ui/README.md`: add rows for `Toast` ("Transient notice with one optional action, e.g. Undo") and `ModalDialog`/`DeleteDialog` if missing; replace the last paragraph ("The studio app does not yet consume these primitives…") with "The workspace consumes `Button`, `Pill`, `SegmentedControl`, `EmptyState`, `ModalDialog`, `Toast` and `ResultValue`; the remaining inline patterns live in the project pages." `DESIGN.md` §5: add "Toast — message plus one optional action; float shadow; eight seconds when an action is offered, 2.6 s otherwise" and "Field row — 30px: grip, disclosure, mono name (never truncated by its metadata), type and values pills, actions revealed on hover and focus-within". The spec's Status line: `Status: implemented on feat/studio-workspace-redesign (plan 2026-10-03)`.

- [ ] **Step 3: Gates.** `pnpm -C prototypes/studio typecheck`, `pnpm -C prototypes/studio lint`, `pnpm -C prototypes/studio test` (the whole unit suite), then the deterministic Playwright journeys on the local stack: `pnpm -C prototypes/studio exec playwright test canonical-evidence-lifecycle.spec.ts project-navigation.spec.ts critical-flows.spec.ts schema-order-lifecycle.spec.ts` and `pnpm -C prototypes/studio exec playwright test --config playwright.recovery.config.ts interactive-reload.spec.ts interactive-restart.spec.ts` (Docker and a free `free-studio-e2e` compose project are required, as the removal plan's run used; `real-application-route.spec.ts` runs only in the Baratheon kit at PR time). A final grep: `grep -rn "text-\[9px\]\|text-\[9.5px\]\|text-\[13.5px\]\|Raw JSON\|nyt_felt\|hintText\|variant=\"primary\"" prototypes/studio/src` → nothing in the files this plan touches.

- [ ] **Step 4: Commit** — `test(studio): weekly journey covers the badge, delete with undo and the import dialog; docs for the redesign`.

---

## Self-review

**Spec coverage.** §1 frame and tab strip → Task 4 (monogram, project chip, breadcrumb removed, slot = save state + run). §2 run action → Task 4 (positive button, re-read saved method, `method_changed` retry once, disabled reasons, boundaries moved → Task 3's header). §3 document region → Task 4 (edge to edge, 34px toolbar, pager, hint pill removed) and Task 5 (thumbnail rail). §4 right rail → Task 4 (`resultsBadgeFor`), Schema badge unchanged. §5 schema header → Task 3 (name in h2, Fields | Code, menu, scope line, description, footer, empty state, default names) and Task 9 (import item). §6 field rows → Task 6. §7 chat → Task 7. §8 results → Task 8. §9 import → Task 9. §10 colour and type → Task 1. §11 copy → Tasks 3, 4, 6, 8, 9. Error handling → Tasks 5 (thumbnail failure), 6 (undo conflict), 4 (double refusal). Testing → each task plus Task 10's journey.

**Placeholders.** None: every step carries its code or the exact edit; where a line number may drift, the step names the text to find.

**Type consistency.** `ValueState` (Task 8) matches the spec's six states; `resultsBadgeFor` (Task 4) is the one source for the Results badge and the run button; `recordScope`/`boundaries` props keep the same names from `SchemaPanel` (Task 3) through `RightRail` to `App` (Task 4); `ThumbnailRenderer` (Task 5) is the only thumbnail contract; `ActionItem`/`ActionsMenu` (Task 3) serve the schema header and the project chip (Task 4); `restoreSchemaNode` (Task 6) is the undo primitive.

**Review Focus.** Each line is pinned to a test in its task: saved-method read failure (Task 4, the retry test's sibling: make `saved.refresh` resolve `null` once and assert the toast "Saved advanced settings could not be read. Nothing was started." — add that case beside the `method_changed` test), undo conflicts (Task 6), thumbnail failures (Task 5), the pager's invalid input (Task 4), the collapsed pending proposal (Task 7).
