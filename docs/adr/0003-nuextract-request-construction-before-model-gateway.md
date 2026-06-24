# NuExtract Request Construction Before ModelGateway

NuExtract outbound request semantics will be assembled before a request reaches `ModelGateway`. A dedicated request-construction module will produce fully prepared `ModelRequest` values for extraction, schema suggestion, and markdown workflows, and it will select one authoritative NuExtract control channel from an explicit provider capability.

The two supported control channels are message text and OpenAI-compatible `chat_template_kwargs`. Ollama-style OpenAI-compatible serving uses message text for NuExtract task controls because the local probe showed kwargs-only controls were not applied. NuExtract-aware vLLM and Docker Model Runner serving can use `chat_template_kwargs` as the authoritative channel; message content then carries source context and natural-language schema-suggestion input, not duplicate extraction schema or researcher-instruction controls.

This keeps `ModelGateway` as the use-case-facing execution boundary and keeps provider adapters transport-focused. Providers should serialize already prepared content unchanged, map provider-neutral `template_kwargs` to payload fields such as OpenAI-compatible `chat_template_kwargs`, handle endpoint/header details, decode streaming chunks, and apply provider-specific transport controls such as Ollama's reasoning flag. Providers should not inject NuExtract task prompt text or decide which NuExtract control channel is authoritative.

`/chat` remains generic for this change. Future context-control or bad-extraction repair should be introduced as a separate use case rather than folding NuExtract task semantics into the generic chat path prematurely.

## Considered Options

- **Keep prompt preparation in provider adapters** - rejected: it makes adapters responsible for model-task behavior and means `ModelRequest` is not actually prepared at the gateway boundary.
- **Always duplicate controls in message text and template kwargs** - rejected: provider probes showed precedence differs by runtime, so duplicated controls can make stale message text override structured kwargs.
- **Keep raw NuExtract control dictionaries in every pipeline** - rejected: it spreads `mode`, `template`, `instructions`, and prompt rules across use cases and makes drift likely.
- **Place the request builder under `model_providers/`** - rejected: NuExtract request construction is application/model-family semantics, not provider transport.
- **Move annotation rendering in the same change** - deferred: annotations are source context and annotation mode is task intent, but that is a separate source-context boundary change.

## Consequences

- NuExtract pipelines depend on typed request-builder methods instead of hand-assembling raw template kwargs.
- Application composition derives a NuExtract control-channel capability from provider settings and passes it into the request builder.
- `ModelRequest.chat_kwargs` is renamed to provider-neutral `template_kwargs`; providers map it to concrete payload fields without adding task semantics.
- `SourceContextBuilder` remains source-facing and does not own extraction schema text, task instructions, or prompt controls.
- Provider tests assert prepared content preservation; request-builder tests assert channel-specific task prompt and template-kwargs construction.
- A later extraction-repair workflow can compose source context, prior extraction result, approved extraction schema, and user correction intent without changing generic chat semantics.
