# Fix Parsing Service Prose Anchor Coverage

- [ ] Reproduce the parsing-service anchor gap with a real document where canonical Markdown contains prose values but `evidence_index.anchors` has no coverage, e.g. page-2 prose fields such as `records.2.measurements`, `records.2.orientation`, `records.2.depth`, and `records.2.description`.
- [ ] Inspect the parsing pipeline in `prototypes/parsing_service` to locate where Markdown text is emitted without anchor spans: Docling DocTags/location tokens, `doctags_to_markdown` conversion, anchor offset mapping, or evidence-index serialization.
- [ ] Fix the root cause so prose emitted into canonical Markdown keeps source anchors whenever the parser has page geometry/location data for that text.
- [ ] Add a focused real-fixture or integration check proving the affected prose Markdown ranges now have anchor coverage in `evidence_index.anchors`.
- [ ] Keep the studio hint-page text fallback as a temporary recovery path, but confirm it is no longer needed for the fixed real examples after re-parsing.
