## Context

Catalog extraction already attaches backend-generated `source_scope` metadata to
Evidence leaves. The frontend currently resolves prose anchors exclusively from
`snippet`, accepts only Evidence leaves whose `value` is a string, and paints
every resolved rectangle independently. Consequently, numeric and boolean
results can be omitted despite valid evidence, an incomplete snippet can fail
to highlight an otherwise verbatim result, and coincident rectangles compound
canvas opacity.

The schema template identifies `verbatim-string` leaves. `result` and
`evidence` share a mirrored tree, while Evidence keeps `value`, `snippet`,
`page`, table headers, and source scope. This change uses those three inputs
together without adding provenance to the displayed result.

## Goals / Non-Goals

**Goals:**

- Resolve verbatim-string prose from the visible result value within its source
  scope, using the Evidence snippet only to validate or recover the location.
- Keep snippet-led resolution for values that can be normalized or summarized.
- Use result value plus table headers and source scope for table-cell matching.
- Accept every non-empty primitive result type with usable Evidence metadata.
- Paint a coincident resolved rectangle at most once per render pass.

**Non-Goals:**

- Reintroducing PDF text-layer or document-wide fallback searches.
- Changing extraction prompts, result JSON, Evidence persistence, or model
  provider behavior.
- Inferring a schema leaf type from the result value when schema metadata is
  unavailable.
- Guaranteeing a highlight when neither the primary term nor scoped Evidence
  context can identify one unambiguous source location.

## Decisions

### Build match instructions from result, Evidence, and schema in lockstep

`buildHighlights` will traverse the mirrored result and Evidence trees while
consulting the corresponding schema leaf. A usable Evidence leaf creates a
Highlight for any non-empty primitive result, preserving the visible result
text, Evidence snippet, headers, page hint, and source scope.

For a schema leaf typed `verbatim-string` whose result is a non-empty string,
the Highlight uses `result-primary` strategy. All other primitive values use
`snippet-primary`.

This relies on explicit schema intent rather than guessing from a string's
appearance. Treating all strings as verbatim was rejected because names,
summaries, and normalized strings are frequently not literal PDF text.

### Resolve prose only inside deterministic source scope

For `result-primary`, the anchor matcher searches the result text within the
scope's Markdown offsets. One unambiguous anchored occurrence resolves
directly. If zero or multiple result occurrences are resolvable, it attempts
the Evidence snippet in the same scope as conditional context; a unique
context match may be used as the fallback location. It never searches outside
the scope.

For `snippet-primary`, the matcher searches only the Evidence snippet inside
the same scope. Source scope remains mandatory for all production matches.

Using a unique scoped snippet as fallback preserves useful highlights for
minor result/source divergence without allowing a duplicate elsewhere in the
document to win.

### Prefer result-led table matching with Evidence disambiguators

Table matching always begins with the visible result value. It confines
candidates to the Evidence page range and uses `row_header` and
`column_header` to disambiguate. The snippet is supporting context only and
does not authorize a cell outside the scope or header-compatible candidates.

The existing occurrence-order and sibling-table voting remain last-resort
tie-breakers within the already scoped candidate set.

### Build segment-owned geometry before parallel resolution

Before a segment resolves highlights, the frontend derives its local geometry
from the deterministic `source_scope`. Prose receives anchors overlapping the
scope's Markdown range. The parsing service links each table's geometry to a
unique canonical Markdown range on its physical page and persists that range.
The frontend receives only tables whose persisted range lies within the source
scope; an unlinked table is excluded rather than guessed from its page number.

The highlighter resolves independent segment geometry inputs with bounded
concurrency and collects their entries in result traversal order before the
single canvas paint pass. Model-provided Evidence `page` remains diagnostic
metadata and SHALL not narrow a scoped table candidate set.

### Render cross-page prose as fragments

An anchor match returns one unioned bbox per covered PDF page. The highlighter
converts every fragment independently, caches all of them under the same
result path, paints each page fragment in traversal order, and focuses the
first fragment.

### De-duplicate paint geometry, not logical highlights

Resolution retains every logical Highlight so result focus and tracing paths
remain intact. Before each canvas draw, entries with the same page, rendered
rectangle, and color are coalesced in traversal order; the first entry owns
the physical fill. Focused drawing applies the same coalescing, so repeated
renders cannot compound alpha for an identical mark.

Coalescing only after resolution avoids changing matching behavior and keeps
different colors visible when distinct fields intentionally share a location.

## Risks / Trade-offs

- [A verbatim result appears more than once within one section] -> The scoped
  snippet context must uniquely resolve it; otherwise no highlight is drawn.
- [Schema and result/evidence shapes drift] -> Traverse defensively and omit
  only the unverifiable leaf; add mixed primitive/nested tree tests.
- [A summarized string is incorrectly declared `verbatim-string`] -> Scoped
  snippet fallback may recover context, but no global search is allowed.
- [Several logical highlights share exact geometry] -> Coalescing prevents
  opacity buildup but means same-color duplicates receive one visible fill.
- [A table Markdown view cannot be placed uniquely] -> Exclude it from that
  segment's table candidates; an unresolved value produces no guessed table
  highlight.

## Migration Plan

1. Extend frontend Highlight construction with an explicit match strategy.
2. Update scoped prose and table match calls to consume that strategy.
3. Coalesce duplicate paint operations in initial and focus redraws.
4. Add unit coverage, run Studio tests and build, then manually verify the
   bundled document against a cached parsing result.

Rollback consists of reverting this change's frontend-only implementation;
existing result and Evidence response shapes remain compatible.
