# 0011: One Model Configuration page after the vLLM move

Date: 2026-09-23. Status: accepted; amends
[0007](0007-two-explicit-model-capability-routes.md) and the Studio part of
[0010](0010-serve-extraction-models-from-vllm.md); amended by
[0013](0013-per-researcher-model-configuration.md) and
[0015](0015-extraction-method-pinned-at-admission.md).

## Context

After [0010](0010-serve-extraction-models-from-vllm.md), Extraction runs in the
Parsing Service on its own vLLM models, chosen per run in Studio's header.
The Extraction Route no longer served Extraction, only Schema Suggestion, and
a fresh deployment had no route at all: Generate schema failed with
`invalid_model_config: The extraction Capability Route is not configured.`
The one NuExtract option, raw NuExtract, only worked on Ollama, which the
deployment no longer runs. Model choice lived in two places.

## Decision

The Model Configuration page (the former Model Connections dialog) holds every
model choice:

- **Extraction**: the Extraction Model Choice, a field model and a reasoning
  model from the Parsing Service's listing, is saved deployment-wide
  (`extractionModels` in `model-config.json`). The server applies it to every
  single and Batch Extraction; clients no longer send one, and the header
  offers none.
- **Routes**: the Extraction Route is renamed the Schema Suggestion Route
  (`routes.schemaSuggestion`). Beside it the Interaction Route is unchanged.
- **Connections**: a `vllm` provider kind sends `enable_thinking: false`
  through `chat_template_kwargs`. The NuExtract protocol replaces raw
  NuExtract: on a vLLM connection, Schema Suggestion asks NuExtract3 for
  `template-generation` through its chat template.

The deployment's own vLLM servers are **deployment connections**: described by
`FREE_DEPLOYMENT_*` variables, listed read-only, never saved, with reserved
UUIDs a route may name. A route left unset runs on the deployment's
instruction model. This reverses 0007's "a missing route fails explicitly and
never falls back": the fallback is to one named, visible default, and without
one the route still fails explicitly.

## Consequences

Generate schema works on a fresh GPU deployment without configuration. A
Batch Extraction now carries the Extraction Model Choice, and a batch reused by
selection includes it in its identity. An idempotent replay of a single
Extraction whose configured choice changed in between is refused as a
conflict.

## Amendment (0013, 2026-09-26)

The page edits the signed-in researcher's own configuration, which lives in
PostgreSQL, not in `model-config.json`. It has Models and Connections tabs;
Models follows the researcher's work in three steps (reading documents,
schema and chat, extracting data) and has no Single/Routes mode.
`extractionModels` and `ingestionModels` belong to the account's
configuration. The configuration is validated on every write, so the reset
and `DELETE /api/model_config` are gone, and nothing is kept in a keyring.

## Amendment (0015, 2026-09-29)

Clients again send the Extraction Model Choice: every start submits the choice
and the Extraction Method Settings its view showed, and admission refuses a
stale one and pins the rest on the Extraction (see
[0015](0015-extraction-method-pinned-at-admission.md)). An identical repeat of
a start replays its admitted Extraction even if the account's choice changed
since; only a different request under the same ID conflicts. The page has
Models, Connections and Advanced tabs.
