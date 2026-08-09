# FREE Context

FREE supports document extraction and evaluation for humanities research. In this context, researchers work from source text, extract information directly or with an explicit schema, and keep source-backed evidence that guards against hallucinated results.

## Language

**FREE**:
The product context for document extraction and evaluation in humanities research.
_Avoid_: app, system

**Humanities Researcher**:
A person using FREE to study source documents and decide which information should be extracted from them.
_Avoid_: user, analyst

**Source Document**:
A document that contains the original material a researcher works from, including PDFs and other document formats.
_Avoid_: file, PDF, upload

**Project Context**:
The broader context that contains one or more source documents, their annotations and annotation sets, schema suggestions, extraction schemas, extractions, and extraction results.
_Avoid_: research context, workspace

**Annotation**:
A researcher-created mark on a source document that identifies source text as relevant for possible extraction and may guide direct extraction when present.
_Avoid_: passage, highlight, selection

**Annotation Set**:
A collection of annotations from a single source document that may guide schema suggestions or direct extraction.
_Avoid_: batch, selection set, training set

**Feedback Set**:
A collection of review decisions saved for audit purposes after a humanities researcher validates extraction results.
_Avoid_: annotation set, validation set, correction set

**Source Context**:
Source material and annotations from a single source document that FREE may consider when proposing schemas or producing extraction results.
_Avoid_: annotation text, surrounding text, document context, full context

**Direct Extraction**:
An extraction mode where a humanities researcher extracts information from a source document without first creating annotations, reviewing schema suggestions, or approving an extraction schema.
_Avoid_: quick extraction, simple extraction, automatic extraction

**Schema-Guided Extraction**:
An extraction mode where a humanities researcher uses an explicit extraction schema to make extraction more precise and repeatable.
_Avoid_: advanced extraction, technical extraction, schema extraction

**Schema Suggestion**:
A proposed set of entities and fields produced from a source document and, when present, its annotations for researcher review before schema-guided extraction.
_Avoid_: extraction suggestion, recommendation, prediction, candidate

**Entity**:
A named or identifiable thing that can appear in an extraction schema, such as a person, place, organization, work, or event.
_Avoid_: name, subject

**Field**:
A structured value or attribute that can appear in an extraction schema.
_Avoid_: property, column, metadata

**Extraction Schema**:
A researcher-approved structure that belongs to at least a ProjectContext and describes which entities and fields FREE should extract.
_Avoid_: template, extraction target, target list

**Schema Revision**:
An immutable, ordered version of an Extraction Schema.
_Avoid_: schema version, history entry, snapshot

**Current Schema Revision**:
The latest durable Schema Revision of an Extraction Schema and the basis for new edits and Extractions.
_Avoid_: active version, current schema, head

**Historical Schema Revision**:
A Schema Revision earlier than the Current Schema Revision.
_Avoid_: old version, history entry

**Historical Preview**:
A read-only view of a Historical Schema Revision that does not replace or alter the Current Schema Revision.
_Avoid_: restore, rollback, checkout

**Extraction**:
A run that applies an extraction schema to source context from its source document to produce extracted values.
_Avoid_: schema, suggestion

**Extraction Result**:
A source-grounded value or set of values produced by an extraction and linked to
validated evidence.
_Avoid_: extraction, output, response

**Review Decision**:
A researcher's choice to approve, edit, or reject a schema suggestion or
extraction result.
_Avoid_: status, vote

**Evidence**:
Source material linked to an exact location in a source document and kept to show
that a schema suggestion, extraction result, or review decision is grounded
rather than invented.
_Avoid_: citation, source, provenance, annotation text

**Evidence Anchor**:
An exact location in a source document to which evidence is linked, identifying
source text or a table cell without requiring visual geometry.
_Avoid_: citation anchor, model reference, highlight

**Model Connection**:
A machine-wide description of how FREE can reach a model provider for one
humanities researcher. It may represent a local service, a remote service, or
an authenticated local model harness.
_Avoid_: provider configuration, endpoint, account

**Capability Route**:
A machine-wide choice of Model Connection and model for a related family of
FREE model work. Project Contexts do not own or override Capability Routes.
_Avoid_: task route, model setting, project model

**Extraction Route**:
The Capability Route used for Extraction and Schema Suggestion.
_Avoid_: extraction model, ext route

**Interaction Route**:
The Capability Route used for document chat and conversational Extraction
Schema editing.
_Avoid_: chat model, chat route

**Model Attribution**:
A sanitized snapshot of the Model Connection, model, and execution profile used
for a specific piece of model work. It identifies how that work was produced
without containing credentials and does not replace source-backed Evidence.
_Avoid_: model provenance, current model, evidence
