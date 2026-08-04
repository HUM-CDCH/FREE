# Fix Continuation Table Geometry Linking

- [ ] Investigate why `Grav 26` fund-list continuation rows after the Markdown `---` separator are present in canonical Markdown but missing from linked `ParsedTable` cell geometry.
- [ ] Fix table linking/canonicalization so continuation rows such as `26-11`, `26-15`, `26-16`, `26-17`, `26-23`, `26-25`, `26-26`, and `26-27` are exposed as table cells with bboxes.
- [ ] Verify those rows can be matched by `tableCellMatch` using row/column evidence hints and no longer appear in `EvidenceHighlightLayer` debug `misses`.
