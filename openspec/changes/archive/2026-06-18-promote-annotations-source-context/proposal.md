## Why

Annotations are product language for source material, but schema suggestion still renders annotation text inside task-specific guidance. This leaks source-context assembly into schema-suggestion task code and prevents extraction or future workflows from reusing annotation-backed source material consistently.

## What Changes

- Move annotation-backed source material assembly into `SourceContextBuilder`.
- Keep annotation mode as schema-suggestion task intent owned by the schema-suggestion pipeline.
- Convert route-level annotation payloads into shared `SourceAnnotation` values before source context is built.
- Preserve existing `/generate-template` request and response shapes.
- Add coverage proving annotations appear in source context and are not rendered by schema-suggestion-specific guidance helpers.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `application-composition`: Source context assembly now includes annotation-backed source material, not only a future annotation slot.
- `nuextract-request-construction`: Schema suggestion receives annotation-backed source material through source content while task guidance remains schema-suggestion intent.

## Impact

- Affected backend files: `shared/source_context.py`, `use_cases/generate_template.py`, and related tests.
- API compatibility: no external request or response shape change for `/generate-template`.
- Dependencies: none.
