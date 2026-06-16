## Why

The backend has document-oriented streaming endpoints, but no simple text chat surface for asking general questions through the configured model endpoint. A small `/chat` endpoint gives the prototype a direct way to stream model responses without involving document upload, extraction templates, or markdown conversion.

## What Changes

- Add a text-only `POST /chat` endpoint.
- Reuse the existing JSON Lines response behavior.
- Stream incremental `delta` events with `think` and `output` fields.
- Emit a final `done` event containing the completed message, optional reasoning, and raw output.
- Add focused tests for chat payload construction or event behavior where practical.

## Capabilities

### New Capabilities

- `chat-endpoint`: Clients can submit text to the configured model and receive a streamed chat response.

### Modified Capabilities

## Impact

- `E:\progetti\FREE\prototypes\mine\backend\main.py`: Add chat event generation and route wiring.
- `E:\progetti\FREE\prototypes\mine\backend\tests\...`: Add tests for the new chat behavior.
