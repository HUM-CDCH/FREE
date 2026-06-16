## 1. Chat Endpoint

- [x] 1.1 Add chat event generation that streams model deltas and emits a final `done` event.
- [x] 1.2 Add `POST /chat` with direct `Form(...)` parameters for `text`, `reasoning`, and `temperature`.
- [x] 1.3 Reject empty or missing chat text with HTTP 400.

## 2. Tests

- [x] 2.1 Add a focused test for chat event completion.
- [x] 2.2 Add a focused test for buffered JSON responses when `Accept: application/json`.
- [x] 2.3 Add a focused test for empty chat text validation.
- [x] 2.4 Run the backend test suite.



