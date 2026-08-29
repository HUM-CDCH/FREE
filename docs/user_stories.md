# User Stories

## Journey: Grounded extraction workflow

A humanities researcher works from source documents to produce structured extraction results without losing evidence from the original material. FREE supports both direct extraction for fast research use and schema-guided extraction for precise, repeatable work.

## Phase 1: Document Ingestion

As a humanities researcher,
I want to open a source document,
so that FREE makes its text searchable and ready for annotation or extraction without manual preprocessing.

### Acceptance criteria
- The researcher can add one or more PDFs to a Project Context from its rail.
- FREE detects whether the source document has a native text layer; if so, no LLM pass is needed.
- Scanned or complex-layout source documents are parsed automatically with Docling and, when needed, an LLM.
- The source document is ready to annotate or extract from immediately after ingestion.

---

## Phase 2: Context Gathering (all optional)

As a humanities researcher,
I want to be able to guide extraction with as much or as little input as I choose, from careful annotation down to nothing at all.

### 2a: Annotation

As a humanities researcher,
I want to create annotations across one or more source documents at my own pace,
so that I can point FREE to relevant source material before extraction runs.

#### Acceptance criteria
- The researcher can select text spans in the document viewer and optionally add a label or note.
- Annotations are saved immediately and persisted across sessions.
- Annotations can span multiple source documents in the same project context.
- Creating annotations does not trigger extraction.

### 2b: Natural Language Prompt

As a humanities researcher,
I want to describe in plain language what I am looking for,
so that FREE can tailor the extraction schema to my research question without me designing it from scratch.

#### Acceptance criteria
- The researcher can type a free-text prompt before initiating extraction.
- The prompt is combined with any annotations as source context for schema derivation.
- The prompt is saved alongside the source document so it can be reused or edited.

---

## Phase 3: Schema Derivation (always runs)

As a humanities researcher,
I want FREE to always propose an extraction schema before running extraction, regardless of how much source context I provided,
so that I know what structure the data will follow.

### Acceptance criteria
- If annotations and/or a prompt are available, the extraction schema is inferred from them.
- If no source context is provided, FREE detects the source document domain and proposes a sensible default extraction schema automatically.
- The proposed extraction schema is shown to the researcher before extraction runs.
- The researcher can optionally review, edit, or reject individual fields (see Phase 3b).
- If the researcher skips review, the proposed extraction schema is used as-is.

### 3b: Schema Review (optional)

As a humanities researcher,
I want to be able to inspect and correct the proposed extraction schema before extraction,
so that the final structure reflects my expert judgment.

#### Acceptance criteria
- The researcher can approve, edit, or reject each suggested field.
- Edited or rejected fields update the extraction schema before extraction runs.
- Skipping review is always allowed; extraction proceeds with the proposed extraction schema.

---

## Phase 4: Extraction

As a humanities researcher,
once an extraction schema is confirmed by review or auto-approval,
I want FREE to extract structured records from the source document and show me exactly where each extraction result came from.

### Acceptance criteria
- Extraction runs against the confirmed extraction schema (reviewed or auto-approved).
- Each extraction result is linked to evidence from the source document.
- The researcher can run extraction on a single source document or a batch using a saved extraction schema.

---

## Phase 5: Validation (optional)

As a humanities researcher,
I want to confirm, correct, or reject each extraction result,
so that the final dataset reflects my expert judgment rather than only model-produced values.

### Acceptance criteria
- The researcher can confirm, edit, or reject each extracted field value individually.
- FREE flags extraction results that have not yet been validated.
- Skipping validation is allowed; unvalidated extraction results remain marked as unreviewed.
- Review decisions are saved in a feedback set for audit purposes.
- Each review decision remains linked to the extraction result and its evidence.
