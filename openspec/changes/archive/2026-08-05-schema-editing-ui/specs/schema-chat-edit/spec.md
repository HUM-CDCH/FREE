## ADDED Requirements

### Requirement: Schema panel includes an inline chat area for describing changes
The SchemaPanel SHALL include a collapsible chat area below the field list. The chat area SHALL show a scrollable message history and a text input with a send button. The researcher SHALL be able to type a free-form request (e.g., "rename sagsnummer to case_id") and send it.

#### Scenario: Chat area is visible after schema is generated
- **WHEN** the schema panel is in the `ready` state
- **THEN** the chat area is visible at the bottom of the panel, below the field list

#### Scenario: Researcher types and sends a message
- **WHEN** the researcher types text in the chat input and presses Enter or clicks the send button
- **THEN** the message appears in the chat history as a user turn, the input clears, and a loading indicator appears

### Requirement: Only one schema change awaits review at a time
The system SHALL NOT accept a new schema-change request while a prior proposed change awaits a researcher decision. The review surface is intentionally unspecified here.

#### Scenario: A proposed change is awaiting a decision
- **WHEN** a schema-change proposal has not been applied or discarded
- **THEN** the system does not send another schema-change request
