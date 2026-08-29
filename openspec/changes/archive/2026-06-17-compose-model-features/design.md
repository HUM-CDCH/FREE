## Context

The primary driver is **testability**: the team wants to test both the **streaming** and the **buffered** version of a model call easily, from one shared core — that is the reason for the composition design, not elegance for its own sake.

After `split-main-use-cases`, two things block that. `shared/parsing.py` mixes pure text/JSON helpers (`strip_code_fence`, `pretty_json_or_text`, `extract_answer_block`, `normalize_template`, `parse_result`) with domain logic — the temperature rule `resolve_temperature` and the NuExtract JSON-repair family (`quote_bare_hyphenated_numbers`, `parse_repaired_json_result`, `parse_json_object_result`). And streaming is hardwired: `ThinkSplitter` is only ever driven by `streaming.jsonl_delta_events`, so reasoning-splitting is welded to per-delta emission, and `/extract` / `/generate-template` stream when their only consumer wants one result.

Constraints carried forward:
- Runtime entry point stays `main:app`; the `use_cases → {shared, config, model_providers}`, `shared → {config, model_providers}` direction holds (no cycles, no `import main` in packages).
- `/chat` is governed by the archived `chat-endpoint` spec (streams `delta`+`done`, buffered JSON fallback, 400 on empty) and keeps that contract.
- Tests mock at the `patch.object(use_cases.<module>, "call_model_stream", ...)` seam.

Decisions taken with the requester during grilling: "both versions" = **streaming vs buffered**; composition via **injected strategy objects**; `/extract`, `/generate-template`, **and `/markdown`** ship buffered (plain JSON); `/chat` is the only streamer; model-side failures map to **HTTP 502**.

## Goals / Non-Goals

**Goals:**
- One shared model-call core, composed from injectable collaborators, with **both** a buffered and a streaming mode exposed on every handler — so both versions are testable without HTTP and are provably consistent.
- `parsing.py` holds only domain-agnostic helpers; temperature, JSON repair, and result parsing are injectable collaborators defined once.
- `ThinkSplitter` works over a buffered response; `streaming.py` imports no splitter; `model_call.py` imports no JSONL/transport types.
- `/extract`, `/generate-template`, `/markdown` return a plain JSON object; `/markdown` is a single multi-page call; `/chat` streams.
- Extracted values, reasoning, page counts, validation, and `NUEXTRACT3_*` config unchanged (the `/markdown` output shape is the one intended exception).

**Non-Goals:**
- No change to `/chat`'s contract, the `chat-endpoint` spec, or `model_providers/` (beyond what a later image-shape spike may do).
- No new endpoints, persistence, or dependencies.
- Repair logic *moves modules*; it is not rewritten.
- No generic plugin/registry framework; composition is explicit per use case.
- Out of scope (tracked as follow-ups): the Ollama `image_url` base64 shape spike, the `CLAUDE.md` ↔ `config.py` provider-default drift, and the `template` → Schema Suggestion rename.

## Decisions

### Target module layout

```
prototypes/mine/backend/
  shared/
    parsing.py         # PURE only: strip_code_fence, pretty_json_or_text,
                       #   extract_answer_block, normalize_template, parse_result
    temperature.py     # TemperaturePolicy + ReasoningTemperature (moved 0.2/0.6 rule)
    json_repair.py     # quote_bare_hyphenated_numbers, parse_repaired_json_result,
                       #   parse_json_object_result          (moved out of parsing.py)
    result_parsers.py  # ResultParser + StructuredParser, AnswerParser, TemplateParser
    model_call.py      # ModelCall (uniform, stateless) + Result; imports NO transport types
    think_splitter.py  # ThinkSplitter (unchanged; streaming-agnostic)
    model_stream.py    # bind_provider, get_model_provider, call_model_stream (unchanged)
    streaming.py       # JSONL TRANSPORT ONLY — imports NO ThinkSplitter
    pdf.py             # unchanged
  use_cases/
    chat.py              # STREAMING (only one);  ModelCall(splitter).stream(...)
    extract.py           # buffered; ModelCall(splitter, StructuredParser|AnswerParser).collect(...)
    generate_template.py # buffered; ModelCall(TemplateParser).collect(...)
    markdown.py          # buffered; ModelCall(splitter).collect(all pages, one call)
    health.py            # unchanged
```

### The injectable collaborators (strategies)

Illustrative; exact signatures finalized in code:

