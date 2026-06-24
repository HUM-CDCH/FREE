## 1. Build the sealed transport module

- [x] 1.1 Create `prototypes/mine/pdf-render/src/jsonlStream.ts` and move `API_BASE` and `readJsonLines` into it from `api.ts`
- [x] 1.2 Define the event-envelope types in the transport: `DeltaEvent` `{think, output, page?}`, `ErrorEvent` `{detail, raw?}`, `PageDoneEvent` `{page, markdown, reasoning}`, `DoneEvent<T>` `{data: T}`, and a discriminated `JsonlEvent<T>` union
- [x] 1.3 Implement `streamJsonl<T>(endpoint, form, handlers, decodeDone, signal)`: issue the POST with `accept: application/jsonl`, run `readJsonLines`, and dispatch `delta → onDelta(output, page?)`, `page_done → onPageDone?`, `error → throw new Error(detail)`, `done → return decodeDone(data)`
- [x] 1.4 Handle the edge cases ported from the current code: non-OK HTTP response, missing body, abort via `signal`, and stream closing with no `done` event (throw "stream ended without a result")

## 2. Rebuild api.ts as a thin domain layer

- [x] 2.1 Define the per-endpoint `done` payload types in `api.ts`: `ChatDone` `{message, reasoning, raw}`, `ExtractDone` `{result, reasoning, raw, pages}`, `TemplateDone` `{template, raw, pages}`, `MarkdownDone` `{pages, count}`
- [x] 2.2 Write one boundary decoder per payload (`decodeExtractDone`, `decodeTemplateDone`, …) that asserts the fields the frontend depends on and throws a named error on absence (e.g. `"extract: done payload missing 'result' — backend contract drift?"`)
- [x] 2.3 Remove the now-superseded scattered runtime guards (`typeof data.output === 'string'`, `isRecord(data.result)`) in favor of the decoders

## 3. Collapse existing wrappers onto the transport

- [x] 3.1 Re-implement `requestTemplate` on `streamJsonl<TemplateDone>` — same signature, `accept: application/jsonl`, abort handling; resolve with the parsed template
- [x] 3.2 Re-implement `requestExtraction` on `streamJsonl<ExtractDone>` — same signature; resolve with the extraction result object
- [x] 3.3 Confirm `App.tsx` and `useExtraction.ts` compile and call the wrappers unchanged (no signature edits at call sites) — verified via `tsc -b` and `vite build`

## 4. Verify behavior preservation

- [x] 4.1 Run the frontend against the backend and confirm template generation streams deltas and returns a template as before — verified live: 585 `delta` events (`{think, output}`) then one `done` `{template, raw, pages}` with `template` a real object
- [x] 4.2 Confirm extraction streams deltas, returns the result object, and that abort (re-run / unmount) still cancels the request — verified live: 539 `delta` events then `done` `{result, reasoning, raw, pages}` with `result` an object; mid-stream `fetch`+`signal` abort rejects with `AbortError`
- [x] 4.3 Sanity-check a forced drift case: a missing `done` field surfaces the named decoder error rather than a silent `undefined` — verified the `decodeExtractDone` predicate throws the named error on missing `result` and passes well-formed payloads

## 5. Review fixes

- [x] 5.1 P2: `streamJsonl` checks `signal?.aborted` before dispatching each (possibly buffered) event, so the transport itself honors the "no handlers fire after abort" scenario instead of relying on callers
- [x] 5.2 Add Vitest + `jsonlStream.test.ts` covering delta (with page), well-formed and malformed `page_done`, error, done, no-terminal-done, and buffered-line abort — repeatable protection for the centralized transport

## Deferred — out of scope for this change

- P3 (UX, follow-up): `streamJsonl` throws `response.text()` verbatim on a non-OK response, surfacing FastAPI's `{"detail": "..."}` as raw JSON. Parse `detail` in the shared transport for a cleaner message. Behavior-preserving relative to the old path, so not part of this change.


These land with their own features in a later change, so they are intentionally
not tracked as tasks here. The contract groundwork is already in place
(`ChatDone` / `MarkdownDone` types and `decodeChatDone` / `decodeMarkdownDone`
decoders in `api.ts`), so each is a ~3-line wrapper when its feature is wired:

- `requestChat` — `streamJsonl<ChatDone>` wrapper, when the chat feature is wired.
- `requestMarkdown` — `streamJsonl<MarkdownDone>` wrapper (passing `onPageDone`), when the markdown feature is wired. The transport's strict `page_done` handling already covers it.
