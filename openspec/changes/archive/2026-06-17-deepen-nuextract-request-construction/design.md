## Context

The backend now has an explicit application composition container, use-case pipelines, a `ModelGateway`, and provider adapters. That split is close to the desired ports-and-adapters shape, but outbound NuExtract request semantics still cross the boundary in two directions:

- Use-case pipelines construct raw NuExtract control dictionaries with keys such as `mode`, `template`, `instructions`, and `enable_thinking`.
- Provider adapters still call NuExtract prompt-preparation helpers before serializing provider payloads.
- `SourceContextBuilder` is meant to assemble source-facing material only, but extraction currently appends readable task controls such as `Instructions:` and `Extraction template:` before source-context construction.

The result is a confusing ownership model. `ModelRequest` is described as prepared before it enters `ModelGateway`, but provider adapters still finish preparing NuExtract content. Provider adapters are described as transport-focused, but they still own model-task prompt behavior.

## Goals / Non-Goals

**Goals:**

- Make NuExtract outbound request construction a single deep module.
- Ensure `ModelRequest` values are fully prepared before they cross into `ModelGateway`.
- Rename `ModelRequest.chat_kwargs` to provider-neutral `template_kwargs`.
- Keep provider adapters transport-only: endpoint URL, headers, provider payload shape, streaming decode, and Ollama reasoning flag.
- Keep `/chat` generic for this change while preserving the option to add extraction repair/context control later as a separate workflow.
- Preserve current HTTP route behavior.

**Non-Goals:**

- Do not add chat history, extraction repair, or context-control features.
- Do not move annotation rendering into `SourceContextBuilder` in this change.
- Do not change result parser selection or put parsers into `ModelRequest`.
- Do not introduce new external dependencies.

## Decisions

### Add `shared/nuextract_request.py`

Create a NuExtract request builder module that accepts already assembled source context and returns `ModelRequest` values. It owns task mode selection, task prompt prepending, readable control duplication, template kwargs, reasoning, and temperature for NuExtract workflows.

Alternatives considered:

- Keep the helper under `model_providers/`: rejected because the helper is not transport code and would keep provider adapters coupled to model-task semantics.
- Keep construction inside each pipeline: rejected because it repeats raw control keys and lets prompt semantics drift by use case.

### Expose typed builder methods instead of raw control dictionaries

Pipelines should call methods such as structured extraction, content extraction, template generation, and markdown. The extraction pipeline can still decide whether a request is structured or content extraction because that is use-case behavior, but it should not assemble `mode`, `template`, `instructions`, or duplicated prompt text itself.

Alternatives considered:

- A generic `build(mode, **kwargs)` method: rejected because it would preserve the raw control-bag interface under a new name.
- Separate builders per use case: rejected for now because the shared invariant is small and coherent.

### Rename `chat_kwargs` to `template_kwargs`

`ModelRequest` should remain generic and outbound-only, but `chat_kwargs` names an OpenAI-compatible implementation detail. `template_kwargs` is provider-neutral at the gateway boundary; OpenAI-compatible providers map it to `chat_template_kwargs`.

Alternatives considered:

- Keep `chat_kwargs`: rejected because it keeps callers thinking in provider payload terms.
- Add provider-specific request subclasses: rejected because there is currently one model family and one gateway path.

### Provider adapters serialize prepared content unchanged

Providers should stop calling NuExtract prompt-preparation helpers. They should put `request.content` into the user message as-is and map `template_kwargs` into the payload. Ollama may still translate `enable_thinking` into its provider-specific `reasoning` field because that is transport/provider behavior.

Alternatives considered:

- Runtime guards that reject unprepared NuExtract content in providers: rejected because regression tests and module boundaries are enough, and runtime rejection would add defensive machinery without user-facing value.

### Keep annotation rendering out of this slice

Annotations are source context and annotation mode is task intent, but moving annotation rendering now would mix two boundary changes. This change leaves schema-suggestion annotation text where it is unless needed to route through the new builder; a later change can promote annotations into `SourceContextBuilder`.

## Risks / Trade-offs

- Existing tests may assert provider-side prompt injection. -> Update tests so builder tests prove prompt preparation and provider tests prove content preservation.
- The builder could become a grab bag. -> Keep public methods typed and task-specific; keep low-level prompt helpers private.
- `template_kwargs` may still contain NuExtract-specific keys. -> Accept that the values are model-family semantics, but keep the field name generic and the construction centralized.
- `/chat` future repair use cases may need NuExtract semantics. -> Keep `/chat` unchanged now and add a separate repair/correction pipeline later when requirements are concrete.

## Migration Plan

1. Add the request builder and unit tests for prepared content and template kwargs.
2. Rename `ModelRequest.chat_kwargs` to `template_kwargs` across gateway, provider protocol calls, and tests.
3. Inject the builder into NuExtract pipelines from `application.py`.
4. Update extract, generate-template, and markdown pipelines to request prepared `ModelRequest` values from the builder.
5. Remove provider-side NuExtract prompt preparation and stop exporting prompt-preparation helpers from `model_providers`.
6. Add an ADR documenting the outbound request boundary.
7. Run the backend unittest suite.

Rollback is straightforward: revert the change. No persisted data or public API migration is required.

## Open Questions

- None for this slice. Annotation rendering and extraction repair/context-control remain separate future decisions.
