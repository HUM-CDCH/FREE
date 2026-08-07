# Implementation plan and handoff evidence

The clean branch implements the PDF-only `parsed_document.v2` contract in four
reviewable slices:

1. strict canonical model, byte spans, producer observations, and contract
   regressions;
2. typed parser orchestration, publication, cache generation, routes, and
   deterministic package delivery;
3. strict Studio decoding and source-document Evidence navigation;
4. this specification, ADRs, parsing documentation, and final validation.

The only public document interface is
`app.models.parsed_document.ParsedDocument`. `build_canonical_generation`
returns the portable document, canonical UTF-8 Markdown bytes, and an internal
generation manifest. The manifest is the only place for cache paths, raw
artifact references, and internal digests.

Acceptance evidence:

- UTF-8 byte spans round-trip for Danish and non-BMP text;
- every producer occurrence and one Evidence anchor exist per canonical table
  cell, with no nested or duplicated Evidence;
- reviewed continuation admits the positive producer boundary and rejects
  narrative, caption, new-header, malformed, adjacency-only, and similarity-
  only boundaries;
- Docling is semantic authority, PaddleOCR is page fallback, and Camelot-only
  candidates are excluded from canonical tables;
- current task reconciliation rejects legacy shapes without migration;
- route and package JSON use one portable payload; ZIP bytes are deterministic;
- `/parsed-document` is 404 and Studio's Zod decoder rejects alternate shapes.

The branch is local only. No push or pull request is part of this handoff.
