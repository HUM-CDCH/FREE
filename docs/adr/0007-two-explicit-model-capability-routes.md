# Two explicit model Capability Routes

FREE exposes exactly two machine-wide Capability Routes for now: the Extraction
Route serves Extraction and Schema Suggestion, while the Interaction Route
serves document chat and conversational Extraction Schema editing. Operations
resolve once through a central route resolver rather than embedding provider
selection in each endpoint. A missing route fails explicitly and never falls
back to another route or configuration source. A model missing from the latest
advisory catalog remains selected and is still attempted; any provider failure
is returned rather than triggering substitution.

Exposing Model Attribution on operation responses is deferred. Route resolution
still uses one immutable configuration snapshot per operation, but this change
does not alter extraction, schema, or chat response contracts to retain that
snapshot.

Interaction uses canonical Source Document Markdown as provider-neutral context;
raw Docling output remains internal, and a future `ParsedDocument.v2` Source
Context projection is a separate decision. An Ollama Extraction Route also
stores whether its selected model uses the NuExtract raw protocol or the general
model protocol, because provider identity and model-name guessing cannot safely
choose between them.
