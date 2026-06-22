## Why

NuExtract is a template-filling model guided only by natural-language instructions and the template structure. For complex schemas (arrays of objects, nested fields), the model produces inconsistent output — especially in the `_evidence` block — because it has no concrete example to follow. Adding few-shot examples (a sample schema and a sample filled result) gives the model a concrete behavioural anchor and significantly reduces structural errors.

## What Changes

- The backend gains a few-shot example registry: a collection of (schema, result) pairs that demonstrate correct extraction output.
- The NuExtract request builder is updated to embed a few-shot example in the extraction prompt when one is available for the given schema shape.
- The example selection logic picks the example whose schema shape most closely matches the request schema (scalar-only, array-of-objects, mixed).
- No changes to the API surface — this is internal prompt engineering only.

## Capabilities

### New Capabilities
- `nuextract-few-shot`: Embedding schema+result few-shot examples into NuExtract extraction requests to improve structural consistency.

### Modified Capabilities
- `nuextract-request-construction`: The structured-extraction request builder gains an optional few-shot example parameter that is rendered into the message content or template kwargs depending on the authoritative control channel.

## Impact

- `prototypes/mine/backend/shared/nuextract_request.py` — structured extraction method gains few-shot example rendering
- `prototypes/mine/backend/shared/` — new `few_shot_examples.py` module with example registry and selection logic
- `prototypes/mine/backend/use_cases/extract.py` — passes selected few-shot example to request builder
- No frontend changes
- No API contract changes
