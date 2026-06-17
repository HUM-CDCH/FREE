## 1. Request Builder

- [x] 1.1 Add `shared/nuextract_request.py` with a typed NuExtract request builder that returns prepared `ModelRequest` values.
- [x] 1.2 Move NuExtract task instruction loading and prompt-prepending logic behind private helpers in `shared/nuextract_request.py`.
- [x] 1.3 Add builder methods for structured extraction, content extraction, template generation, and markdown.
- [x] 1.4 Add unit tests proving each builder method prepends the correct task prompt, duplicates readable controls where required, sets provider-neutral template kwargs, and preserves reasoning and temperature.

## 2. Gateway Request Shape

- [x] 2.1 Rename `ModelRequest.chat_kwargs` to `ModelRequest.template_kwargs`.
- [x] 2.2 Update `ModelGateway`, `ModelProvider`, `ModelCall` call sites, fake providers, and tests to use `template_kwargs` terminology at the internal boundary.
- [x] 2.3 Keep `/chat` generic by creating a plain `ModelRequest` with thinking controls only and without NuExtract task modes or task prompts.

## 3. Pipeline Wiring

- [x] 3.1 Compose and inject the NuExtract request builder into extraction, schema-suggestion, and markdown pipelines from `application.py`.
- [x] 3.2 Update `ExtractPipeline` so it builds source context from source material only and delegates structured/content request preparation to the builder.
- [x] 3.3 Update `GenerateTemplatePipeline` so it delegates template-generation request preparation to the builder while leaving annotation rendering behavior unchanged for this slice.
- [x] 3.4 Update `MarkdownPipeline` so it delegates markdown request preparation to the builder.
- [x] 3.5 Add or update pipeline tests proving NuExtract pipelines call typed construction behavior rather than assembling raw control dictionaries themselves.

## 4. Provider Adapter Cleanup

- [x] 4.1 Remove provider-side NuExtract prompt preparation from `model_providers/providers.py`.
- [x] 4.2 Update providers to serialize prepared content unchanged and map `template_kwargs` to `chat_template_kwargs`.
- [x] 4.3 Stop exporting NuExtract prompt-preparation helpers from `model_providers/__init__.py`.
- [x] 4.4 Update provider tests so they assert prepared content preservation, template-kwargs payload mapping, and Ollama reasoning behavior.

## 5. Documentation and Verification

- [x] 5.1 Add ADR `docs/adr/0003-nuextract-request-construction-before-model-gateway.md` documenting the boundary decision.
- [x] 5.2 Run `openspec validate deepen-nuextract-request-construction --strict` from `E:\progetti\FREE`.
- [x] 5.3 Run `.venv\Scripts\python.exe -m unittest discover -s tests` from `E:\progetti\FREE\prototypes\mine\backend`.
