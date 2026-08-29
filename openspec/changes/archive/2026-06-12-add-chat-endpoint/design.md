## Context

The backend already exposes streaming JSON Lines routes for extraction, Markdown conversion, and template generation. Those routes share model configuration, payload construction, streaming, reasoning separation, and JSON-vs-JSONL response negotiation.

## Goals / Non-Goals

**Goals:**

- Add a minimal text-only chat endpoint.
- Reuse existing model streaming and JSON Lines event helpers.
- Preserve the same `delta` event shape used by the existing streaming routes.
- Keep validation simple and explicit.

**Non-Goals:**

- No conversation history.
- No document or image upload support.
- No OpenAI-compatible `/v1/chat/completions` proxy endpoint.
- No new provider abstraction or dependency.

## Decisions

### Decision 1: Reuse the existing JSONL event contract

`POST /chat` will return the same `delta` event shape as other streaming endpoints: `think` for reasoning text and `output` for visible response text. The final `done` event will use chat-oriented field names: `message`, `reasoning`, and `raw`.

Alternative considered: returning a different chat-specific stream format. Rejected because the current client/backend contract already understands JSON Lines events.

### Decision 2: Implement chat as text-only form input

The endpoint will accept `text`, `reasoning`, and optional `temperature` form fields, matching the style of the existing FastAPI routes.

Alternative considered: accepting a JSON body. Rejected for this slice because the existing backend routes use direct `Form(...)` parameters and the onboarding task should stay aligned with the current route style.

## Risks / Trade-offs

- Streaming behavior can regress if duplicated. Mitigation: use `jsonl_delta_events()` and `call_model_stream()` instead of new streaming code.
- Swagger clients prefer JSON over JSONL. Mitigation: route responses through `jsonl_response()` so the existing buffered JSON fallback applies.