```python
# temperature.py — the moved model-card rule, now a strategy
class TemperaturePolicy(Protocol):
    def resolve(self, override: float | None, reasoning: bool) -> float: ...
class ReasoningTemperature:
    def resolve(self, override, reasoning):
        return override if override is not None else (0.6 if reasoning else 0.2)

# result_parsers.py — output -> result value (kept as separate units; each unit-testable)
class ResultParser(Protocol):
    def parse(self, output: str) -> Any: ...
class StructuredParser:  # extract_answer_block -> parse_json_object_result (repair); raises ValueError
class AnswerParser:      # extract_answer_block -> parse_result
class TemplateParser:    # pretty_json_or_text  -> parse_result
```

`ThinkSplitter` is the reasoning-splitter collaborator, injected as a class and constructed **per request** with the `reasoning` flag (or omitted where reasoning never applies).

### `ModelCall`: uniform, stateless, two modes — the heart of the testability goal

`ModelCall` composes `{temperature policy, optional splitter, optional parser}` and exposes **both** modes on every handler. It is composed once at module load and **shared across requests, so it holds no per-request state** — per-request state lives on a per-request streamer object.

```python
@dataclass
class Result:
    output: str            # answer channel (reasoning stripped)
    reasoning: str | None  # think channel, or None
    value: Any             # parser.parse(output) when a parser is set, else output

class ModelCall:
    def __init__(self, *, temperature, parser=None, splitter=ThinkSplitter): ...

    async def collect(self, content, chat_kwargs, *, reasoning, temperature) -> Result:
        """Buffered: drive call_model_stream to completion through a *local* splitter,
        then parse. Returns a value. The deterministic test / /docs seam."""

    def stream(self, content, chat_kwargs, *, reasoning, temperature):
        """Streaming: return a per-request streamer object that is async-iterable,
        yielding (think_delta, output_delta) TUPLES (domain data, not JSONL), and
        exposes `.result` (a Result) after iteration."""
```

- **Buffered use cases** (`extract`, `generate_template`, `markdown`) call `collect(...)`, map the `Result` into their plain dict, and return `JSONResponse`. Each assembles its own `raw` so the current `raw` shapes are preserved (extract wraps reasoning in `</think>`; the others use the output verbatim).
- **The streaming use case** (`chat`) iterates `stream(...)`, wraps each `(think, output)` tuple into a JSONL `delta` `JsonLineEvent`, then emits its `done` from `streamer.result`, and returns via `jsonl_response` (keeping the buffered `application/json` fallback).

Why tuples, not `JsonLineEvent`s: it keeps `model_call.py` free of all JSONL/transport types, so the composition root that decouples streaming does not itself import streaming. `streaming.py` stays transport-only and imports no `ThinkSplitter`. The old `jsonl_delta_events` is replaced by `ModelCall.stream` + chat's wrapping.

Why a per-request streamer object: `ModelCall` is shared and must be stateless; the streamer holds the per-request splitter and exposes `.result`, so two concurrent `/chat` requests never corrupt each other.

**Testability payoff (the goal):** every handler exposes `collect()` and `stream()`, so a test can drive **either** version from the same composed core without HTTP, and assert the **consistency invariant** — for the same stubbed model output, `collect().value/reasoning/raw` equals the accumulation of `stream()`'s deltas. This supersedes `split-main-use-cases`'s "streaming/reasoning are substitutable for tests" with a concrete, testable form.

**Alternatives considered:** function composition (callables + flags) — rejected, the requester chose strategy objects and they unit-test better; buffered-only `ModelCall` with a free streaming helper — rejected, you couldn't drive the streaming version of a use case from the same core; `delta_events()` yielding `JsonLineEvent`s — rejected, recouples the composition root to transport and tempts a stateful (buggy) implementation.

### Per-use-case composition

| Use case | mode | model calls | splitter | parser | response |
|----------|------|-------------|----------|--------|----------|
| chat | `stream()` | 1 | `ThinkSplitter(reasoning)` | none (raw text) | JSONL `delta`+`done` / buffered |
| extract | `collect()` | 1 (all pages) | `ThinkSplitter(reasoning)` | `StructuredParser` or `AnswerParser` | plain JSON `{result, reasoning, raw, pages}` |
| generate_template | `collect()` | 1 | none (reasoning off) | `TemplateParser` | plain JSON `{template, raw, pages}` |
| markdown | `collect()` | 1 (all pages, page order) | `ThinkSplitter(reasoning)` | none (raw text) | plain JSON `{markdown, pages}` |

