## Context

`extractWithModel` (`prototypes/studio/api/_model.ts`) is the single entry point for turning a Source Document + Extraction Schema into an Extraction Result. Historically it always made one model call covering the entire document. For a multi-record document (e.g. the Ellekilde field report, 7 grave sections) this forces the model to disambiguate every record's fields from one large context window, and it forces the frontend's PDF evidence search to disambiguate repeated values/snippets across the whole document with no record-scoping at all.

The historical FREE-technical prototype split this into two explicit strategies the researcher chose per schema: **Catalog** (boundary-detect the document into per-record sections via a dedicated LLM call, extract each section independently, merge) and **Article** (always one whole-document call, one record, tables inlined as a text appendix). That prototype's actual pipeline code was never ported to this codebase — only a same-named, semantically unrelated `_article.ts`/`_catalog.ts` pair exists in an abandoned, never-merged branch (commit history under `24607ed`, `fc67428`, etc., none reachable from `main`).

This change independently arrived at a Catalog-shaped capability — heading-based sectioning, no boundary-detection model call — already implemented directly against the current codebase's actual template/evidence shapes (which differ from both the historical Python prototype and the abandoned TS branch). What's missing is the Article/Catalog *choice*: today, sectioning is purely auto-heuristic (schema shape + heading recurrence), with no way for a researcher to say "this is one continuous document, never section it" or "this is a records catalog, sectioning should apply."

## Goals / Non-Goals

**Goals:**
- Document why heading-based sectioning is a safe, lightweight stand-in for the historical LLM boundary-detection pass, and its actual limits.
- Specify how an explicit Catalog/Article classification should be restored, bound to the schema itself (this codebase has no schema-library/persistence layer to bind it to instead).
- Give the follow-up implementation task(s) enough of a contract that `/opsx:apply` doesn't need to re-derive these decisions.

**Non-Goals:**
- Re-implementing the historical LLM-based boundary-detection call. Section boundaries stay heading-derived and deterministic.
- A schema-library/save-and-recall feature. Strategy lives as in-memory `App.tsx` state scoped to the current schema (see Decision 5), not persisted anywhere.
- Handling schemas that mix a document-level scalar field alongside the repeated array (`findPrimaryArrayKey` already excludes these from sectioning; unchanged by this proposal).
- Changing `SchemaNode[]`'s type or `schemaNode.ts`'s conversions — Decision 5's correction found a path that needs neither.

## Decisions

### 1. Section boundaries come from recurring Markdown heading *shape*, not every heading, and not an LLM call

`doctags_to_markdown.py` already renders Docling's `<section_header_level_N>`/`<title>` doctags as real `#`/`##` Markdown headings — confirmed against the checked-in `test-fixtures/ellekilde-8-13.md` fixture, where every grave ("Grav 8", "Grav 13", ...) is its own level-1 heading. But the same fixture also contains 4 *spurious* level-1 headings mid-record (Docling mis-detection, e.g. "# Skelet:"), so splitting on every "# " line would fragment real records.

`headingShape()` (`_catalog_sections.ts`) normalizes each heading (lowercase, strip digits, strip punctuation) and `dominantHeadingShape()` picks whichever shape recurs most often (≥2 times); only headings matching that shape become section boundaries. Verified against the real fixture: 11 level-1 headings → exactly the 7 true "Grav N" boundaries survive.

**Alternative considered**: port the historical LLM boundary-detection call (`call_top_level_boundary_detection`) verbatim. Rejected for this change — it requires a new backend prompt/endpoint and a second model round-trip per extraction, and the researcher explicitly asked for something lighter given Markdown is already in hand.

### 2. Absolute page numbers are computed deterministically, not reported by the model

A per-section model call only sees that section's own text, so it cannot know its absolute position in the document; any "page" number it reports is section-relative at best. `pageForOffset()` counts the parsing service's `\n\n---\n\n` page-break sentinel (identical to the historical `_PAGE_BREAK` constant) up to a given Markdown offset, and `offsetPageNumbers()` adds each section's own starting-page offset to every `page` leaf in that section's evidence. This is strictly more reliable than the old whole-document flow, where the model had to count page breaks itself across the entire document.

