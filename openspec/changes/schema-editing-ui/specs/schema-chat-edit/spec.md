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

### Requirement: Schema change request produces a reviewable inline diff
After the researcher sends an Extraction Schema change request (typed or via chip), FREE SHALL call `/api/edit_schema`, validate the returned operations, apply them to a copy, and display added, removed, and modified status inline in the schema tree. A sticky action bar SHALL include "Apply changes" and "Discard" buttons.

#### Scenario: Inline diff appears after model responds
- **WHEN** the model returns operations that modify the Extraction Schema
- **THEN** the schema tree shows the set of changes before any changes are applied to canonical nodes

#### Scenario: Inline diff uses correct statuses
- **WHEN** the model adds a field that was not in the original Extraction Schema
- **THEN** the field is shown as added in green
- **WHEN** the model removes a field that was in the original Extraction Schema
- **THEN** the field remains as a removed red ghost
- **WHEN** the model renames or retypes a field
- **THEN** the updated field is shown as modified in amber

### Requirement: Researcher can apply or discard a proposed schema change
The sticky action bar SHALL include two actions: "Apply changes" and "Discard". Applying SHALL update canonical nodes. Discarding SHALL leave them unchanged.

#### Scenario: Researcher applies the proposed changes
- **WHEN** the researcher clicks "Apply changes" in the action bar
- **THEN** the schema panel commits the proposed nodes, clears the inline diff, appends a confirmation message, and calls `onNodesChange`

#### Scenario: Researcher discards the proposed changes
- **WHEN** the researcher clicks "Discard" in the action bar
- **THEN** the schema field list remains unchanged, the inline diff clears, and chat reports "Discarded, no changes made"

### Requirement: Only one pending change is shown at a time
FREE SHALL NOT allow a new chat request while an inline diff awaits a decision.

#### Scenario: Input is disabled while an inline diff is pending
- **WHEN** an inline diff is visible and awaiting apply/discard
- **THEN** the text input and send button are disabled and suggestion chips are hidden
