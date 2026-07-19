<!-- markdownlint-disable MD013 -->

# Model multi-page tables as one logical table

FREE will represent a table that continues across physical pages as one logical
table with page-scoped Evidence, rather than as unrelated page-local tables or a
first-page-only table. This belongs in `parsed_document.v2` after a real Docling
fixture proves the required shape; version 1 will retain text and structure but
suppress misleading geometry and warn when it detects multi-page Evidence. The
single logical identity preserves table meaning and avoids forcing downstream
extraction to reconstruct continuation relationships, while page-scoped
Evidence keeps every cell or fragment grounded in its physical page. The dependent [`publish-parsed-document-v2`](../../openspec/changes/publish-parsed-document-v2/proposal.md) change specifies the surrounding contract but leaves the exact page-fragment fields blocked until that fixture is inspected.

The logical table is also the sole semantic table authority used to render
canonical Markdown. Docling supplies canonical content, structure, roles, and
proven spans. Camelot may add missing geometry only after an exact semantic
match, or act as an explicitly attributed fallback when no Docling inventory is
available. Content, structure, and geometry attribution remain separate so a
geometry-only enrichment cannot claim ownership of table meaning; parser
conflicts remain diagnostics rather than competing canonical tables.
