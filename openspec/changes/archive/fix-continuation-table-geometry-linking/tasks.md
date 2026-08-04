# Fix Continuation Table Geometry Linking

- [x] Investigate why `Grav 26` fund-list continuation rows after the Markdown `---` separator are present in canonical Markdown but missing from linked `ParsedTable` cell geometry.
- [x] Fix table linking/canonicalization so continuation rows such as `26-11`, `26-15`, `26-16`, `26-17`, `26-23`, `26-25`, `26-26`, and `26-27` are exposed as table cells with bboxes.
- [x] Verify those rows can be matched by `tableCellMatch` using row/column evidence hints and no longer appear in `EvidenceHighlightLayer` debug `misses`.

## Implementation Plan

1. Read OpenSpec status and apply instructions for `fix-continuation-table-geometry-linking` to confirm the schema, allowed edit scope, and current task state.
2. Locate the relevant implementation by searching for `ParsedTable`, `tableCellMatch`, `EvidenceHighlightLayer`, canonical Markdown handling, bbox linking, and `Grav 26` fixtures or debug data.
3. Reproduce the issue with the smallest available fixture or test path, confirming that rows such as `26-11`, `26-15`, `26-16`, `26-17`, `26-23`, `26-25`, `26-26`, and `26-27` exist in canonical Markdown but are absent from linked table-cell geometry and reported as debug misses.
4. Identify whether the rows are lost during Markdown canonicalization, table geometry extraction/filtering, continuation segment merging, or row/column evidence matching.
5. Apply the smallest scoped fix at the linking/canonicalization boundary so continuation rows after the Markdown `---` separator are merged back into the corresponding `ParsedTable` cells with bboxes.
6. Add or update focused tests that assert the continuation rows are exposed as cells with bboxes and can be matched by `tableCellMatch` using row/column evidence hints.
7. Run the narrowest relevant verification first, then broader backend or frontend checks if the touched code path warrants it.
8. Mark the task checkboxes complete only after the fix is implemented and verified.
