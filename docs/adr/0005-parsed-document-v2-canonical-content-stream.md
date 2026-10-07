<!-- markdownlint-disable MD013 -->

# ParsedDocument v2 uses one canonical semantic content stream

> **Accepted.** `ParsedDocument`, decoded strictly by
> [`packages/extraction/src/parsed-document.ts`](../../packages/extraction/src/parsed-document.ts),
> is the sole public typed interface for canonical PDF ingestion. Since the
> parser replacement in [0009](0009-own-parsing-and-extraction-service-in-free.md),
> [`apps/studio/api/_kei_exp.ts`](../../apps/studio/api/_kei_exp.ts) produces it
> from the Parsing Service's result.

The typed, page-scoped semantic content stream is authoritative for ordered
content, physical pages, table placement, canonical Markdown, and text
Evidence. The renderer emits reserved page markers and records half-open
UTF-8 byte spans into the exact Markdown bytes.

The public document contains sanitized parser provenance and typed diagnostics.
Cache paths, raw parser artifacts, parser input/output refs, and internal
digests stay in the generation manifest.

Every published Evidence occurrence carries finite, ordered, page-bounded
geometry in displayed top-left physical-page space. Canonical v2 publication
fails when safe geometry is unavailable. Rotation metadata does not invalidate
already normalized displayed-page geometry; consumers repeat the bounds check
before rendering it. An occurrence that fails the check is not drawn, and Studio
never locates Evidence by matching text in the PDF.

For native PDFs, Docling supplies semantic table values and structure. OCR
runs on Surya by default, or on the model the account's Ingestion Model Choice
names. Non-PDF and URL sources are outside this contract: the
[decoder](../../packages/extraction/src/parsed-document.ts) accepts only an
uploaded PDF.
