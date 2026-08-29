## Context

The backend has a clear model-call boundary: use-case pipelines build `ModelRequest` values, `ModelGateway` executes them, and provider adapters serialize provider payloads. The unresolved part is how NuExtract task controls are placed for different OpenAI-compatible runtimes.

Official NuExtract examples use OpenAI-compatible `chat_template_kwargs` for structured extraction, content extraction, markdown, and template generation. The local provider-control probe showed that Ollama's OpenAI-compatible endpoint did not apply kwargs-only extraction controls, while Docker Model Runner and vLLM both accepted kwargs-only controls and gave message text precedence when both channels conflicted. That makes duplicated controls unsafe: stale message text can override structured kwargs.

The domain language remains product-facing: schema suggestion and extraction schema are the canonical terms. Existing HTTP route names and JSON fields such as `/generate-template` and `template` are legacy API names and do not drive the internal design language.

## Goals / Non-Goals

**Goals:**

- Make the control-channel decision explicit and visible in application composition.
- Keep NuExtract request construction as the only module that knows task modes, task prompts, extraction schema placement, researcher-instruction placement, schema-suggestion guidance placement, and markdown mode placement.
- Keep use-case call sites readable through typed methods for structured extraction, content extraction, schema suggestion, and markdown.
- Keep `ModelRequest` provider-neutral and plain: content, `template_kwargs`, reasoning, and temperature.
- Keep provider adapters transport-only.
- Capture the official-docs plus local-probe decision in tests and probe results.

**Non-Goals:**

- Do not introduce a per-task policy object until a real workflow needs task-specific channel overrides.
- Do not put control-channel metadata on `ModelRequest`.
- Do not rename public HTTP routes or response fields in this change.
- Do not move annotation rendering into `SourceContextBuilder` in this change.
- Do not change parser selection or endpoint response contracts.

## Decisions

### Use a simple channel enum, not a policy object

Introduce a small enum such as `NuExtractTaskControlChannel` with `MESSAGE_TEXT` and `TEMPLATE_KWARGS`. Application composition maps `settings.provider` to that enum and passes it to `NuExtractRequestBuilder`.

Alternatives considered:

- A policy object with per-task overrides. Rejected for now because the decision is provider-wide for the official NuExtract workflows FREE uses. Adding override machinery would imply flexibility that is not currently needed.
- A generic `build(task, controls)` API. Rejected because it would push loosely typed control bags back into use cases and make call sites less clear.
- A `control_channel` field on `ModelRequest`. Rejected because it leaks NuExtract task semantics downstream and invites providers to branch on task behavior.

### Keep typed request-builder methods

The builder keeps explicit methods for `structured_extraction`, `content_extraction`, `schema_suggestion`, and `markdown`. These methods reflect the four workflows' different inputs and make tests direct.

`schema_suggestion` should be the internal builder method name even though the public route remains `/generate-template`. The method receives natural-language guidance, because official NuExtract template generation uses message content as the natural-language description and `chat_template_kwargs.mode = "template-generation"` as the mode control.

### Channel rules

For `MESSAGE_TEXT` providers such as Ollama:

- Message content carries task prompts and task controls.
- Structured extraction embeds the structured task prompt, researcher instructions, and extraction schema in message text.
- Content extraction embeds the content task prompt and researcher instructions in message text.
- Markdown embeds the markdown task prompt in message text.
- Schema suggestion embeds enough natural-language guidance in message text to request a schema suggestion without relying on template-generation kwargs.
- Task-control kwargs such as `mode`, `template`, and `instructions` are omitted.

For `TEMPLATE_KWARGS` providers such as vLLM/OpenAI-compatible NuExtract and Docker Model Runner:

- Message content carries source context and natural-language schema-suggestion guidance.
- Structured extraction places mode, extraction schema, and researcher instructions in `template_kwargs`.
- Content extraction places mode and optional researcher instructions in `template_kwargs`.
- Markdown places markdown mode in `template_kwargs` and leaves message content as source context.
- Schema suggestion places `mode: template-generation` in `template_kwargs` and keeps guidance as message text.

Thinking controls may still travel through `template_kwargs` because they are provider/model generation controls rather than duplicated extraction task controls.

### Extend probe evidence

The provider-control probe should cover the NuExtract workflows FREE depends on: structured extraction, content extraction, schema suggestion, and markdown. The probe results should record official-doc expectations and local runtime observations separately, so future changes can distinguish upstream contract from local serving behavior.

## Risks / Trade-offs

- **Risk: kwargs-only behavior differs across OpenAI-compatible runtimes** -> Mitigation: keep the provider capability explicit and extend the probe to each workflow.
- **Risk: message-text mode diverges from official NuExtract template behavior** -> Mitigation: keep message-text mode scoped to providers where local evidence shows kwargs are not applied, and test the resulting request shape.
- **Risk: future extraction repair needs different placement rules** -> Mitigation: add a policy object only when that workflow exists and proves it needs a task-specific override.
- **Risk: terminology drifts back to template in internal design** -> Mitigation: use schema suggestion and extraction schema in docs and internal method names, while preserving legacy API names at the route boundary.

## Migration Plan

1. Add the channel enum and provider-to-channel helper in the request-construction module or application composition boundary.
2. Configure `NuExtractRequestBuilder` with the derived channel in `application.py`.
3. Update builder methods to place task controls in exactly one channel.
4. Rename the builder method used by schema suggestion from `template_generation` to `schema_suggestion`, preserving the public route and response shape.
5. Update tests for both channel modes and verify no task-control duplication.
6. Extend the provider-control probe and results document to cover all four workflows.
7. Run OpenSpec validation and the backend unittest suite.

Rollback is straightforward: revert this change. No persisted data migration is required.

## Open Questions

None. The selected interface is a configured builder with a simple channel enum and typed workflow methods.
