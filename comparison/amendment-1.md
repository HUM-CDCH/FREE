# Amendment 1 (sealed before any counted run)

Found from the H1/Q pilot capture, the only execution so far: in the B1 schema, `title`, `doi` and `year` carry
`valueSource: document`. Article reads document-sourced fields through `assembly.document_values` and reconciles
them with `contexts.reconcile_values`; they never reach `resolution.resolve`, which settles record fields only. The
protocol's scalar measures (value retention, unopposed scalars removed by NONE, scalars printed several times)
would then measure nothing.

Change: the three fields lose `valueSource: document`, so they are record fields of the Article root, as the
title and author fields of ADR 0019's measurement were. Their names, types and descriptions, the record
description, `sample_records` and every other setting are unchanged. Every paper and condition, H1/Q included, runs
once under this schema. The H1/Q pilot (original schema, list only: 4 assembled items, 2 kept) is not counted.

Nothing else in the protocol or acceptance criteria changes.
