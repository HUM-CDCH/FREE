# User Stories

## Phase 1 · Document Ingestion

As a scholar, I want to open a PDF so the system makes its text searchable and ready for annotation, without me having to do any preprocessing.

### Acceptance criteria
- The user can upload or open a PDF directly in the document viewer.
- The system detects whether the PDF has a native text layer; if so, no LLM pass is needed.
- Scanned or complex-layout documents are parsed automatically (Docling + optional LLM).
- The document is ready to annotate or extract immediately after upload.

---

## Phase 2 · Context Gathering (all optional)

As a scholar, I want to be able to guide extraction with as much or as little input as I choose — from careful annotation down to nothing at all.

### 2a · Annotation

As a scholar, I want to highlight passages across one or more documents at my own pace, so I can point the system to the most relevant spans before extraction runs.

#### Acceptance criteria
- The user can select text spans in the PDF viewer and optionally add a label or note.
- Annotations are saved immediately and persisted across sessions.
- Annotations can span multiple documents under the same project.
- Annotation alone does not trigger extraction.

### 2b · Natural Language Prompt

As a scholar, I want to describe in plain language what I am looking for (e.g. "extract all reported temperatures and experimental conditions"), so the system can tailor the schema to my research question without me designing it from scratch.

#### Acceptance criteria
- The user can type a free-text prompt before initiating extraction.
- The prompt is combined with any annotations as joint context for schema derivation.
- The prompt is saved alongside the document so it can be reused or edited.

---

## Phase 3 · Schema Derivation (always runs)

As a scholar, I want the system to always propose a schema before running extraction, regardless of how much context I provided, so I know what structure the data will follow.

### Acceptance criteria
- If annotations and/or a prompt are available, the schema is inferred from them.
- If no context is provided, the system detects the document domain and proposes a sensible default schema automatically.
- The proposed schema is shown to the user before extraction runs.
- The user can optionally review, edit, or reject individual fields (see Phase 3b).
- If the user skips review, the proposed schema is used as-is.

### 3b · Schema Review (optional)

As a scholar, I want to be able to inspect and correct the proposed schema before extraction, so the final structure reflects my expert judgment.

#### Acceptance criteria
- The user can approve, edit, or reject each suggested field.
- Edited or rejected fields update the schema before extraction runs.
- Skipping review is always allowed; extraction proceeds with the auto-proposed schema.

---

## Phase 4 · Extraction

As a scholar, once a schema is confirmed (by review or auto-approval), I want the system to extract structured records from the full document and show me exactly where in the source each value came from.

### Acceptance criteria
- Extraction runs against the confirmed schema (reviewed or auto-approved).
- Each extracted value is linked to its source passage (evidence highlight).
- The user can run extraction on a single document or a batch using a saved schema.

---

## Phase 5 · Validation (optional)

As a scholar, I want to confirm, correct, or reject each extracted value so that the final dataset reflects my expert judgment, not just the model's output.

### Acceptance criteria
- The user can confirm, edit, or reject each extracted field value individually.
- The interface flags fields that have not yet been validated.
- Skipping validation is always allowed; unvalidated records are marked as unreviewed.
- Validation decisions are saved for audit purposes.
