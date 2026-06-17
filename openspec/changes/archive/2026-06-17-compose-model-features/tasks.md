## 1. Separate domain logic out of `parsing.py`

- [x] 1.1 Create `shared/json_repair.py`; move `quote_bare_hyphenated_numbers`, `parse_repaired_json_result`, and `parse_json_object_result` from `parsing.py` verbatim.
- [x] 1.2 Create `shared/temperature.py` with a `TemperaturePolicy` and `ReasoningTemperature` carrying the moved model-card rule (override honored, else 0.2/0.6). Delete `resolve_temperature` from `parsing.py`.
- [x] 1.3 Confirm `shared/parsing.py` now defines only the pure helpers and no temperature or repair code.

## 2. Result-parser strategies

- [x] 2.1 Create `shared/result_parsers.py` with a `ResultParser` and `StructuredParser` (`extract_answer_block` → `parse_json_object_result`, raising `ValueError` on irrecoverable input), `AnswerParser` (`extract_answer_block` → `parse_result`), and `TemplateParser` (`pretty_json_or_text` → `parse_result`). Keep them as separate, independently unit-testable units.

## 3. The uniform, stateless `ModelCall` composition root

- [x] 3.1 Create `shared/model_call.py` with a `Result` (`output`, `reasoning`, `value`) and a uniform `ModelCall` composing `{temperature, parser?, splitter?}`. Implement `collect(...) -> Result` (buffered) and `stream(...)` returning a per-request streamer that is async-iterable over `(think, output)` tuples and exposes `.result`.
- [x] 3.2 Keep `ModelCall` **stateless**: the per-request splitter and accumulation live on the per-request streamer (or local vars), never on the `ModelCall` instance.
- [x] 3.3 Ensure `model_call.py` imports **no** JSONL/streaming transport types — only `model_stream`, `think_splitter`, `temperature`, `result_parsers`.
- [x] 3.4 Trim `shared/streaming.py` to transport only: remove `jsonl_delta_events` and the `ThinkSplitter` import; keep `JsonLineEvent`, `JSONLResponse`, `JSONL_HEADERS`, `catch_model_errors`, `jsonl_response`. Provide a streaming OpenAPI `responses` block (json + jsonl) for `/chat` and a JSON-only block for the buffered endpoints.

## 4. Recompose the streaming use case (chat)

- [x] 4.1 `use_cases/chat.py`: compose a module-level `ModelCall(temperature=ReasoningTemperature(), splitter=ThinkSplitter)`; iterate `stream(...)`, wrap each `(think, output)` tuple into a `delta` `JsonLineEvent`, then emit `done` from `streamer.result`. Preserve the current `delta`/`done` payloads and the buffered `application/json` fallback. Expose the composed handler so tests can reach it.

## 5. Recompose the buffered use cases (extract, generate_template, markdown)

- [x] 5.1 `use_cases/extract.py`: compose `ModelCall(temperature=ReasoningTemperature(), splitter=ThinkSplitter, parser=StructuredParser() if use_structured else AnswerParser())`; call `collect(...)`, build `{result, reasoning, raw, pages}` (preserve the current `raw` reconstruction), return `JSONResponse`. Map unparseable structured output and `httpx.HTTPError` to `HTTPException(502, detail=…)` (detail distinguishes the two; include `raw` for the unparseable case). Use the JSON-only OpenAPI `responses`.
- [x] 5.2 `use_cases/generate_template.py`: compose `ModelCall(temperature=ReasoningTemperature(), parser=TemplateParser())` (reasoning off, no splitter); call `collect(...)`, build `{template, raw, pages}`, return `JSONResponse`. Keep annotation parsing, guidance, and the 400 validations; map `httpx.HTTPError` to 502.
- [x] 5.3 `use_cases/markdown.py`: render all pages, compose `ModelCall(temperature=ReasoningTemperature(), splitter=ThinkSplitter)`, send all page images in **one** `collect(...)` call in page order, build `{markdown, pages: <count>}`, return `JSONResponse`. Remove the per-page loop and `page_done`; map `httpx.HTTPError` to 502.

## 6. Wiring and public surface

