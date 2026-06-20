## Context

Schema suggestion guidance is assembled in two places:

1. `generate_template.py` — `TEMPLATE_GUIDANCE`: natural-language guidance appended to the source document content, used by both control channels.
2. `nuextract_request.py` — `_TEMPLATE_GENERATION_TASK_INSTRUCTIONS`: the task-level prompt prepended for the message-text channel (Ollama/providers that don't support template-kwargs).

Both are plain string constants. The model sees whichever is appropriate for the provider channel, then generates a JSON schema. Neither currently contains a constraint against record-identifier wrapper keys.

## Goals / Non-Goals

**Goals:**
- Prevent the model from producing `{ "record_id": { ...fields... } }` as the schema output.

**Non-Goals:**
- Validating or post-processing the generated schema on the backend.
- Changing the schema suggestion pipeline flow, model, or provider selection.

## Decisions

### Decision 1: Add the constraint as natural language in both guidance strings

The simplest and most portable fix is to append one sentence to each string. No structural change to the pipeline, no schema validation, no post-processing step. The constraint is: "Top-level keys must be semantic field names — do not wrap fields under a record identifier, document title, or subject name."

Adding it to both strings ensures the constraint reaches the model regardless of which control channel the provider uses.

### Decision 2: Phrase as prohibition, not as instruction

"Do not wrap" is more direct than "prefer flat keys". The model is less likely to hedge when the constraint is stated as a hard prohibition.
