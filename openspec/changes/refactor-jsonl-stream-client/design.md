## Context

The backend (`prototypes/mine/backend/main.py`) exposes four model-backed endpoints — `/chat`, `/extract`, `/generate-template`, `/markdown` — that stream a sequence of `{event, data}` JSON Lines (`application/jsonl`), with a buffered `application/json` array fallback for Swagger UI and tests. The event envelope is uniform: `delta` `{think, output, page?}`, `error` `{detail, raw?}`, `page_done` `{page, markdown, reasoning}` (markdown only), and a terminal `done` whose payload varies per endpoint.

On the frontend (`prototypes/mine/pdf-render/src/api.ts`), `readJsonLines` plus two near-identical fetch loops (`requestTemplate`, `requestExtraction`) carry this contract. The two functions differ only in URL, form fields, and how `done` maps to a return value; `/chat` and `/markdown` are unwired. The event payloads are untyped on both ends — backend `data: dict[str, Any]`, frontend `unknown` read behind scattered guards — so a renamed field drifts silently.

Constraint from prior project decisions: the buffered `application/json` mode must keep working (the user tests via `/docs`), and the streaming path uses `accept: application/jsonl`.

## Goals / Non-Goals

**Goals:**

- Collapse the duplicate streaming logic behind one transport so feature code stops re-deriving the JSONL loop.
- Make `/chat` and `/markdown` wrappers trivial to add when those features are built.
- Localize the FE↔BE drift surface to one typed boundary per endpoint that fails loud, not silent.
- Keep the change behavior-preserving for `App.tsx` and `useExtraction.ts`.

**Non-Goals:**

- Typing the backend event payloads with Pydantic (within-backend drift stays a bet on `/docs` testing). Noted as a future upgrade path.
- OpenAPI client codegen or OpenAPI spec enrichment.
- Wiring the `/chat` and `/markdown` features themselves — only their thin wrappers are unblocked here.
- Any backend change.

## Decisions

### Decision: Hand-written shared TypeScript, not OpenAPI codegen

OpenAPI can *describe* a JSONL stream — but a description is only useful to a code generator once the whole toolchain supports it, and ours doesn't yet. Three gates:

- **Spec** — 3.0/3.1 documents a stream as a custom media type with a whole-body `string` schema. That is the idiomatic form, and `STREAM_RESPONSES` in `main.py` already does it for `application/jsonl`; it names the media type but does not type each item. OpenAPI **3.2** adds `itemSchema` to type each streamed item independently — the missing piece. ✅ at 3.2.
- **Producer** — FastAPI 0.136.3 (pinned here) emits OpenAPI **3.1.0**, which has no `itemSchema`. Getting per-item types into the spec means hand-authoring the `responses` dict — the same manual work as `STREAM_RESPONSES`, and *not* derived from Pydantic, since there are no typed event models. ❌.
- **Consumer** — `openapi-typescript` targets 3.0/3.1; `orval` is axios-based with streaming unsupported; the OpenAPI docs themselves warn tools must catch up. No mature generator turns `itemSchema` into a typed streaming async-iterator client. ❌.

Even with all three green, `itemSchema` describes a *homogeneous* item, whereas our stream is a *heterogeneous, ordered* protocol (many `delta`, one terminal `done`/`error`, payload varying per endpoint). The "which item is terminal and is the return value" logic — `decodeDone` plus the dispatch loop — stays hand-written regardless. And the cross-language sync payoff only materializes once `itemSchema` is generated *from* typed backend event models, which is a deferred non-goal.

So a generated client today would type only the stable surface (paths, the five form fields), be blind to the churning event payloads, and key off the `application/json` schema — steering toward the buffered (non-streaming) path the live UI does not want.

**Alternatives considered:** (a) Full generated client (orval / hey-api) — rejected: no JSONL streaming support, wrong default path. (b) Types-only generation (openapi-typescript) — rejected for now: FastAPI emits 3.1 (no `itemSchema`), so there are no per-item types to generate until both the producer emits 3.2 from typed models and the generator consumes it.