- [x] 6.1 Update `shared/__init__.py` re-exports to the new homes (`temperature`, `json_repair`, `result_parsers`, `model_call`) and drop removed names (`resolve_temperature`, `jsonl_delta_events`).
- [x] 6.2 Update `main.py` public re-exports (e.g. `parse_json_object_result` now from `shared.json_repair`); confirm `main:app` and the `include_router` calls are unchanged.
- [x] 6.3 Verify the dependency direction: no `import main` in packages; `streaming.py` imports no `think_splitter`; `model_call.py` imports no transport types; no cross-`use_cases` imports.

## 7. Frontend (`pdf-render/src`)

- [x] 7.1 `api.ts`: rewrite `requestExtraction` and `requestTemplate` to a plain `POST` + `response.json()` decoded by `decodeExtractDone` / `decodeTemplateDone`, throwing on a non-`ok` response using its `detail`; drop the `onDelta` parameter. Change `MarkdownDone` to `{ markdown: string; pages: number }`.
- [x] 7.2 `App.tsx` and `useExtraction.ts`: drop the `onDelta` accumulation; replace the live `raw` build-up with a working indicator (spinner + "this can take a while on large documents") and populate `raw` from the final response on completion. Update `SchemaPanel` / the results view accordingly.
- [x] 7.3 `jsonlStream.ts`: remove the `page_done` / `onPageDone` / `MarkdownPageDoneEvent` machinery (no streaming endpoint emits `page_done` now); update `jsonlStream.test.ts`. Run `pnpm lint` and `pnpm build`.

## 8. Tests

- [x] 8.1 Unit-test `ReasoningTemperature` (explicit override honored; 0.2 with reasoning off, 0.6 with reasoning on).
- [x] 8.2 Unit-test `StructuredParser` repair (hyphenated ids, missing opening bracket) and its `ValueError`; cover `AnswerParser` and `TemplateParser`.
- [x] 8.3 Unit-test `ThinkSplitter` splitting reasoning from output over a single buffered `feed` (no streaming).
- [x] 8.4 Add the consistency test: against the same stubbed model stream, `collect()` and the accumulation of `stream()` yield the same value, reasoning, and raw.
- [x] 8.5 `test_extract_endpoint.py`: retarget the moved `parse_json_object_result` to `shared.json_repair`; rewrite endpoint assertions to the plain JSON object (`response.json()["result"]...`); change the invalid-JSON test to assert HTTP 502 with `detail`/`raw`; keep the `patch.object(extract, "call_model_stream", ...)` seam.
- [x] 8.6 `test_generate_template_endpoint.py`: retarget the patch seam to `call_model_stream` (no `generate_template_events`); assert the plain JSON object and the page count; keep the 400 tests.
- [x] 8.7 Add/adjust a markdown endpoint test: assert the plain `{markdown, pages}` object produced from a single (one) model call.
- [x] 8.8 `test_chat_endpoint.py`: keep the chat streaming assertions; rewrite `test_streaming_routes_advertise_jsonl_and_json_responses` so only `/chat` advertises `application/json` + `application/jsonl`, and `/extract`, `/generate-template`, `/markdown` advertise `application/json` only.
- [x] 8.9 Run `uv run python -m unittest discover -s tests -p "test_*.py"` from `prototypes/mine/backend`; confirm all tests pass.

## 9. Verify

- [x] 9.1 With `TestClient(main.app)`, confirm `/healthz`, a buffered `/chat`, and plain-object `/extract`, `/generate-template`, and `/markdown` all respond; check each endpoint's OpenAPI `200` content types (`/chat`: json + jsonl; the others: json only).
- [ ] 9.2 (Optional, requires a live model) run `uv run fastapi dev main.py` and smoke-test the endpoints via Swagger `/docs`.

## 10. Record follow-ups (out of scope for this change)

- [x] 10.1 Open tracked items for: verifying Ollama accepts the base64 `image_url:{url}` object shape (adapt `OllamaProvider` + add an image-content test if not); reconciling the `CLAUDE.md` ↔ `config.py` default-provider doc drift; and the `template` → Schema Suggestion rename.
