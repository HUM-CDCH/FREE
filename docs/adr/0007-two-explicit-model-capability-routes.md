# Two explicit model Capability Routes

> Amended by [0011](0011-one-model-configuration-page.md): the Extraction Route
> is now the Schema Suggestion Route, and an unset route runs on the
> deployment's instruction model when it serves one.
>
> Amended by [0013](0013-per-researcher-model-configuration.md): both routes belong to each Researcher Account; an unset Schema Suggestion Route follows the Interaction Route; and the NuExtract protocol is derived from the connection (vLLM) and the model ID (NuExtract), never stored or chosen.
>
> Amended by the DBOS plan's decision 15 (2026-09-26): the document chat was deleted, so the Interaction Route serves conversational Extraction Schema editing (edit proposals) only.

FREE exposes exactly two machine-wide Capability Routes for now: the Extraction
Route serves Extraction and Schema Suggestion, while the Interaction Route
serves document chat and conversational Extraction Schema editing. Operations
resolve once through a central route resolver rather than embedding provider
selection in each endpoint. A missing route fails explicitly and never falls
back to another route or configuration source. A model missing from the latest
advisory catalog remains selected and is still attempted; any provider failure
is returned rather than triggering substitution.

Each operation resolves one immutable configuration snapshot. Ollama Extraction
Routes explicitly choose the NuExtract raw protocol or the general model
protocol; provider identity and model-name guessing never choose for them.
