<!-- markdownlint-disable MD013 -->
# source-document-ingestion Specification

## Purpose
Upload a PDF Source Document into a Project Context, parse it durably in the Parsing Service, and publish it once per project and content.

## Requirements

### Requirement: Upload validation preserves the PDF trust boundary
Studio SHALL accept one PDF per request under the owner's Project Context, stream it with an exact 100 MiB cap, and require a PDF MIME hint when present and `%PDF-` magic bytes.

#### Scenario: A PDF at exactly 100 MiB is accepted
- **WHEN** the upload body contains a valid PDF of exactly 100 MiB
- **THEN** Studio accepts the upload for admission

#### Scenario: A PDF over 100 MiB is refused
- **WHEN** the uploaded PDF exceeds 100 MiB
- **THEN** Studio refuses it without staging or starting ingestion

#### Scenario: A disallowed MIME hint is refused
- **WHEN** the uploaded file declares a non-PDF MIME type
- **THEN** Studio refuses the upload before starting ingestion

#### Scenario: PDF magic is absent
- **WHEN** the uploaded bytes do not begin with `%PDF-`
- **THEN** Studio refuses the upload even if its MIME hint says PDF

#### Scenario: A declared oversized envelope is refused
- **WHEN** the request declares a body larger than the upload limit
- **THEN** Studio refuses the upload without accepting its payload

### Requirement: Completed content replays before parsing
A PDF whose SHA-256 already has a Source Document in the same Project Context SHALL return that document without staging, converting or starting a workflow; the same bytes in another Project Context are independent.

#### Scenario: Re-uploading a completed PDF returns the existing document
- **WHEN** the same PDF is uploaded again to a Project Context after its first ingestion completed
- **THEN** Studio returns the existing Source Document without a new conversion

#### Scenario: Identical PDFs in two projects are parsed independently
- **WHEN** identical PDF bytes are uploaded to two Project Contexts
- **THEN** each project gets its own ingestion and Source Document

### Requirement: One active ingestion per project and content
Otherwise Studio SHALL stage verified bytes at `<project>/<attempt>.pdf` in the source inbox by atomic rename and enqueue `ingestSource` with deduplication by project and content. A concurrent or repeated upload of the same content SHALL join the active attempt, and the losing request's own staged file SHALL be removed. The workflow's first step rechecks completed content. A failed or cancelled attempt releases deduplication, so uploading again starts a new attempt; there is no client key.

#### Scenario: Two simultaneous same-content uploads run one workflow
- **WHEN** two uploads of the same PDF into the same Project Context arrive before either completes
- **THEN** one `ingestSource` workflow parses it and both requests answer with the same Source Document
- **AND** the losing request's staged file is removed

#### Scenario: A re-upload after a lost response joins the active attempt
- **WHEN** a client repeats an upload while its first ingestion is still active
- **THEN** the repeated request joins that attempt without starting another conversion

#### Scenario: A failed attempt can be retried by uploading again
- **WHEN** an ingestion failed or was cancelled and the same PDF is uploaded again
- **THEN** Studio starts a fresh attempt without requiring a client key

### Requirement: Conversion runs on the lane its page count picks, with the admitted models
Admission SHALL count the PDF's pages using pdf.js for counting only and send at most 30 pages to `kei-convert-small`; anything else, including a PDF pdf.js cannot open, SHALL go to `kei-convert-large`. Admission SHALL freeze the owner's explicit Ingestion Model Choice into the workflow input. A recovered or replayed ingestion keeps its lane and models.

#### Scenario: A small PDF converts on the small lane while a large one converts
- **WHEN** a PDF of at most 30 pages and a larger PDF are uploaded
- **THEN** their conversions run on the small and large lanes respectively

#### Scenario: An uncounted PDF converts on the large lane
- **WHEN** pdf.js cannot count a PDF's pages
- **THEN** its conversion is enqueued on `kei-convert-large`

#### Scenario: An ingestion recovered after the owner changed the choice runs its admitted models
- **WHEN** an ingestion is admitted with an Ingestion Model Choice and recovers after that choice changes
- **THEN** its conversion still uses the OCR and layout models frozen at admission

### Requirement: The request waits, and a timeout detaches
The upload SHALL wait up to thirty minutes for the workflow outcome and answer 201 with the Source Document, 422 `source_ingestion_failed` with the Parsing Service's reason, or 504 on a deadline or timeout. A 504 SHALL NOT cancel the workflow.

#### Scenario: A 504 leaves the work running and a later upload joins or replays it
- **WHEN** the upload request reaches its wait limit while ingestion is still running
- **THEN** it answers 504 without cancelling the workflow
- **AND** a later upload joins the active attempt or replays its completed Source Document

### Requirement: Staged sources are removed by reference and age
A staged PDF SHALL be deleted by its workflow after use; garbage collection SHALL remove a staged file only when it is older than 24 hours, its attempt's workflow is absent or terminal, and its Parsing Service conversion is not live.

#### Scenario: A file staged before a crash that never enqueued is removed after 24 hours
- **WHEN** a staged PDF has no workflow and is older than 24 hours
- **THEN** garbage collection removes it

#### Scenario: The active attempt's PDF is never removed
- **WHEN** an old staged PDF still belongs to a live ingestion or conversion
- **THEN** garbage collection keeps it until the work can no longer read it
