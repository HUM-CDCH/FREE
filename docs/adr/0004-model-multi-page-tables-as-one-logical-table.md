<!-- markdownlint-disable MD013 -->

# Model multi-page tables as one logical table

> **Accepted.** This decision defines the `parsed_document.v2` table and
> Evidence contract, which the strict decoder in
> [`packages/extraction/src/parsed-document.ts`](../../packages/extraction/src/parsed-document.ts)
> enforces. Since the parser replacement in
> [0009](0009-own-parsing-and-extraction-service-in-free.md), the producer,
> [`apps/studio/api/_kei_exp.ts`](../../apps/studio/api/_kei_exp.ts), emits
> page-local tables only: the decoder accepts a derived continuation, but none
> is produced.

A table that continues across physical pages is one derived logical table with
page-scoped Evidence. Docling records remain page-local; the runtime does not
assume a multi-page producer object.

Every canonical cell owns exactly one table-cell Evidence anchor. The anchor
contains derived logical row/column identity and every ordered producer
occurrence, each with a stable occurrence ID, physical page, producer ref,
page-local offsets, observed spans, and a finite, ordered, page-bounded bbox in
displayed top-left physical-page space. Canonical cells do not contain nested
Evidence. Page spans contain page/range/producer identity only and never repeat
anchor IDs. Producer geometry that cannot be normalized safely is not
published; canonical v2 rejects a geometry-less occurrence.

Continuation requires reviewed producer-backed structure: matching page-local
OTSL matrices, a header-bearing first fragment, a body-only next fragment, and
page-break-only interstitial content. Narrative, captions, new headers,
malformed observations, adjacency, textual similarity, geometry, and generated
IDs cannot establish continuation.
