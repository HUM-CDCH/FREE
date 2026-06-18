## 1. Source Context

- [x] 1.1 Add `SourceContextBuilder` tests showing annotation-backed source material is included with annotation text and page number.
- [x] 1.2 Implement annotation rendering in `shared/source_context.py` using neutral source-facing wording.
- [x] 1.3 Confirm extraction schema text, researcher instructions, template-generation guidance, and annotation-mode guidance are not accepted as source-context concerns.

## 2. Schema Suggestion Pipeline

- [x] 2.1 Convert `/generate-template` parsed annotation payloads into shared `SourceAnnotation` values before pipeline execution.
- [x] 2.2 Update `GenerateTemplateRequest` and `GenerateTemplatePipeline` to pass annotations into `SourceContextRequest`.
- [x] 2.3 Refactor schema-suggestion guidance so it expresses annotation mode without duplicating annotation text.
- [x] 2.4 Preserve existing `/generate-template` route validation, request fields, response fields, and error behavior.

## 3. Verification

- [x] 3.1 Update request-construction or endpoint tests to prove schema suggestion receives annotation text through source content and not duplicated guidance.
- [x] 3.2 Run the backend unit suite with `.venv\\Scripts\\python.exe -m unittest discover -s tests`.
- [x] 3.3 Run `openspec validate promote-annotations-source-context --strict` from `E:\\progetti\\FREE`.
