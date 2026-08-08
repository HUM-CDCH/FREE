<!-- markdownlint-disable MD013 -->

# parsed-document-v2 Specification

## ADDED Requirements

### Requirement: One strict canonical document contract

The public document SHALL be `ParsedDocument` from
`app.models.parsed_document`, with `schema_version: "parsed_document.v2"`.
The model SHALL reject v1 payloads, removed aliases, URL-source fields,
nested table-cell Evidence, duplicated page anchor collections, and unknown
fields.

#### Scenario: Alias payload is submitted

- **WHEN** a payload contains `page`, `blocks`, `canonical_col`, `char_span`,
  nested cell Evidence, or a page `evidence_anchor_ids` collection
- **THEN** decoding fails closed

### Requirement: PDF upload source only

V2 ingestion SHALL accept only an uploaded PDF and SHALL reject URL-source
fields and non-PDF media types. The service SHALL expose only `/tasks`, task
status, `/document`, `/markdown`, and `/download` routes.

`GET /tasks/{id}/document` and `GET /tasks/{id}/source` SHALL return the same
strict v2 payload. The retained upload is served separately by
`GET /tasks/{id}/pdf`. The route table contains no `/parsed-document` alias.

#### Scenario: URL source is submitted

- **WHEN** source metadata contains a URL or non-PDF media type
- **THEN** ingestion rejects the request with the client-safe source error

### Requirement: UTF-8 byte spans

`MarkdownByteSpan` SHALL be a half-open `[start, end)` range measured in bytes
of the exact emitted UTF-8 canonical Markdown. Every published block/page/text
anchor span SHALL be within those bytes and SHALL round-trip by decoding the
selected byte slice.

#### Scenario: Non-ASCII source text is rendered

- **WHEN** canonical Markdown contains Danish characters or non-BMP text
- **THEN** span widths use UTF-8 byte lengths, not character counts

### Requirement: Canonical semantic stream

The document SHALL contain typed, page-scoped semantic blocks and complete
physical-page coverage. Ordered content references SHALL point to blocks on the
same page; known-but-unplaced tables SHALL be listed under that page's
`unplaced_content`.

#### Scenario: Known table position is not verified

- **WHEN** a canonical table has a physical page but no verified reading-order
  slot
- **THEN** its table ID appears in that page's `unplaced_content` and no
  invented ordered block is emitted

### Requirement: Producer-backed table Evidence

Each canonical table cell SHALL contain exactly one `evidence_anchor_id`.
The matching table-cell anchor SHALL contain a non-empty ordered collection of
producer observations with unique occurrence IDs, physical page, producer
identity, page-local row/column offsets, observed spans, and optional geometry.
Text anchors SHALL own one occurrence ID. No occurrence ID may be owned by two
anchors. Page spans SHALL contain only page/range/producer identity. Missing
geometry is valid; missing producer occurrence identity is not.

#### Scenario: Cell Evidence is duplicated

- **WHEN** a cell embeds Evidence or a page span repeats anchor IDs
- **THEN** the contract rejects the payload

### Requirement: Reviewed continuation only

A logical table MAY span physical pages only when reviewed producer facts show
matching page-local OTSL matrices, a header-bearing first fragment, a body-only
next fragment, and a page-break-only interstitial. Adjacency, textual
similarity, repeated headers, geometry, or generated IDs alone SHALL NOT admit
continuation. Narrative, caption, new-header, malformed, and ambiguous cases
SHALL remain separate.

#### Scenario: Producer facts prove continuation

- **WHEN** reviewed page-local observations satisfy the structural continuation
  predicate
- **THEN** one logical table is published with page-scoped cell anchors

### Requirement: Parser and table authority

Docling SHALL provide canonical table semantics. Camelot SHALL be used only for
exact-match monotonic geometry enrichment of a Docling table. Camelot-only
candidates SHALL remain diagnostics and SHALL NOT be published as canonical
tables. PaddleOCR SHALL be the page-level text fallback; a PyMuPDF text
fallback SHALL NOT be introduced by this change.

#### Scenario: Camelot has no matching Docling inventory

- **WHEN** Camelot returns a table without an exact Docling semantic match
- **THEN** the candidate is retained only as an internal diagnostic and no
  canonical table is published from it

### Requirement: Public diagnostics and provenance are sanitized

The public document SHALL expose typed diagnostics and parser/version/status
provenance without cache paths, raw-artifact refs, parser input/output refs, or
internal generation digests. Those values SHALL remain in the internal
generation manifest.

#### Scenario: Document JSON is returned

- **WHEN** a completed task is fetched through the document route
- **THEN** parser provenance contains only parser/version/status/warnings/error
  and no cache path or raw-artifact reference

### Requirement: Route and package JSON are identical

`GET /tasks/{id}/document` and `parsed_document.json` in the package SHALL
serialize the same portable v2 payload and package-relative artifact refs.

#### Scenario: Package is opened after route retrieval

- **WHEN** the same completed generation is retrieved as JSON and packaged
- **THEN** the route payload and `parsed_document.json` contain identical
  portable fields and references

### Requirement: Strict current-task reconciliation

Startup reconciliation SHALL accept only the current upload task record with
complete required fields and matching source/document identity. It SHALL NOT
fill, migrate, or rewrite legacy task fields.

#### Scenario: Current task metadata is incomplete

- **WHEN** a task lacks one of the required current upload fields
- **THEN** reconciliation skips it without filling or migrating any field
