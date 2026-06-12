# User Stories

## Phase 1 · Document Ingestion

As a scholar, I want to open a PDF so the system makes its text searchable and ready for annotation, without me having to do any preprocessing.

### Acceptance criteria
- The user can upload or open a PDF directly in the document viewer.
- The system detects whether the PDF has a native text layer; if so, no LLM pass is needed.
- Scanned or complex-layout documents are parsed automatically (Docling + optional LLM).
- The document is ready to annotate immediately after upload.

---

## Phase 2 · Annotation

As a scholar, I want to highlight passages across one or more documents at my own pace, so I can collect evidence before committing to any schema. I can annotate across multiple reading sessions; nothing is triggered automatically.

### Acceptance criteria
- The user can select text spans in the PDF viewer and optionally add a label or note.
- Annotations are saved immediately and persisted across sessions.
- Annotations can span multiple documents under the same project.
- No schema inference or extraction is triggered by highlighting alone.

---

## Phase 3 · Schema Suggestion

As a scholar, once I feel I have enough annotations, I want the system to propose a structured schema (field names, types, example values) inferred from my highlights, so I don't have to design a data model from scratch. I stay in control: I review and edit the schema before any extraction runs.

### Acceptance criteria
- The user explicitly triggers schema suggestion (not automatic).
- The system infers field names, types, and example values from the annotation set.
- Each suggested field is linked back to the source highlight(s) that motivated it.
- The user can approve, edit, or reject individual fields before proceeding.
- after a few extractions the user can click 'induction' to promote a schema to a reusable template (node/relation tags, hierarchical).

---

## Phase 4 · Extraction

As a scholar, once I approve the schema, I want the system to extract structured records from the full document (or a batch of documents) and show me exactly where in the source each value came from.

### Acceptance criteria
- Extraction only runs after the schema is explicitly approved by the user.
- Each extracted value is linked to its source passage (evidence highlight).
- The user can run extraction on a single document or a batch using a saved schema.

---

## Phase 5 · Validation

As a scholar, I want to confirm, correct, or reject each extracted value so that the final dataset reflects my expert judgment, not just the model's output.

### Acceptance criteria
- The user can confirm, edit, or reject each extracted field value individually.
- The interface flags fields that have not yet been validated.
- Validation decisions are saved as part of the annotation record for audit purposes.