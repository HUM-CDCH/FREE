# FREE Context

FREE supports document extraction and evaluation for humanities research. In this context, researchers work from source text, extract information directly or with an explicit schema, and keep source-backed evidence that guards against hallucinated results.

## Language

**FREE**:
The product context for document extraction and evaluation in humanities research.
_Avoid_: app, system

**Humanities Researcher**:
A person using FREE to study source documents and decide which information should be extracted from them.
_Avoid_: user, analyst

**Researcher Account**:
The authenticated identity of one Humanities Researcher and the required owner of each of that researcher's Project Contexts.
_Avoid_: user, member

**Source Document**:
A document that contains the original material a researcher works from, including PDFs and other document formats.
_Avoid_: file, PDF, upload

**Project Context**:
The research aggregate owned by exactly one Researcher Account. It contains one or more Source Documents, their annotations and Annotation Sets, Schema Suggestions, Extraction Schemas, Extractions, and Extraction Results; every descendant inherits ownership through this aggregate.
_Avoid_: research context, workspace when referring to one Project Context

**Project**:
The concise researcher-facing name for a Project Context. It denotes the same research aggregate, not a separate kind of object.
_Avoid_: research context

**Research Workspace**:
The authenticated area of FREE in which a Humanities Researcher works across Project Contexts and shared capabilities. It is not itself a Project Context and owns no research state.
_Avoid_: Project Context when the whole authenticated area is meant

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

**Extraction Strategy**:
A per-Extraction choice of how FREE applies an Extraction Schema to Source Context. Article and Catalog are Extraction Strategies and do not replace Direct Extraction or Schema-Guided Extraction.
_Avoid_: document type, extraction mode, profile

**Article Extraction Strategy**:
An Extraction Strategy that applies an Extraction Schema to the complete canonical Source Context as one values-extraction operation.
_Avoid_: article mode, narrative mode, direct extraction

**Catalog Extraction Strategy**:
An Extraction Strategy that discovers repeated records in canonical Source Context, extracts each record separately, and combines them under the Extraction Schema's root records collection.
_Avoid_: catalog mode, hierarchical extraction, schema-guided extraction

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

**Batch Extraction**:
A researcher-initiated operation that applies one Current Schema Revision and one Extraction Strategy to a selected set of Source Documents, creating a separate Extraction and Extraction Result for each Source Document.
_Avoid_: annotation set, combined extraction, project-wide extraction

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
A deployment-wide shared description of how FREE can reach a model provider. It may represent a local service, a remote service, or an authenticated local model harness. A *deployment connection* is one the deployment itself runs (its vLLM servers): read-only, described by the environment rather than saved.
_Avoid_: provider configuration, endpoint, account

**Capability Route**:
A deployment-wide shared choice of Model Connection and model for a related family of FREE model work. Researcher Accounts and Project Contexts do not own or override Capability Routes. A route left unset runs on the deployment's instruction model, when the deployment serves one.
_Avoid_: task route, model setting, project model

**Schema Suggestion Route**:
The Capability Route used for Schema Suggestion. On a vLLM Model Connection it may use the *NuExtract protocol*: NuExtract's own template generation, driven through its chat template. Formerly the Extraction Route; Extraction itself runs in the Parsing Service.
_Avoid_: extraction route, extraction model, ext route

**Extraction Model Choice**:
A deployment-wide choice, set on the Model Configuration page, of the Parsing Service's extraction models by role: the *field model* reads values off the source for the Extraction Schema, and the *reasoning model* decides over labelled source text (where records start, which passage grounds a value, which competing candidate is right). Each role is chosen among the models the Parsing Service deployment serves for that role; a role left unchosen uses the deployment's default. Every single and batch Extraction is requested on the choice current when it starts, and records it beside the models each role actually ran on. It is not a Capability Route and does not name a Model Connection.
_Avoid_: extraction model, extraction route, model setting

**Interaction Route**:
The Capability Route used for document chat and conversational Extraction
Schema editing.
_Avoid_: chat model, chat route

**Model Attribution**:
A sanitized snapshot of the Model Connection, model, and execution profile used
for a specific piece of model work. It identifies how that work was produced
without containing credentials and does not replace source-backed Evidence.
_Avoid_: model provenance, current model, evidence
