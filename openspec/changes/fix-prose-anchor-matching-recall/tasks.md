# Fix Prose Anchor Matching Recall

- [ ] Resolve ambiguous duplicate prose anchor matches, e.g. `records.6.finds.2.*` where the same snippet occurs twice in the scoped segment and both occurrences have anchor coverage.
- [x] Investigate and fix prose terms that are found in canonical Markdown but have no anchor coverage, e.g. `records.2.description`, `records.2.dimensions`, `records.2.orientation`, and `records.2.depth`.
- [ ] Root-fix the parsing service anchor coverage gap behind the `records.2.*` fallback: inspect DocTags/location tokens around the page-2 tail (`Beskrivelse: Efter endelig blotlægning... i en dybde a ca. 30 cm.`), determine whether Docling omitted `<loc_...>` tokens or `doctags_to_markdown.py` dropped/misaligned them, and make `evidence_index.anchors` cover that canonical Markdown range after re-parsing.
- [ ] Add tolerant matching or fallback for model snippets that are not exact canonical Markdown substrings, e.g. `records.0.skeleton.description`.
