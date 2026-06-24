## Why

Outbound NuExtract request semantics are still split across use-case pipelines and provider adapters. Pipelines must know raw `chat_kwargs` keys while providers still inject task prompt text, which makes the model gateway boundary less explicit and keeps provider adapters responsible for model-task behavior rather than transport.

## What Changes

- Add a dedicated NuExtract request-construction module that returns fully prepared `ModelRequest` values for extraction, schema suggestion, and markdown workflows.
- Rename the generic `ModelRequest` control field from `chat_kwargs` to provider-neutral `template_kwargs`.
- Move NuExtract task prompt prepending and readable control duplication for instructions/templates out of provider adapters and source-context assembly into the request builder.
- Keep `/chat` generic for this change; it should not use NuExtract task modes or task prompts.
- Update provider adapters so they serialize already prepared content unchanged and only map `template_kwargs` to OpenAI-compatible `chat_template_kwargs`.
- Add an ADR documenting the boundary: NuExtract outbound request semantics are assembled before `ModelGateway`; provider adapters are transport-only.

## Capabilities

### New Capabilities
- `nuextract-request-construction`: Internal construction of fully prepared NuExtract model requests from source context, task intent, template/instruction controls, reasoning, and temperature.

### Modified Capabilities
- `application-composition`: `ModelRequest` remains outbound-only, but uses provider-neutral `template_kwargs`; pipelines depend on a NuExtract request builder for NuExtract workflows instead of assembling raw request controls directly.
- `model-provider-adapters`: Provider adapters receive prepared model content and no longer inject NuExtract task prompts; they map generic template kwargs to provider payload fields.

## Impact

- Affected backend modules: `shared/model_gateway.py`, a new `shared/nuextract_request.py`, `use_cases/extract.py`, `use_cases/generate_template.py`, `use_cases/markdown.py`, `use_cases/chat.py`, `application.py`, `model_providers/providers.py`, `model_providers/__init__.py`, and tests.
- Affected docs: new ADR under `docs/adr/`.
- Public HTTP route behavior should remain unchanged.
