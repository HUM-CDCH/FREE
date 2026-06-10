# FREE Context

FREE supports document extraction and evaluation for humanities research. In this context, researchers work from source text, create annotations for material worth extracting, use sets of annotations to generate schema suggestions, review suggested schemas, run extractions, and keep source-backed evidence that guards against hallucinated results.

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
A researcher-created mark on a source document that identifies source text as relevant for possible extraction.
_Avoid_: passage, highlight, selection

**Annotation Set**:
A collection of annotations from a single source document, used together by FREE to produce one or more schema suggestions.
_Avoid_: batch, selection set, training set

**Source Context**:
Source material and annotations from a single source document that FREE may consider when proposing schemas or producing extraction results.
_Avoid_: annotation text, surrounding text, document context, full context

**Schema Suggestion**:
A proposed set of entities and fields produced from an annotation set for researcher review before extraction.
_Avoid_: extraction suggestion, recommendation, prediction, candidate

**Entity**:
A named or identifiable thing that can appear in an extraction schema, such as a person, place, organization, work, or event.
_Avoid_: name, subject

**Field**:
A structured value or attribute that can appear in an extraction schema.
_Avoid_: property, column, metadata

**Extraction Schema**:
A researcher-approved structure, derived from a schema suggestion, that belongs to a single source document and describes which entities and fields FREE should extract.
_Avoid_: template, extraction target, target list

**Extraction**:
A run that applies an extraction schema to source context from its source document to produce extracted values.
_Avoid_: schema, suggestion

**Extraction Result**:
A value or set of values produced by an extraction.
_Avoid_: extraction, output, response

**Review Decision**:
A researcher's choice to approve, edit, or reject a schema suggestion or extraction result.
_Avoid_: status, vote

**Evidence**:
Source material kept to show that a schema suggestion, extraction result, or review decision is grounded in the source document rather than invented.
_Avoid_: citation, source, provenance, annotation text
