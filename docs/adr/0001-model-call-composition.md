# ADR 0001 — Model-call composition: buffered by default, streaming for chat, both modes testable from one core

The backend's model-call spine (`call_model_stream` → reasoning split → result parse) is composed through a single uniform `ModelCall` that exposes two run modes — `collect()` (buffered, returns a value) and `stream()` (yields `(think, output)` deltas). Endpoints ship buffered (`/extract`, `/generate-template`, `/markdown` return one JSON object) except `/chat`, which streams; but every composed handler carries **both** modes so the streaming and buffered versions are **independently testable from one shared core** and provably consistent (same model output ⇒ `collect()` equals the accumulation of `stream()`). Testing both versions easily is the primary goal of this design.

## Considered Options

- **Buffered-only `ModelCall`** (streaming kept as a separate helper used only by chat) — rejected: you could not drive the streaming version of a use case in a test from the same composed core, defeating the goal.
- **Runtime stream/buffer toggle on each endpoint** — rejected: it keeps a streaming path live on `/extract` in production, which we explicitly do not want.
- **Keep everything streaming with a buffered fallback** (the prior shape) — rejected: it framed buffered as "an alternative to streaming," carried streaming as dead weight on endpoints whose only consumer wants one result, and coupled `ThinkSplitter` to the stream loop.

## Consequences

- `model_call.py` imports no JSONL/transport types and `streaming.py` imports no `ThinkSplitter`. `stream()` yields domain `(think, output)` tuples; chat wraps them into JSONL events.
- `ModelCall` is stateless per request (a per-request streamer object holds the splitter), so the once-composed, shared handler is concurrency-safe.
- `/markdown` becomes a single multi-page model call returning `{ markdown, pages }` (drops the per-page `pages: string[]`); the frontend loses live build-up streaming on extraction and schema suggestion, replaced by a working indicator plus the final `raw`.
