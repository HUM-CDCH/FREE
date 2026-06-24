## Why

The frontend talks to the backend's JSONL-streaming endpoints through hand-written fetch loops in `api.ts`. `requestTemplate` and `requestExtraction` are ~90% duplicate code (identical framing, differing only in URL, form fields, and how the terminal `done` event maps to a return value), and `/chat` and `/markdown` have no wrapper at all yet. The streaming/transport plumbing is tangled into per-feature code, so building the unfinished chat and markdown features means re-deriving the same JSONL loop again.

Separately, the event contract is untyped on both ends — the backend emits `data: dict[str, Any]`, the frontend reads it back as `unknown` behind scattered runtime guards (`typeof data.output === 'string'`, `isRecord(data.result)`). A renamed `done` field drifts silently into an `undefined` deep inside feature code.

We want to (1) collapse the duplication behind one transport so feature work stops re-implementing streaming, and (2) localize the drift surface to a single typed boundary that fails loud instead of silent.

## What Changes

- **New sealed transport module `jsonlStream.ts`** owning all JSONL plumbing: line framing (`readJsonLines`), the `streamJsonl<T>()` dispatch loop (`delta → onDelta`, `error → throw`, `page_done → onPageDone`, `done → decode + return`), the event-envelope types (`DeltaEvent` / `ErrorEvent` / `PageDoneEvent` / `DoneEvent<T>`), and `API_BASE`. It knows the envelope and nothing endpoint-specific. The dependency arrow points one way: feature code → `jsonlStream`, never back.
- **`api.ts` becomes a thin domain layer** on top of `streamJsonl<T>`. It holds — in this one file — the per-endpoint `done` payload types (`ChatDone`, `ExtractDone`, `TemplateDone`, `MarkdownDone`), one **boundary decoder per payload**, and the request wrappers.
- **Drift safety via boundary decoders**: scattered runtime guards are replaced by one decoder per `done` payload that asserts the fields the frontend depends on and throws a **named** error on absence (e.g. `"extract: done payload missing 'result' — backend contract drift?"`), so backend drift fails loud and localized on first run against `/docs` instead of flowing through as silent `undefined`.
- **`requestTemplate` and `requestExtraction` collapse onto the new transport**, behavior-preserving — same `accept: application/jsonl`, same abort handling, same return values.
- **`requestChat` and `requestMarkdown` become one-line wrappers** that land with their features (out of scope to wire here; the transport just makes them trivial).
- **Explicitly NOT adopting OpenAPI client codegen.** OpenAPI *can* describe JSONL, but not usefully for us yet. In 3.0/3.1 — what FastAPI 0.136.3 emits — a stream is documented as a custom media type with a whole-body `string` schema (the idiomatic form; `STREAM_RESPONSES` in `main.py` already does this for `application/jsonl`): the media type is named, but each item is not typed, so a generator has nothing per-item to emit. OpenAPI 3.2 adds `itemSchema` to type each streamed item — the missing piece — but FastAPI doesn't emit 3.2 and TS generators don't yet consume `itemSchema` into a streaming client. So a generated client today would type only the stable surface (paths, form fields), be blind to the event payloads, and steer toward the buffered non-streaming path. The transport (line framing + dispatch + terminal-`done` semantics) stays hand-written either way. See `design.md` for the concrete revisit trigger.

## Capabilities

### New Capabilities

- `frontend-api-client`: How the frontend consumes the backend's JSONL-streaming endpoints — the layered transport/domain split, the `streamJsonl<T>` contract, and the typed boundary-decoder drift guard.

### Modified Capabilities

<!-- None. This is a frontend client refactor; backend endpoint requirements (chat-endpoint) are unchanged. -->

## Impact

- **New file**: `prototypes/mine/pdf-render/src/jsonlStream.ts` (transport).
- **Rewritten**: `prototypes/mine/pdf-render/src/api.ts` (thin domain layer; `readJsonLines` and `API_BASE` move out to the transport module).
- **Unchanged callers**: `App.tsx` (`requestTemplate`) and `useExtraction.ts` (`requestExtraction`) keep the same function signatures — the refactor is behavior-preserving for existing features.
- **Backend**: no changes. The `application/jsonl` + buffered `application/json` contract in `main.py` is consumed as-is.
- **Out of scope / deferred upgrade paths**: typing the backend event payloads with Pydantic (within-backend drift stays a bet on `/docs` testing); OpenAPI codegen; OpenAPI spec enrichment.
