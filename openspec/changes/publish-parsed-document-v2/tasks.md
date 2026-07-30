<!-- markdownlint-disable MD013 -->

# Tasks: publish-parsed-document-v2

All implementation tasks are complete on the local clean branch.

## Contract

- [x] Define one strict `ParsedDocument` interface with the v2 wire
  discriminator and upload-only PDF source.
- [x] Remove aliases, nested table Evidence, duplicated page anchor lists,
  URL-source fields, and character-offset fields.
- [x] Validate UTF-8 byte spans, identity, page coverage, placement, and one
  table-cell anchor per canonical cell.

## Parsing and publication

- [x] Expose `build_canonical_generation` as the sole typed generation seam.
- [x] Keep Docling primary and PaddleOCR page fallback with explicit CPU/GPU
  profiles; do not add a PyMuPDF text fallback.
- [x] Gate continuation on reviewed producer structure with fail-closed
  narrative/header/caption/malformed cases and no capture-digest allowlist.
- [x] Restrict Camelot to exact-match monotonic geometry enrichment and exclude
  Camelot-only canonical tables.
- [x] Publish sanitized provenance/diagnostics and keep cache details in the
  internal generation manifest.

## Storage and routes

- [x] Validate cache reuse through the generation manifest and reject legacy
  task state during startup reconciliation.
- [x] Keep task status, document, Markdown, and deterministic four-entry ZIP
  delivery; remove the hidden `/parsed-document` route and task-shaped archive
  helpers.
- [x] Ensure route JSON and package JSON use the same portable v2 payload.

## Studio

- [x] Replace alternate-shape decoding with a strict Zod v2 schema.
- [x] Migrate Evidence grouping, diagnostics, table observations, and page
  navigation to the canonical anchor representation.
- [x] Preserve extraction-result Evidence as a separate concern.

## Verification and handoff

- [x] Add regressions for aliases/v1 rejection, UTF-8 spans, Evidence ownership,
  reviewed continuation negatives, Camelot exclusion, task reconciliation,
  cache-path absence, route 404, deterministic package bytes, and Studio
  decoding/navigation.
- [x] Run focused CPU-profile backend tests, Studio tests/typecheck/build, and
  strict OpenSpec validation.
- [ ] Commit the clean branch as four reviewable local commits; do not push or
  open a pull request.

