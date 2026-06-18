## Why

NuExtract request construction currently has two competing decisions in the worktree: one path duplicates task controls in both message text and `template_kwargs`, while the provider-control probe and official NuExtract examples point to a single authoritative control channel per provider capability. The change is needed now so implementation, ADRs, specs, and tests all encode the same contract before more extraction workflows depend on it.

## What Changes

- Add an explicit NuExtract task-control channel decision at application composition time: Ollama uses message text; vLLM/OpenAI-compatible providers use `template_kwargs`.
- Configure `NuExtractRequestBuilder` with that channel and keep its public API as typed workflow methods: structured extraction, content extraction, schema suggestion, and markdown.
- Ensure each NuExtract workflow places task controls in exactly one authoritative channel and does not duplicate extraction schema, researcher instructions, markdown mode, or template-generation mode across message text and `template_kwargs`.
- Keep `ModelRequest` plain: content, provider-neutral `template_kwargs`, reasoning, and temperature. Do not add control-channel metadata to `ModelRequest`.
- Keep provider adapters transport-only: they serialize prepared content and template kwargs, but do not decide NuExtract task semantics or control-channel placement.
- Extend the provider-control probe to cover all NuExtract workflows that FREE uses, not only structured extraction.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `nuextract-request-construction`: the request builder selects one authoritative task-control channel and exposes typed methods for the four NuExtract workflows.
- `application-composition`: application setup derives the NuExtract task-control channel from provider settings and injects it into the request builder.
- `model-provider-adapters`: provider adapters preserve prepared payload data without injecting task prompts or deciding control channels.

## Impact

- Affected backend modules: `application.py`, `shared/nuextract_request.py`, `use_cases/generate_template.py`, tests for request construction, application services, endpoints, and provider payloads.
- Affected prototype evidence: `tools/probe_provider_controls.py` and `tools/provider-control-probe-results.md` should cover structured extraction, content extraction, schema suggestion, and markdown.
- Public HTTP routes stay compatible: `/extract`, `/generate-template`, `/markdown`, and `/chat` keep their current request/response shapes.
- No new runtime dependencies are expected.
