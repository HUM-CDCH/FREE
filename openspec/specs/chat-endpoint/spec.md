# chat-endpoint Specification

## Purpose
TBD - created by archiving change add-chat-endpoint. Update Purpose after archive.
## Requirements
### Requirement: Stream Text Chat Responses

The system SHALL provide a text-only `POST /chat` endpoint that sends a user message to the configured model endpoint and returns the response using the existing JSON Lines event contract.

#### Scenario: Streaming chat response

- **WHEN** a client submits non-empty chat text to `POST /chat`
- **THEN** the system streams `delta` events containing incremental `think` and `output` fields
- **AND** the system emits a final `done` event containing the completed `message`, optional `reasoning`, and `raw` output

#### Scenario: Buffered JSON for JSON clients

- **WHEN** a client submits chat text with an `Accept` header that includes `application/json` and does not include `application/jsonl`
- **THEN** the system returns a buffered JSON array of the same chat events

#### Scenario: Missing chat text

- **WHEN** a client submits empty or missing chat text to `POST /chat`
- **THEN** the system rejects the request with HTTP 400 and a clear validation message

