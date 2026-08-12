# nuextract-few-shot Specification

## Purpose
Defines the static NuExtract structured-extraction few-shot example used to demonstrate the expected schema, result, evidence, snippet, and page-number shape.

## Requirements

### Requirement: A static few-shot example demonstrates correct evidence snippet quality

The backend SHALL provide a single static few-shot example as a module-level constant that contains a mixed schema (one scalar field and one array-of-objects field) and a correctly filled result, demonstrating that evidence snippets are broader source passages — not copies of extracted values.

#### Scenario: Example schema contains both scalar and array fields

- **WHEN** `STRUCTURED_EXTRACTION_EXAMPLE` is inspected
- **THEN** its `schema_json` contains at least one top-level scalar field and at least one top-level array-of-objects field, each with a corresponding `_evidence` entry

#### Scenario: Snippets are broader passages, not copies of extracted values

- **WHEN** a snippet in `_evidence` is compared to the corresponding extracted field value
- **THEN** the snippet contains the extracted value as a substring or near-match
- **AND** the snippet includes surrounding words from the original source text, providing enough context for fuzzy positional search in the PDF

#### Scenario: Every evidenced item has a non-empty snippet and a valid page number

- **WHEN** all `{snippet, page}` leaf nodes in `_evidence` are collected
- **THEN** every snippet is a non-empty string
- **AND** every page is a positive integer
