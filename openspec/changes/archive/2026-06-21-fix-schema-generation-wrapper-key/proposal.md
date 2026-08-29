## Why

When `/generate-template` processes a document about a specific record (e.g. a grave report titled "Grav 8"), the model wraps all extracted fields under a record-identifier key like `"grav_8"`, producing:

```json
{ "grav_8": { "description": "...", "skeleton": {...} } }
```

instead of the correct flat structure:

```json
{ "description": "...", "skeleton": {...} }
```

This happens because the generation guidance contains no constraint against using record identifiers as top-level keys. The model correctly follows the NuExtract3 template pattern (which allows named top-level objects) and picks the document subject as the root key.

The consequence: the highlight layer receives a schema with a single top-level key (`grav_8`), so all fields get the same color and the depth-based color grouping is completely defeated. Researchers also get a schema they cannot directly use for extraction without manually editing it.

## What Changes

- `TEMPLATE_GUIDANCE` in `generate_template.py` gains an explicit constraint: top-level keys must be semantic field names, not record identifiers, document titles, or subject names.
- `_TEMPLATE_GENERATION_TASK_INSTRUCTIONS` in `nuextract_request.py` gets the same constraint — this is the message-text-channel equivalent used when the provider does not support template-kwargs mode.

## Capabilities

### New Capabilities

### Modified Capabilities
- `nuextract-request-construction`: The template-generation task instruction now includes a constraint against record-identifier wrapper keys.

## Impact

- `prototypes/mine/backend/use_cases/generate_template.py`: update `TEMPLATE_GUIDANCE`
- `prototypes/mine/backend/shared/nuextract_request.py`: update `_TEMPLATE_GENERATION_TASK_INSTRUCTIONS`