### 3. Sections run concurrently via the existing `runWithConcurrencyLimit` helper, not a new one

`_model.ts` already had a concurrency-limited worker-pool (`runWithConcurrencyLimit`, used by `editSchemaWithModel`'s per-field calls). Reused as-is for per-section calls rather than introducing a second implementation. Cap is a plain constant (`MAX_CONCURRENT_SECTION_CALLS`); the right value depends on which model provider is configured (a local Ollama instance mostly serializes GPU work, so a low cap avoids pointless queuing; a hosted/CLI-backed provider like Claude Code is latency-bound per call, not local-compute-bound, so a higher cap has more real benefit) — this is an operational tuning knob, not re-derived per request.

### 4. Table-awareness is decided per section, not from one document-level flag

A document can have tables in some record sections and not others. Each section independently checks `sectionContainsTable()` (a GFM table-separator-row regex) and only adds the row/column-header evidence instruction when its own body actually has one — avoiding unnecessary prompt overhead/noise for sections with no table.

### 5. Restore Catalog/Article as an explicit classification (implemented)

The auto-heuristic in Decision 1 has a real false-positive mode: an Article-type document (a journal article, not a records catalog) using generic recurring section numbering ("Section 1", "Section 2", ...) has its digit-stripped heading shape collide ("section") the same way "Grav 8"/"Grav 13" collide on "grav" — so an article could be incorrectly auto-sectioned into per-"section" extraction calls, which is semantically wrong (an article's sections are topical divisions of one holistic record, not repeated record instances).

The historical prototype avoided this by never guessing: the researcher explicitly picked "Catalog" or "Article" (a `SegmentedControl` in `ResultsTab.tsx`, backed by `ExtractionStrategy = "catalog" | "article"`), bound to a saved/pinned schema (`defaultPinnedSchema.strategy`) so the choice didn't need to be repeated per run.

This codebase has no saved-schema/library concept to bind that choice to (per `CLAUDE.md`: "FREE has no persistence layer"). What shipped:
- `getExtractionStrategy(template)` (`_catalog_sections.ts`) reads a reserved `_strategy: 'catalog' | 'article'` key — parallel to `_description`, excluded from `wrapSchema`/`splitNode`/`splitEvidenceResult` (never reaches the model, never echoed back) and from `findPrimaryArrayKey`'s "sole top-level key" count.
- `extractWithModel` gates sectioning on `getExtractionStrategy(template) === 'catalog'`. Missing/`'article'`/any other value always takes the single whole-document pass, regardless of schema shape or heading recurrence — the auto-heuristic (Decision 1) is now a second, narrower gate *within* the Catalog branch, not the sole gate.
- **Correction found mid-implementation, superseding the original plan below**: `_strategy` does **not** travel through `SchemaNode[]` ↔ template conversions. `schemaNode.ts` has no root-metadata slot — `templateToNodes`/`nodesToTemplate` only attach `description` to individual field/group nodes, and `SchemaNode[]` is a bare array with nowhere to hang a whole-schema flag. Investigating this further surfaced a second, more fundamental fact: the researcher's schema (from `SchemaPanel`/`nodesToTemplate`) was never the literal top-level template `extractWithModel` receives in production anyway — `useExtraction.ts` already wraps it as `{ records: [template] }` before sending (a pre-existing convention `evidenceHighlights.ts`'s `buildHighlights` also depends on, unrelated to this change). So `_strategy` belongs beside that wrapper, not inside it: `useExtraction.ts` now sends `{ records: [template], _strategy: extractionStrategy }`, with `extractionStrategy` living as its own `App.tsx` state, reset only when a new PDF loads (see Decision 6 — it must survive schema generation, since it's chosen *before* generating and needs to still apply at extraction time). This is simpler than either alternative originally considered below and required no `SchemaNode`/`schemaNode.ts` changes at all.
- UI: a `SegmentedControl` (Catalog/Article) sits in `SchemaPanel`'s header, next to the existing Fields/JSON view toggle — not `ResultsTab` (where the historical version put it), since this codebase's results view isn't where schema-level metadata is edited.

**Alternative considered**: a per-extraction-run request parameter (mirroring the historical `strategy` field on the `/extract` request body) instead of schema-bound state. Rejected per explicit researcher decision: the choice should travel with the schema (i.e. persist across a Run/Re-run cycle without re-selecting), not be re-picked every run.

**Alternative considered**: extend `SchemaNode[]`'s type into a wrapper (`{ nodes: SchemaNode[], strategy }`) so strategy formally lives inside the schema-node data model. Rejected as more invasive than necessary once the `{records: [template]}` wrapping fact came to light — every read/write site of `SchemaNode[]` would need updating for a flag that has nothing to do with individual schema fields.

**Alternative considered**: keep the pure auto-heuristic and try to make heading-shape detection smarter (e.g. require a minimum body-length-similarity across sections, or reject generic English words like "section"/"chapter"). Rejected — schema-agnostic heuristics can always be defeated by some document's naming convention; an explicit researcher choice is a hard guarantee the heuristic can't be.

### 6. The strategy choice happens before schema generation, not just before extraction

Initially the Catalog/Article control only appeared once a schema already existed (gated on `SchemaPanel`'s `ready` state), and only affected `extractWithModel`. Feedback during implementation: the choice should be available *before* generating the schema at all, and should shape how the schema itself gets generated — a Catalog schema should describe one occurrence's shape directly (sectioned extraction supplies the repetition externally), while an Article schema follows the pre-existing guidance of modeling any genuine repeating sub-list as an array field, since nothing external repeats it.

This required: (a) moving the `SegmentedControl` out of `SchemaPanel`'s `ready`-only gate so it's visible in the idle/generating/error states too, (b) making `extractionStrategy` survive schema generation instead of resetting to `'article'` right after (it was chosen *for* that generation — resetting it would discard the researcher's own input the moment it took effect), while still resetting on a new PDF open, and (c) threading `strategy` through `generateSchemaWithModel`/`generate_schema.ts`/`api.ts`'s `requestSchema` into `_schema.ts`'s `schemaPrompt`, which now branches its "repeating unit" guidance on strategy instead of always assuming the Article-style framing.

## Risks / Trade-offs

- **[Risk]** A Catalog-marked schema whose document has no recurring heading pattern silently falls back to whole-document extraction (Decision 1's `sections.length < 2` fallback) → **Mitigation**: this is the existing, safe default behavior (identical to pre-sectioning behavior), not a new failure mode; no data loss, just no sectioning benefit.
- **[Risk]** `_strategy` as a bare top-level template key could collide with a researcher-named field called `_strategy` → **Mitigation**: reserved-key collisions already exist for `_description`; the same convention (leading underscore = schema metadata, never a real field) applies, and `_model_output.ts`'s strict per-template Zod schema would surface any accidental leakage as a validation warning.
- **[Trade-off]** Sectioning still can't help a Catalog document whose per-record identifying information depends on cross-record context the model can't see once scoped to one section (e.g. "same as the previous grave") → out of scope; the historical LLM boundary-detection pass had the same limitation once slicing happened.

## Migration Plan

No data migration (no persisted schemas to touch), but this **is** a behavior change, not a pure no-op: today, any schema that happens to qualify (single repeated array + recurring heading pattern) already gets auto-sectioned, with no `_strategy` key involved at all. Once the gate lands, those same schemas stop sectioning unless a researcher explicitly sets `_strategy: 'catalog'` — the missing-key default (Decision 5, `'article'`-equivalent behavior) is a deliberate narrowing of today's live behavior, traded for never auto-sectioning a document that shouldn't be. This should be called out in the follow-up task's PR description, not silently shipped as if nothing changed for existing users.

## Open Questions

None outstanding — UI placement (a `SegmentedControl` in `SchemaPanel`'s header) and the missing-key default (`'article'`-equivalent: never auto-section) were both resolved during implementation; see Decision 5 and the Migration Plan.
