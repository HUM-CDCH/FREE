# User Stories

## Journey: Grounded extraction workflow

A humanities researcher moves from annotations to an approved extraction schema and reviewed extraction results. FREE helps the researcher extract structured information without losing grounding in the source document.

### Covered by
- The researcher can create annotations in a source document.
- FREE can suggest schemas from an annotation set.
- The researcher can approve, edit, or reject schema suggestions.
- The researcher can run extraction from an approved extraction schema.
- The researcher can approve, edit, or reject extraction results with source-backed evidence.

## Implementation Stories

### Researcher creates annotations for schema suggestions

As a humanities researcher,
I want to create annotations in a source document,
so that FREE can suggest a schema for what to extract from that document.

### Acceptance criteria
- The researcher can create annotations by selecting text in a source document viewer.
- FREE uses an annotation set from the source document to show one or more schema suggestions.
- The researcher can approve, edit, or reject each schema suggestion.
- An approved schema suggestion becomes an extraction schema for that source document.
- FREE keeps source-backed evidence that shows schema suggestions and review decisions are grounded in the source document.

### Researcher runs extraction from an approved schema

As a humanities researcher,
I want to run an extraction using an approved extraction schema,
so that FREE can produce grounded extraction results from the source document.

### Acceptance criteria
- The researcher can run an extraction for a source document that has an approved extraction schema.
- FREE applies the extraction schema to source context from that source document.
- FREE produces extraction results for the entities and fields described by the extraction schema.
- FREE keeps source-backed evidence that shows extraction results are grounded in the source document.
- The researcher can approve, edit, or reject each extraction result.
