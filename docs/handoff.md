# FREE — Prototype Handoff Notes

> **Date:** 2026-07-06 · **Branch:** `schema-editing` · **For:** incoming developer

---

## Target Extraction Workflow

```
LLM generates schema  →  System persists DSL/AST  →  Researcher edits schema  →  Schema diff  →  Delta extraction
      ✓ done                    ✗ not yet                     ✓ done               ✓ done (chat)     ✗ not yet
```

---

## Completed

| # | What | Notes |
|---|------|-------|
| 1 | **Evidence highlight palette** | Switched to Paul Tol's Muted (sky blue / olive / rose / teal) — distinguishable under all major colour-blindness types. `src/evidenceHighlights.ts` |
| 2 | **Highlight position fix on zoom & resize** | Highlights no longer drift after PDF zoom or window resize. Tracked via `eventBus scalechanging` + `ResizeObserver`. |
| 3 | **Result tracing** | Clicking a value in the Results panel scrolls the PDF to that location and intensifies its highlight; others dim. Click again to deselect; resets on new extraction. |
| 4 | **Schema field descriptions (nested group nodes)** | Group nodes support an optional description edited via an ℹ icon. Stored in `SchemaNode.description`; displayed in JSON view as `_description`; compiled into the NuExtract `【instructions】` slot at extraction time — the template itself stays clean. |
| 5 | **Editable JSON tab** | Schema panel JSON view has an Edit button that switches to a `textarea`, with Save / Cancel and inline parse-error feedback. |
| 6 | **Schema changes no longer retrigger highlight re-render** | `schemaTemplate` is read via ref instead of being an effect dependency, so editing the schema between extractions doesn't rerun the expensive PDF text search. |
| 7 | **Indent / outdent ghost-line artifact fix** | Empty `children` arrays no longer render a stray vertical border in the schema panel. |

---

## Open Work

### Schema Management

- [ ] **Persistence layer (DSL / AST storage)** — All annotations, schemas, and results are in-memory only; a page refresh loses everything. Needs SQLite or an in-memory store with `/annotations`, `/validations`, and `/documents/prepare` endpoints.
- [ ] **Schema version control** — Snapshot each schema revision so researchers can roll back to a prior version.
- [ ] **Delta extraction** — After a partial schema edit, re-extract only the changed fields rather than re-running the full extraction.
- [ ] **Schema field colour coding** — Surface each field's palette colour in the Fields view. Highlight colours are already assigned per top-level schema key; the fields panel doesn't reflect this yet.

### Interaction & Editing

- [ ] **Undo / redo** — Schema edit history with Ctrl+Z. Destructive actions (field delete) should show a warning / confirmation.
- [ ] **Multi-select & delete** — Click to select a field node, then bulk-delete. Currently only single-field ✗ removal exists.
- [ ] **Editable results + missing-field navigation** — Correct a value by highlighting the right text in the PDF (rather than direct text editing); missing-value badges should offer a jump-to-source action.

### UI Polish

- [ ] **More prominent highlights** — Current alpha is conservative; highlights can be hard to see on light document pages. Options: raise base alpha, add a thin outline stroke, or boost on hover.
- [ ] **Button & icon contrast** — Several `ink-muted` icon buttons (edit pencil, remove ✗) are hard to read at small sizes. Needs a contrast pass.
- [ ] **Typography refinement** — Pending comparison of options; likely involves font-weight or size-scale adjustments.

### Engineering Architecture

- [ ] **Frontend / backend separation** — Studio (React + Vite) currently hosts both the UI and the `/api` model routes. The parsing service and model service should become independently deployable.
- [ ] **LLM context management** — Every request re-sends the full document markdown. A session-level context strategy is needed to reduce token usage and latency.

---

## Open Design Questions

**"Fields" vs "Items" — terminology is confusing**
Nodes with children are called *fields*; leaf nodes are called *items*. Researchers find this unintuitive. Candidates: **Group / Field**, or **Section / Value** — whichever aligns better with the target domain vocabulary.

**How should inline page editing work?**
Should researchers be able to draw a selection directly on the PDF and immediately promote it to a schema field? This affects the core annotation → schema interaction model and needs a design decision before implementation.

---

## Codebase Map

| Area | Files |
|------|-------|
| Schema panel | `src/SchemaPanel.tsx` — node tree, drag-and-drop, inline edit, JSON view, chat |
| Highlights | `src/EvidenceHighlightLayer.tsx` + `src/evidenceHighlights.ts` — canvas rendering, position cache, focus/dim logic |
| Results panel | `src/ResultValue.tsx` + `src/ResultsTab.tsx` — result tracing, `onValueClick` prop chain |
| API client | `src/api.ts` — browser-side fetch helpers; `api/extract.ts`, `api/generate_schema.ts` — Vite model routes |
| Model calls | `api/_model.ts` — raw NuExtract prompt construction, control tokens, Ollama `/api/generate` |
| Specs | `openspec/specs/` — per-capability behaviour specs; `openspec/changes/archive/` — completed change records |
