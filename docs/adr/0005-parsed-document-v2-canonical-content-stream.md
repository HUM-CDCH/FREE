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
Evidence. The renderer separates blocks and pages with blank lines and records
page and block spans as half-open UTF-8 byte ranges into the exact Markdown
bytes; physical page identity lives in the typed representation.

Producer-labelled footnotes remain `footnote` blocks, distinct from `caption`
blocks, with their original text, order and Evidence. Previously saved captions
remain captions; reading a revision does not reclassify it. This adopts the
footnote/caption distinction from [Document Parsing Protocol, LlamaIndex,
§5.3](https://github.com/run-llama/document_parsing_protocol/blob/a9c49e24f6db653500cf7eab4b08019f23b74ea6/public/protocol/rfc.md#53-block-classes).
It is a selected representation rule, not a claim of full DPP conformance.

The public document contains sanitized parser provenance and typed diagnostics.
Cache paths, raw parser artifacts, parser input/output refs, and internal
digests stay in the generation manifest.

Every published Evidence occurrence carries finite, ordered, page-bounded
geometry in displayed top-left physical-page space. The adapter can retain a
text block without safe geometry, reporting a diagnostic and publishing no text
Evidence anchor for it; table cells without geometry are omitted with a
diagnostic. The decoder rejects an Evidence occurrence without safe geometry.
Rotation metadata does not invalidate
already normalized displayed-page geometry; consumers repeat the bounds check
before rendering it. An occurrence that fails the check is not drawn, and Studio
never locates Evidence by matching text in the PDF.

For native PDFs, Docling supplies semantic table values and structure. OCR
runs on Surya by default, or on the model the account's Ingestion Model Choice
names. Non-PDF and URL sources are outside this contract: the
[decoder](../../packages/extraction/src/parsed-document.ts) accepts only an
uploaded PDF.
