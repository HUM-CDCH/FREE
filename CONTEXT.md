# FREE Context

FREE supports document extraction and evaluation for humanities research. In this context, researchers work from source text, extract information with an explicit Extraction Schema, and keep source-backed evidence that guards against hallucinated results.

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
A document, uploaded as a PDF, that contains the original material a researcher works from.
_Avoid_: file, PDF, upload

**Source Ingestion**:
One attempt to turn a document a Humanities Researcher provides into a Source Document: queued, then parsing, then a Source Document or a failure the researcher can dismiss. Studio holds it from admission, so it outlives the page that started it.
_Avoid_: upload job, parse job

**Project Context**:
The research aggregate owned by exactly one Researcher Account. It contains zero or more Source Documents, Schema Suggestions, Extraction Schemas, Extractions, and Extraction Results; every descendant inherits ownership through this aggregate.
_Avoid_: research context, workspace when referring to one Project Context

**Project**:
The concise researcher-facing name for a Project Context. It denotes the same research aggregate, not a separate kind of object.
_Avoid_: research context

**Research Workspace**:
The authenticated area of FREE in which a Humanities Researcher works across Project Contexts and shared capabilities. It is not itself a Project Context and owns no research state.
_Avoid_: Project Context when the whole authenticated area is meant

**Annotation**:
A researcher-created mark on a Source Document that identifies source text as relevant. Creating Annotations is temporarily disabled; existing ones are read-only, and neither Schema Suggestion nor Extraction reads them.
_Avoid_: passage, highlight, selection

**Annotation Set**:
A collection of Annotations from a single Source Document; read-only, like its Annotations.
_Avoid_: batch, selection set, training set

**Source Context**:
Source material from a single Source Document that FREE may consider when proposing schemas or producing extraction results.
_Avoid_: annotation text, surrounding text, document context, full context

**Extraction Strategy**:
How FREE applies an Extraction Schema to Source Context: Article or Catalog. The researcher selects it, and the selection is saved with the Schema Revision as its Record Scope, so every Extraction on that revision uses it.
_Avoid_: document type, extraction mode, profile

**Article Extraction Strategy**:
An Extraction Strategy whose result is exactly one document-level object (Record Scope `document`), which may contain arrays. Its values are gathered from the complete canonical Source Context; values read in separate parts of the source are combined into that one object without dropping list items.
_Avoid_: article mode, narrative mode, direct extraction

**Catalog Extraction Strategy**:
An Extraction Strategy whose result is a collection of record objects (Record Scope `records`), each of which may contain arrays. It discovers the repeated records in canonical Source Context, extracts each separately, and combines them under the result's records collection; an empty collection is a valid result. Generic, recipe and unified Catalog are methods of this strategy, not scopes.
_Avoid_: catalog mode, hierarchical extraction, schema-guided extraction

**Record Scope**:
The authoritative declaration, saved with a Schema Revision, of what one Extraction result is: `document` (one object per Source Document: Article) or `records` (a collection of records: Catalog). It is set only through the Article/Catalog selection, never inferred from array fields or model output, and checked when an Extraction is admitted and when its result is accepted (a `document` result has exactly one root). A Schema Revision without one cannot be extracted until the researcher chooses.
_Avoid_: cardinality, extraction mode, document type

**Schema Suggestion**:
A proposed Extraction Schema for researcher review, built from a whole Source Document (read in windows) and the researcher's optional instruction. A Batch Schema Suggestion suggests per Source Document and keeps the fields the documents share; a project spreadsheet's columns can also seed one.
_Avoid_: extraction suggestion, recommendation, prediction, candidate

**Field**:
A structured value or attribute that can appear in an extraction schema.
_Avoid_: property, column, metadata

**Extraction Schema**:
A researcher-approved structure that belongs to exactly one Project Context: a record description and the Fields FREE should extract. Every Extraction applies one of its Schema Revisions, which keeps extraction precise and repeatable.
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
A researcher-visible operation that applies an Extraction Schema to Source Context from its Source Document to produce extracted values. A durable interactive Extraction retains its identity through Pause, Resume and Retry; completed work and researcher decisions remain saved.
_Avoid_: schema, suggestion

