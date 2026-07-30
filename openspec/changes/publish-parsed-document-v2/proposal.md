<!-- markdownlint-disable MD013 -->

# Proposal: publish-parsed-document-v2

> **Status: implemented.** This change publishes one strict `parsed_document.v2`
> contract for PDF uploads and one portable canonical ingestion package.

## Why

The previous document shape exposed parallel parser and Markdown views, mixed
character and byte offsets, and duplicated table Evidence. It could not give
Studio one unambiguous source-navigation contract or represent reviewed
cross-page table continuation without copying producer facts.

## What changes

- `app.models.parsed_document.ParsedDocument` is the sole public typed model.
  Its wire discriminator is always `schema_version: "parsed_document.v2"`.
- Source admission is upload-only PDF. URL fields and the hidden
  `/parsed-document` route are removed.
- Content blocks, physical pages, logical tables, producer observations,
  typed diagnostics, and sanitized parser provenance are published together.
- `MarkdownByteSpan` uses half-open UTF-8 byte offsets into the emitted
  canonical Markdown bytes. Danish, emoji, and other non-ASCII text are
  validated against those exact bytes.
- A canonical table cell owns exactly one table-cell Evidence anchor. Page
  spans carry page/range/producer identity only; they do not repeat anchor IDs.
- Docling remains the semantic parser. PaddleOCR is the page-level fallback.
  Camelot can add exact-match monotonic geometry to a Docling table, but a
  Camelot-only table is never canonical.
- Reviewed continuation is admitted only from producer-backed structural
  observations. Narrative, caption, new-header, malformed, adjacency-only,
  and similarity-only cases fail closed.
- Cache paths, raw parser artifacts, and internal digests stay in a generation
  manifest. Route JSON and packaged JSON are the same portable payload.
- The package remains `canonical-ingestion-package.v1`; this is the package
  format version, not a ParsedDocument contract version.

## Public routes

- `POST /tasks`
- `GET /tasks/{id}`
- `GET /tasks/{id}/document`
- `GET /tasks/{id}/markdown`
- `GET /tasks/{id}/download`

## Non-goals

This change does not add URL ingestion, non-PDF formats, persistence-domain
models, model-provider configuration, extraction-result policy, or a PyMuPDF
text fallback.

