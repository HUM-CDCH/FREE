## 1. Segment Provenance

- [ ] 1.1 Extend Studio API Evidence source scopes with `segment_id`.
- [ ] 1.2 Assign stable Catalog and Article IDs before model calls, and retain
  them through parallel completion and empty-result filtering.
- [ ] 1.3 Add API coverage for source-scope IDs and result/evidence alignment.

## 2. Geometry Index

- [ ] 2.1 Ensure Studio parses the parsed-document table Markdown view needed
  for deterministic source placement.
- [ ] 2.2 Add a pure segment geometry index that assigns anchors and at most
  one owner segment to each table.
- [ ] 2.3 Update `EvidenceHighlightLayer` to group by `segment_id` and resolve
  only from indexed local geometry with bounded concurrency.
- [ ] 2.4 Keep scoped table matching independent of model-provided page hints.

## 3. Verification

- [ ] 3.1 Add frontend coverage for same-page segment ownership, ambiguous
  tables, out-of-order group completion, and traversal-order drawing.
- [ ] 3.2 Run Studio tests, build, and lint; record unrelated lint failures.
- [ ] 3.3 Manually verify the bundled document: later segments highlight their
  own content, same-page tables do not cross, and opacity remains stable.
