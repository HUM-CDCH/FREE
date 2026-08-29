## 1. Few-Shot Example Module

- [x] 1.1 Create `prototypes/mine/backend/shared/few_shot_examples.py` with a `FewShotExample` dataclass holding `schema_json: str` and `result_json: str`
- [x] 1.2 Write `STRUCTURED_EXTRACTION_EXAMPLE`: a mixed schema with one scalar field and one array-of-objects field, plus a correctly filled result where each `_evidence` snippet is a broader passage from the source containing the extracted value plus surrounding words — NOT a verbatim copy of the extracted field value (structure of `_evidence` keys is flexible)

## 2. Request Builder Update

- [x] 2.1 Add optional `few_shot: FewShotExample | None = None` parameter to `NuExtractRequestBuilder.structured_extraction`
- [x] 2.2 When `few_shot` is provided, prepend a text block to message content in both channels formatted as: `"Example of a correctly filled extraction:\n\nSchema:\n```json\n{schema_json}\n```\n\nCorrect output:\n```json\n{result_json}\n```"`

## 3. Pipeline Integration

- [x] 3.1 In `ExtractPipeline.run`, import `STRUCTURED_EXTRACTION_EXAMPLE` and pass it as `few_shot=` to `self._nuextract_requests.structured_extraction` when `use_structured` is true

## 4. Tests

- [ ] 4.1 Unit test: `structured_extraction` with `few_shot` set includes the example block in content before source content, for both message-text and template-kwargs channels
- [ ] 4.2 Unit test: `structured_extraction` with `few_shot=None` produces identical output to a call without the parameter
- [ ] 4.3 Unit test: every `{snippet, page}` leaf in `STRUCTURED_EXTRACTION_EXAMPLE.result_json`'s `_evidence` has a non-empty snippet that is longer than the corresponding extracted value (demonstrates broader passage)