`extract` selects `StructuredParser` vs `AnswerParser` per request from the `use_structured` flag it already computes. `markdown` sends all page images in one `collect()` call (per the NuExtract3 model card's multi-page guidance — the same one-call pattern `extract` already uses), dropping the per-page loop and `page_done`.

### Non-streaming response & error contract

Buffered endpoints return the result object directly (no event envelope): `/extract` → `{result, reasoning, raw, pages}`; `/generate-template` → `{template, raw, pages}`; `/markdown` → `{markdown, pages}`.

Model-side failures become **HTTP 502** (the API is a gateway; the upstream model failed, so blaming the client with a 4xx is wrong):
- model endpoint unreachable (`httpx.HTTPError`) → `HTTPException(502, detail="Model endpoint error: …")`
- `/extract` structured output unparseable → `HTTPException(502, detail={"message": "Model returned invalid JSON for the extraction result", "raw": <output>})`

Client-input validation stays **HTTP 400** (missing file/text, bad annotations mode). `catch_model_errors` remains only for the streaming endpoint (`/chat`).

### Frontend (`pdf-render/src`)

`requestExtraction` / `requestTemplate` drop `streamJsonl` / `onDelta` and become a plain `POST` + `response.json()`, decoded by the existing `decodeExtractDone` / `decodeTemplateDone`, throwing on a non-`ok` response using its `detail`. `App.tsx` / `useExtraction.ts` replace the live `raw` build-up (the deltas that fed `templateState.raw` / `state.raw`) with a **working indicator** (spinner + "this can take a while on large documents") and set `raw` from the final payload on completion. `jsonlStream.ts` loses its `page_done` / `onPageDone` / `MarkdownPageDoneEvent` machinery (no endpoint emits `page_done` now); `MarkdownDone` becomes `{ markdown: string; pages: number }`. `streamJsonl` survives for `/chat`.

### Public re-exports & test seams

`main.py` / `shared/__init__.py` re-exports point at the new homes (`shared.json_repair.parse_json_object_result`, `shared.temperature`, …). The mock seam stays `use_cases.<module>.call_model_stream` (each use case imports `call_model_stream` into its namespace; `ModelCall` calls that bound name), so the existing `patch.object` style works; the generate-template test that patches `generate_template_events` moves to the `call_model_stream` seam.

## Risks / Trade-offs

- **`ModelCall` statelessness** — storing the splitter/Result on the shared instance would corrupt concurrent requests. → Mitigation: per-request streamer holds state; spec scenario asserts it; code review checks no per-request attribute on `ModelCall`.
- **Lost live progress in the UI** — extraction/schema-suggestion no longer stream build-up; against a slow local vision model the panel sits idle. → Mitigation: explicit working indicator + final `raw`; accepted as the cost of the buffered contract.
- **`/markdown` long-document pressure** — one call with many page images can strain context. → Mitigation: not a regression — `/extract` already sends all pages in one call at DPI 64; same envelope.
- **Front/back contract drift during cutover** → Mitigation: backend + `api.ts` ship together; `decodeExtractDone` / `decodeTemplateDone` fail loud on shape drift.
- **502 is itself a breaking change** for clients that parsed in-band `error` events → Mitigation: only known consumer is `api.ts`, updated here; flagged BREAKING.
- **Untested image path on the default (Ollama) provider** — surfaced during grilling, left out of scope. → Mitigation: tracked as a follow-up spike + image-content test.

## Migration Plan

1. Move JSON-repair `parsing.py → json_repair.py`; move the temperature rule into `temperature.py`; leave `parsing.py` pure.
2. Add `result_parsers.py` (`StructuredParser` / `AnswerParser` / `TemplateParser`).
3. Add `model_call.py` (`ModelCall` uniform + stateless, `Result`, the per-request streamer); move splitter-driving out of `streaming.py`; trim `streaming.py` to transport (drop the `ThinkSplitter` import) and split its OpenAPI `responses` into a streaming block (chat) and a JSON-only block (the rest).
4. Recompose use cases: `chat` via `stream()` + JSONL wrapping; `extract` / `generate_template` / `markdown` via `collect()` + `JSONResponse` with the 502 mapping; `markdown` as one multi-page call returning `{markdown, pages}`.
5. Update `main.py` / `shared/__init__.py` re-exports.
6. Update the frontend (`api.ts`, `App.tsx`, `useExtraction.ts`, `SchemaPanel`/results view, `jsonlStream.ts` + its test).
7. Update tests (retarget moved symbols; rewrite the buffered endpoints' assertions; split the OpenAPI-advertise test) and add unit tests for `ReasoningTemperature`, `StructuredParser` repair, `ThinkSplitter`-over-buffered-text, and the buffered/streaming consistency test. Run the suite.
8. Record the out-of-scope follow-ups (Ollama image-shape spike, doc drift, `template` rename).

Rollback is a single revert of the change commit; no data or config migration.

## Open Questions

- None blocking. Resolved during grilling: "both versions" = streaming vs buffered; `/markdown` = single buffered multi-page call; errors = 502; UI = working indicator over live build-up.
