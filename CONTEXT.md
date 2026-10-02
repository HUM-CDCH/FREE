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

**Source Ingestion**:
One attempt to turn a document a Humanities Researcher provides into a Source Document: queued, then parsing, then a Source Document or a failure the researcher can dismiss. Studio holds it from admission, so it outlives the page that started it.
_Avoid_: upload job, parse job

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
How FREE applies an Extraction Schema to Source Context: Article or Catalog. The researcher selects it, and the selection is saved with the Schema Revision as its Record Scope, so every Extraction on that revision uses it. Article and Catalog are Extraction Strategies and do not replace Direct Extraction or Schema-Guided Extraction.
_Avoid_: document type, extraction mode, profile

**Article Extraction Strategy**:
An Extraction Strategy whose result is exactly one document-level object (Record Scope `document`), which may contain arrays. Its values are gathered from the complete canonical Source Context; values read in separate parts of the source are combined into that one object without dropping list items.
_Avoid_: article mode, narrative mode, direct extraction

**Catalog Extraction Strategy**:
An Extraction Strategy whose result is a collection of record objects (Record Scope `records`), each of which may contain arrays. It discovers the repeated records in canonical Source Context, extracts each separately, and combines them under the result's records collection; an empty collection is a valid result. Generic, recipe and unified Catalog are methods of this strategy, not scopes.
_Avoid_: catalog mode, hierarchical extraction, schema-guided extraction

**Record Scope**:
The authoritative declaration, saved with a Schema Revision, of what one Extraction result is: `document` (one object per Source Document: Article) or `records` (a collection of records: Catalog). It is set only through the Article/Catalog selection, never inferred from array fields or model output, and checked when an Extraction is admitted and when its result is accepted (a `document` result has exactly one root). A Schema Revision from before the declaration existed has one when its Extractions all used one strategy; otherwise the researcher chooses before the next Extraction.
_Avoid_: cardinality, extraction mode, document type

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
A Researcher Account's description of how FREE can reach a model provider: a hosted provider with the researcher's own key, or the researcher's own Ollama, vLLM or OpenAI-compatible server. Its key stays in the researcher's browser. A *deployment connection* is one the deployment runs or enables — its vLLM servers, and the Codex CLI and Claude Code providers on the server's own login: read-only, described by the environment rather than saved, and usable by every researcher.
_Avoid_: provider configuration, endpoint, account

**Capability Route**:
A Researcher Account's choice of Model Connection and model for a related family of FREE model work. A Project Context uses its owner's routes. A route left unset runs on a default: the Interaction Route on the deployment's instruction model, when the deployment serves one, and the Schema Suggestion Route on the Interaction Route.
_Avoid_: task route, model setting, project model

**Schema Suggestion Route**:
The Capability Route used for Schema Suggestion. It uses the *NuExtract protocol* — NuExtract's own template generation, driven through its chat template — exactly when its connection is vLLM and its model is NuExtract; nothing stores or selects the protocol. Left unset, it follows the Interaction Route. Formerly the Extraction Route; Extraction itself runs in the Parsing Service.
_Avoid_: extraction route, extraction model, ext route

**Extraction Model Choice**:
A Researcher Account's choice, set on the Model Configuration page, of the Parsing Service's extraction models by role: the *field model* reads values off the source for the Extraction Schema, and the *reasoning model* decides over labelled source text (where records start, which passage grounds a value, which competing candidate is right). Each role is chosen among the models the Parsing Service deployment serves for that role; a role left unchosen uses the deployment's default. Every single and batch Extraction is requested on its Project Context owner's choice as its start view showed it, pinned at admission, and records it beside the models each role actually ran on. It is not a Capability Route and does not name a Model Connection.
_Avoid_: extraction model, extraction route, model setting

**Extraction Method Settings**:
A Researcher Account's saved choices, per Extraction Strategy, of how future Extractions run: Article's source context, record identity, instructions, source representation, value evidence and verification choices; generic Catalog's text limits; a recipe Catalog's budgets and factors; or, where the deployment admits new Catalog work on the Unified Catalog Method, its input token ceiling, reply token reserve, window overlap, heading context and verification. Legacy Catalog choices are never converted into unified ones: the researcher applies the unified settings before the next Catalog Extraction. They are set on the Model Configuration page's Advanced tab; unset settings keep the Parsing Service's defaults. They never edit an Extraction Schema: whether verification follows the schema's evidence policies is a setting, the policies are the schema's.
_Avoid_: preset, profile, pipeline configuration, advanced extraction

**Extraction Method**:
What one Extraction is admitted with and pinned to: its Extraction Strategy, recipe (legacy Catalog only), Extraction Model Choice and the applicable Extraction Method Settings, including the unified Catalog's defaults version. It never changes after admission, and execution reads only it; Extraction details show it beside the options and protocol versions the Parsing Service reports for the run. Equal methods do not promise identical model output across runtime revisions.
_Avoid_: current settings, configuration, method profile

**Unified Catalog Method**:
The one versioned Catalog method for new single and batch Catalog Extractions where the deployment enables it: general record discovery over the complete admitted source, a ledger giving every nonblank source range a disposition, counted windows for every stage, candidates accepted only after a separate verification, and conservative merging that leaves conflicts and partial list items as proposals. It needs no recipe, language, numbering convention, field name or particular model. Source accounting, processing and evidence are reported apart; recall is not measured.
_Avoid_: generic Catalog, recipe Catalog, model discovery

**Ingestion Model Choice**:
A Researcher Account's choice of the Parsing Service's OCR model (text recognition for scanned pages and textless embedded artwork) and layout model (the detector that cuts scanned pages into regions). It applies to new ingestions and reprocessing only: an admitted ingestion keeps the models it was admitted with, and existing Source Representation Revisions never change. Native PDF text uses neither model. In a document whose nonblank pages all have native text, substantial textless images or vector forms use only the OCR model, as crops; their surrounding native text is preserved. A role left unchosen uses the deployment's default. It names no Model Connection.
_Avoid_: OCR setting, parser model

**Interaction Route**:
The Capability Route used for conversational Extraction Schema editing: the schema panel's "Describe a change to the schema…" and the edit proposals it returns. The Model Configuration page calls it the *Assistant model*.
_Avoid_: chat model, chat route

**Model Attribution**:
A sanitized snapshot of the Model Connection, model, and execution profile used
for a specific piece of model work. Extractions record it. Interactive model
work — generated schemas and schema edit proposals — records none, so a
recovered or replayed result never gains an attribution reconstructed from
today's routes. It never contains credentials and does not replace
source-backed Evidence.
_Avoid_: model provenance, current model, evidence