**Revisit trigger:** adopt codegen when **(a)** FastAPI emits 3.2 `itemSchema` derived from typed response models *and* **(b)** a TS generator consumes `itemSchema` into a streaming async-iterator client. The chosen architecture is forward-compatible: `streamJsonl<T>` + the per-endpoint `Done` types map ~1:1 onto `itemSchema` + generated item types, so the later switch is a swap of the type source, not a rewrite.

### Decision: Two layers — sealed transport `jsonlStream.ts` + thin domain `api.ts`

Generic-and-stable goes downstairs, specific-and-churning stays upstairs. `jsonlStream.ts` owns `readJsonLines`, `streamJsonl<T>`, the envelope types (`DeltaEvent` / `ErrorEvent` / `PageDoneEvent` / `DoneEvent<T>`), and `API_BASE`; it knows the envelope and nothing endpoint-specific. `api.ts` imports `streamJsonl<T>` and holds the per-endpoint `done` types, decoders, and request wrappers. The dependency arrow is one-way (features → transport), so feature work can't perturb the transport and the transport can't churn under a feature.

**Alternative considered:** Per-feature colocation of each `Done` type/decoder/wrapper next to its feature module. Rejected for this prototype in favor of single-file `api.ts` colocation — the whole contract is visible at a glance. Per-feature split remains an option if features grow apart.

### Decision: The sealed transport surface

```
streamJsonl<T>(
  endpoint: string,
  form: FormData,
  handlers: { onDelta: (output: string, page?: number) => void
              onPageDone?: (p: { page: number; markdown: string; reasoning: string | null }) => void },
  decodeDone: (data: unknown) => T,
  signal?: AbortSignal,
): Promise<T>
```

One signature covers all four endpoints. `onPageDone` is optional — only `/markdown` passes it. The loop maps `delta → onDelta`, `page_done → onPageDone`, `error → throw Error(detail)`, `done → decodeDone(data)` (the resolved value); a closed stream with no `done` throws.

### Decision: One boundary decoder per `done` payload

Replace scattered guards (`typeof data.output === 'string'`, `isRecord(data.result)`) with one decoder per endpoint that asserts only the fields the frontend depends on and throws a named error on absence, e.g. `decodeExtractDone` throwing `"extract: done payload missing 'result' — backend contract drift?"`. Drift then surfaces at one boundary, on the first run against `/docs`, with a message that names the cause — the closest approximation to codegen's safety without any tooling.

## Risks / Trade-offs

- **Residual BE↔FE drift not auto-closed** (two definitions: Python dicts and TS types) → Mitigation: the boundary decoders make drift fail loud and localized on first run; `/docs` manual testing is the existing safety net. Backend Pydantic typing is the documented upgrade path if this ever feels insufficient.
- **Refactor could change behavior of working features** (`requestTemplate` / `requestExtraction`) → Mitigation: behavior-preserving rewrite — same signatures, same `accept` header, same abort semantics, same return values; callers untouched and verified against the running app.
- **Abort/edge-case regressions in the shared loop** (the old code handled `signal`, empty trailing buffer, `[DONE]`-less close) → Mitigation: port the existing `readJsonLines` semantics verbatim into the transport; cover delta / error / done / abort / no-terminal-done in the spec scenarios.

## Migration Plan

1. Add `jsonlStream.ts` (transport) — move `readJsonLines` and `API_BASE` out of `api.ts`; add `streamJsonl<T>` and envelope types.
2. Rebuild `api.ts` on the transport: define `ChatDone` / `ExtractDone` / `TemplateDone` / `MarkdownDone`, their decoders, and re-implement `requestTemplate` / `requestExtraction` as thin wrappers.
3. Verify existing features (`App.tsx` template generation, `useExtraction.ts` extraction) behave identically against the running backend.
4. (Later, with their features) add `requestChat` / `requestMarkdown` one-liners.

Rollback: the change is additive plus a localized rewrite of `api.ts`; revert the two files to restore prior behavior.
