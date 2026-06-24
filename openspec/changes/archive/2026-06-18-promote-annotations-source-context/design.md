## Context

`CONTEXT.md` defines Source Context as source material and annotations from a single source document. The backend already has `SourceAnnotation` and an `annotations` slot on `SourceContextRequest`, but `SourceContextBuilder` currently ignores annotations. `/generate-template` parses annotation payloads in `use_cases/generate_template.py` and renders them into schema-suggestion guidance, mixing source material with task intent.

ADR 0003 deliberately deferred annotation rendering as a separate source-context boundary change. This change takes that deferred step without revisiting NuExtract control-channel placement.

## Goals / Non-Goals

**Goals:**

- Make `SourceContextBuilder` assemble annotation-backed source material alongside direct text and prepared source-document content.
- Keep schema-suggestion task intent, including annotation mode, in `GenerateTemplatePipeline`.
- Preserve the existing `/generate-template` route contract and response shape.
- Keep extraction schemas, researcher instructions, and NuExtract prompt controls outside source context.

**Non-Goals:**

- No frontend API rename from `generate-template` to schema-suggestion terminology.
- No persistence model for annotations or annotation sets.
- No change to NuExtract control-channel selection, provider adapters, or `ModelGateway`.
- No direct extraction annotation input unless a future API change introduces it.

## Decisions

1. `SourceContextBuilder` will render annotations as source-facing text entries.

   The builder already owns source-document content and direct source text, and the domain glossary says annotations are part of source context. Keeping rendering there gives future workflows one reusable representation instead of copying annotation formatting into each use case.

   Alternative considered: keep annotation rendering in `GenerateTemplatePipeline`. Rejected because it keeps schema suggestion responsible for source material and makes extraction or repair workflows reimplement the same formatting later.

2. Annotation mode remains schema-suggestion task intent.

   `annotations_mode` changes how schema suggestion should use annotations: as hints over the whole document or as the primary source for fields. That is task intent, not source material. The pipeline should translate mode into concise schema-suggestion guidance while the builder contributes the annotation text itself.

   Alternative considered: move mode into `SourceContextRequest`. Rejected because it would make source context depend on a schema-suggestion policy.

3. Route parsing converts payload annotations to shared source annotations before building context.

   The HTTP adapter can keep accepting the current `{text, pageNumber}` JSON payload. Internally, `GenerateTemplateRequest` should carry `SourceAnnotation` values so pipelines speak shared source-context language.

   Alternative considered: reuse the route-facing Pydantic model throughout the pipeline. Rejected because it couples source-context assembly to external field naming.

## Risks / Trade-offs

- Duplicate annotation text may be visible if task guidance continues listing annotations after the builder starts rendering them -> Remove annotation text from schema-suggestion guidance and test the generated model request content.
- Annotation rendering format could become overly specific to schema suggestion -> Use neutral source-material wording, not field-derivation instructions.
- Moving annotation types can disturb route validation errors -> Keep the current payload validation shape and assert invalid annotation input still returns HTTP 400.
