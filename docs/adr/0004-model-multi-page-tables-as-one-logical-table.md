<!-- markdownlint-disable MD013 -->

# Model multi-page tables as one logical table

> **Accepted.** This decision defines the implemented `parsed_document.v2`
> table and Evidence contract.

A table that continues across physical pages is one derived logical table with
page-scoped Evidence. Docling records remain page-local; the runtime does not
assume a multi-page producer object.

Every canonical cell owns exactly one table-cell Evidence anchor. The anchor
contains derived logical row/column identity and one producer observation with
physical page, producer ref, page-local offsets, observed spans, and optional
geometry. Canonical cells do not contain nested Evidence. Page spans contain
page/range/producer identity only and never repeat anchor IDs.

Continuation requires reviewed producer-backed structure: matching page-local
OTSL matrices, a header-bearing first fragment, a body-only next fragment, and
page-break-only interstitial content. Narrative, captions, new headers,
malformed observations, adjacency, textual similarity, geometry, and generated
IDs cannot establish continuation.

Docling remains semantic table authority. Camelot may monotonically enrich
geometry after an exact content/structure match; Camelot-only candidates are
diagnostics and are not canonical tables.