**Producing Input Selection**:
The immutable schema revision, Extraction Method and resolved settings that produced particular values within a durable interactive Extraction. Adopting revised inputs creates another selection; earlier values retain their producing selection.
_Avoid_: current schema, mutable run settings

**Batch Extraction**:
A researcher-initiated operation that applies one Current Schema Revision and one Extraction Strategy to a selected set of Source Documents, creating a separate Extraction and Extraction Result for each Source Document.
_Avoid_: annotation set, combined extraction, project-wide extraction

**Extraction Result**:
A source-grounded value or set of values produced by an extraction and linked to
validated evidence. Durable interactive Extractions also retain structurally valid provisional or ungrounded values with an explicit Evidence status; researcher corrections remain independent of that status.
_Avoid_: extraction, output, response

**Review Decision**:
A researcher's choice to approve, edit, or reject a schema suggestion or
extraction result. For an Extraction it is a revisioned correction of one saved
value, bound to that value's stable identity and producing type, and saved in a
numbered Decision Version of its Project.
_Avoid_: status, vote, review draft

**Decision Version**:
The numbered version of a Project's corrections: saving a correction raises it
by one, and earlier corrections stay. A Finalized Review names one beside a
result snapshot. Active edits the researcher keeps in use guide later
Extractions when they fit the target schema; an edit that does not fit stays
saved but is not sent. In code the counter is `FeedbackHead.version`, which
each correction and finalization records as `feedbackVersion`;
`/api/project-contexts/:id/feedback` lists the corrections.
_Avoid_: feedback set, correction set

**Finalized Review**:
A researcher's explicit finalization of one named pair: an Extraction's result
snapshot version and its Project's Decision Version. It is refused until every
saved value of that snapshot has an approve, edit or reject decision as of that
Decision Version. It never finalizes implicitly, never freezes later work, and
a deliberately older pair may be finalized when it is clearly named. "Latest
reviewed" opens the most recently finalized pair.
_Avoid_: saved review, accepted result

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
The Capability Route used for Schema Suggestion. It uses the *NuExtract protocol* — NuExtract's own template generation, driven through its chat template — exactly when its connection is vLLM and its model is NuExtract; nothing stores or selects the protocol. Left unset, it follows the Interaction Route. It does not run Extraction, which runs in the Parsing Service.
_Avoid_: extraction route, extraction model, ext route

**Extraction Model Choice**:
A Researcher Account's choice of the Parsing Service's extraction models by role: the *field model* reads values off the source for the Extraction Schema, and the *reasoning model* decides over labelled source text (where records start, which passage grounds a value, which competing candidate is right). A role left unchosen uses the deployment's default; the choice is not a Capability Route and names no Model Connection.
_Avoid_: extraction model, extraction route, model setting

**Extraction Method Settings**:
A Researcher Account's saved choices, per Extraction Strategy, of how future Extractions run, set on the Model Configuration page's Advanced tab; unset settings keep the Parsing Service's defaults. They never edit an Extraction Schema: whether verification follows the schema's evidence policies is a setting, the policies are the schema's.
_Avoid_: preset, profile, pipeline configuration, advanced extraction

**Extraction Method**:
What one Extraction is admitted with and pinned to: its Extraction Strategy, recipe (a single recipe Catalog Extraction only; a Batch Extraction has none), Extraction Model Choice and the applicable Extraction Method Settings, including the unified Catalog's defaults version. A producing input selection's method never changes after its admission; Extraction details show it beside the effective models and options the Parsing Service captured.
_Avoid_: current settings, configuration, method profile

**Unified Catalog Method**:
The versioned Catalog method a deployment can enable for new single and batch Catalog Extractions instead of the generic and recipe Catalog methods: it discovers records over the complete admitted source, gives every nonblank source range a disposition, and accepts a candidate only after a separate verification. It needs no recipe, language, numbering convention, field name or particular model.
_Avoid_: generic Catalog, recipe Catalog, model discovery

**Ingestion Model Choice**:
A Researcher Account's choice of the Parsing Service's OCR model (text recognition for scanned pages and textless embedded artwork) and layout model (the detector that cuts scanned pages into regions); it names no Model Connection. Each new ingestion or reprocessing freezes it at admission; native PDF text uses neither model, except that its textless artwork and its blocks with undecodable font glyphs are read by the OCR model, and a role left unchosen uses the deployment's default.
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
