## 1. Request-Builder Channel API

- [x] 1.1 Add `NuExtractTaskControlChannel` with `MESSAGE_TEXT` and `TEMPLATE_KWARGS` values in the NuExtract request-construction boundary.
- [x] 1.2 Add `nuextract_control_channel_for_provider()` mapping `ollama` to message text and `vllm`/`openai` to template kwargs.
- [x] 1.3 Configure `NuExtractRequestBuilder` with the selected task-control channel without adding channel metadata to `ModelRequest`.
- [x] 1.4 Rename or wrap the builder's template-generation method as `schema_suggestion` while preserving `/generate-template` route compatibility.

## 2. Channel-Specific Request Construction

- [x] 2.1 Update structured extraction so message-text mode embeds the task prompt, extraction schema, and researcher instructions in content while omitting task-control kwargs.
- [x] 2.2 Update structured extraction so template-kwargs mode keeps message content source-only and places mode, extraction schema, researcher instructions, and thinking in `template_kwargs`.
- [x] 2.3 Update content extraction so researcher instructions are placed in exactly one authoritative channel.
- [x] 2.4 Update schema suggestion so natural-language guidance remains message content and template-kwargs mode uses `mode: template-generation` without duplicating task controls.
- [x] 2.5 Update markdown so message-text mode embeds markdown instructions and template-kwargs mode uses `mode: markdown` with source-only message content.
- [x] 2.6 Keep thinking/reasoning controls available as generation controls without treating them as duplicated task controls.

## 3. Application and Provider Boundaries

- [x] 3.1 Wire application composition to derive the NuExtract task-control channel from `Settings.provider` and inject it into `NuExtractRequestBuilder`.
- [x] 3.2 Keep use-case pipelines calling typed request-builder methods rather than constructing raw `mode`, `template`, or `instructions` dictionaries.
- [x] 3.3 Verify provider adapters preserve prepared content and template kwargs without injecting NuExtract task prompts or deciding control-channel placement.

## 4. Tests and Probe Evidence

- [x] 4.1 Add request-builder tests for message-text mode across structured extraction, content extraction, schema suggestion, and markdown.
- [x] 4.2 Add request-builder tests for template-kwargs mode across structured extraction, content extraction, schema suggestion, and markdown.
- [x] 4.3 Add application-composition tests proving `ollama`, `vllm`, and `openai` select the expected task-control channel.
- [x] 4.4 Update endpoint and provider tests affected by channel-specific request shapes.
- [x] 4.5 Extend `prototypes/probe_provider_controls.py` to probe structured extraction, content extraction, schema suggestion, and markdown.
- [x] 4.6 Update `prototypes/provider-control-probe-results.md` with the expanded probe cases and the official-docs-versus-local-runtime decision.

## 5. Verification

- [x] 5.1 Run `openspec validate select-nuextract-control-channel --strict` from `E:\progetti\FREE`.
- [x] 5.2 Run `.venv\Scripts\python.exe -m unittest discover -s tests` from `E:\progetti\FREE\prototypes\mine\backend`.
- [x] 5.3 Review the final diff to confirm route contracts remain unchanged and no NuExtract task semantics moved into provider adapters.
