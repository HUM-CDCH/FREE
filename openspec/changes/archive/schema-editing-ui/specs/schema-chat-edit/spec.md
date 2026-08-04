## ADDED Requirements

### Requirement: Schema panel includes an inline chat area for describing changes
The SchemaPanel SHALL include a collapsible chat area below the field list. The chat area SHALL show a scrollable message history and a text input with a send button. The researcher SHALL be able to type a free-form request (e.g., "rename sagsnummer to case_id") and send it.

#### Scenario: Chat area is visible after schema is generated
- **WHEN** the schema panel is in the `ready` state
- **THEN** the chat area is visible at the bottom of the panel, below the field list

#### Scenario: Researcher types and sends a message
- **WHEN** the researcher types text in the chat input and presses Enter or clicks the send button
- **THEN** the message appears in the chat history as a user turn, the input clears, and a loading indicator appears

### Requirement: Chat panel shows suggestion chips for common schema changes
The chat area SHALL show up to three suggestion chips when the researcher has not yet used all predefined suggestions. Each chip, when clicked, SHALL fire the associated change request immediately without requiring the researcher to type.

#### Scenario: Suggestion chips are shown when available
- **WHEN** the researcher has not yet used one or more suggestions
- **THEN** suggestion chips ("Add a field", "Remove a field", "Change a field type") are displayed above the text input

#### Scenario: Used suggestions are removed from chip list
- **WHEN** the researcher clicks a suggestion chip
- **THEN** that chip disappears from the list for the remainder of the session

### Requirement: Schema change request produces a reviewable diff card
After the researcher sends a schema change request (typed or via chip), the system SHALL call the model, receive a modified template, diff it against the current template, and display a diff card in the chat. The diff card SHALL list each changed field with a sign (`+` added, `−` removed, `~` renamed or retyped) and the field name and new type. The card SHALL include "Apply changes" and "Discard" buttons.

#### Scenario: Diff card appears after model responds
- **WHEN** the model returns a modified template in response to a schema change request
- **THEN** a diff card appears in the chat area showing the set of changes (added, removed, or modified fields) before any changes are applied to the schema

#### Scenario: Diff card lists correct change signs
- **WHEN** the model adds a field that was not in the original template
- **THEN** the diff card shows `+` next to that field name and type
- **WHEN** the model removes a field that was in the original template
- **THEN** the diff card shows `−` next to that field name
- **WHEN** the model renames or retypes a field
- **THEN** the diff card shows `~` next to the old path with an arrow to the new name/type

### Requirement: Researcher can apply or discard a proposed schema change
The diff card SHALL include two actions: "Apply changes" and "Discard". Applying SHALL update the schema to the model's proposed template. Discarding SHALL leave the schema unchanged.

#### Scenario: Researcher applies the proposed changes
- **WHEN** the researcher clicks "Apply changes" on the diff card
- **THEN** the schema panel field list updates to reflect the model's proposed template, the diff card is replaced by a confirmation message in the chat, and `onTemplateChange` is called with the new template

#### Scenario: Researcher discards the proposed changes
- **WHEN** the researcher clicks "Discard" on the diff card
- **THEN** the schema field list remains unchanged and the diff card is replaced by a "Discarded, no changes made" message in the chat

### Requirement: Only one pending change diff card is shown at a time
The system SHALL NOT allow the researcher to send a new chat message while a diff card is awaiting a decision.

#### Scenario: Input is disabled while a diff card is pending
- **WHEN** a diff card is visible and awaiting apply/discard
- **THEN** the text input and send button are disabled and suggestion chips are hidden
