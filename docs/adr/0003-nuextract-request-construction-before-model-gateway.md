# NuExtract Request Construction Before ModelGateway

NuExtract outbound request semantics will be assembled before a request reaches `ModelGateway`. A dedicated request-construction module will produce fully prepared `ModelRequest` values for extraction, schema suggestion, and markdown workflows: task prompt text, readable instruction/template controls, provider-neutral `template_kwargs`, reasoning, and temperature all travel together as one outbound request.

This keeps `ModelGateway` as the use-case-facing execution boundary and keeps provider adapters transport-focused. Providers should serialize already prepared content unchanged, map `template_kwargs` to provider payload fields such as OpenAI-compatible `chat_template_kwargs`, handle endpoint/header details, decode streaming chunks, and apply provider-specific transport controls such as Ollama's reasoning flag. Providers should not inject NuExtract task prompt text.

`/chat` remains generic for this change. Future context-control or bad-extraction repair should be introduced as a separate use case rather than folding NuExtract task semantics into the generic chat path prematurely.

## Considered Options

- **Keep prompt preparation in provider adapters** - rejected: it makes adapters responsible for model-task behavior and means `ModelRequest` is not actually prepared at the gateway boundary.
- **Keep raw NuExtract control dictionaries in every pipeline** - rejected: it spreads `mode`, `template`, `instructions`, and prompt duplication rules across use cases and makes drift likely.
- **Place the request builder under `model_providers/`** - rejected: NuExtract request construction is application/model-family semantics, not provider transport.
- **Move annotation rendering in the same change** - deferred: annotations are source context and annotation mode is task intent, but that is a separate source-context boundary change.

## Consequences

- NuExtract pipelines depend on typed request-builder methods instead of hand-assembling raw template kwargs.
- `ModelRequest.chat_kwargs` is renamed to provider-neutral `template_kwargs`; providers map it to concrete payload fields.
- `SourceContextBuilder` remains source-facing and does not own extraction schema text, task instructions, or prompt controls.
- Provider tests assert prepared content preservation; request-builder tests assert task prompt and template-kwargs construction.
- A later extraction-repair workflow can compose source context, prior extraction result, approved extraction schema, and user correction intent without changing generic chat semantics.
