## Context

The Parsing Service publishes strict `parsed_document.v2`, while persisted
Source Representations still expose a reduced v1-shaped projection. Extraction
rows can carry canonical anchor IDs, but no durable Review Decision records the
physical occurrences inspected by a researcher.

## Goals / Non-Goals

**Goals:**

- Carry the strict v2 document through the retained Source Representation.
- Give every canonical occurrence a stable generation-scoped ID and one anchor
  owner.
- Persist a successful Extraction and its Review Decision atomically, then
  reopen both against the same Source Representation Revision.
- Require safe geometry for every canonical occurrence and render it in
  displayed physical-page space.

**Non-Goals:**

- Re-running model stability experiments or adding provider behavior.
- v1 projection, route aliases, migration, or copied location receipts.
- A general review workflow beyond the one accepted lifecycle slice.

## Decisions

1. `parsed_document.v2` remains the only authority. Text anchors own one
   occurrence; table-cell anchors own an ordered non-empty collection of
   producer observations. Each occurrence has a deterministic ID unique within
   the pinned generation. Page, text, and geometry remain derived fields.
2. Studio proxies and decodes the complete strict v2 DTO. It does not manufacture
   anchors or project pages into an alternate shape.
3. A Review Decision belongs to one successful Extraction and stores an anchor
   selection with optional `reviewedOccurrenceIds`. The write rejects duplicate,
   unknown, or foreign occurrence IDs before the transaction commits.
4. `ProjectStore` performs the Extraction and Review Decision write in one
   transaction and returns them from the existing exact-revision reopen read.
5. The Parsing Service and Studio decoder reject missing, non-finite,
   unordered, or out-of-page Evidence geometry. The browser resolver joins by
   pinned representation generation, anchor ID, and owned occurrence ID,
   repeats the bounds check, and renders valid displayed-page geometry even
   when the physical page is rotated. Producer geometry that cannot be safely
   normalized is suppressed before publication; v2 does not publish a
   geometry-less canonical occurrence.
6. One Playwright test uses the checked-in Ellekilde semantic golden plus the
   fixed accepted row `24-1` output. The raw model audit report is not a fixture
   or runtime dependency.
7. The model reads the canonical content with a short citation label per
   published anchor (`E1`, `E2`, …) rather than the 71-character anchor ID,
   which a local model echoes back mangled. Labels resolve to anchor IDs by
   exact lookup within the pinned generation, so an unpublished label yields no
   Evidence and no text is ever matched back to the PDF.
8. The browser posts the Schema Revision the extraction was produced with, and
   the write pins it rather than reading a Schema head that may have advanced.

## Risks / Trade-offs

- **Contract churn in active v2 work** → replace the singular producer
  observation now; no compatibility layer.
- **A partially persisted review** → one database transaction owns both rows.
- **Unsafe PDF coordinates** → fail closed at publication or strict decoding;
  repeat the bounds check before rendering.
