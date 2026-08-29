# Spec: Schema Field Descriptions

## Purpose

Defines group-level Extraction Schema descriptions, their Fields and JSON editing surfaces, and their server-side compilation into model instructions.

## Requirements

### Requirement: Group nodes carry an optional description

`SchemaNode` SHALL include an optional `description?: string` property. Only nodes with `children` (group nodes — objects and arrays) may have a description. Leaf nodes (no `children`) SHALL NOT expose any description UI or storage.

#### Scenario: Description is absent by default

- **WHEN** a new schema node is created (via model suggestion or manual add)
- **THEN** `description` is `undefined` on leaf nodes and on group nodes that have not been annotated

#### Scenario: Description persists through schema edits

- **WHEN** a group node's children are modified (field added, removed, or renamed)
- **THEN** the group node's `description` is preserved unchanged

### Requirement: Fields view shows an ℹ icon on group nodes

In the fields view, each group node row SHALL display an ℹ icon to the right of the field name. Clicking the icon SHALL toggle an inline single-line `<input>` below the row where the researcher can read and edit the description. The icon SHALL be visually distinct (filled / colored) when a description is present, and dimmed when the description is empty or absent.

#### Scenario: Icon appears only on group nodes

- **WHEN** the fields view renders a node with `children`
- **THEN** an ℹ icon is shown on that row
- **AND** leaf nodes (no `children`) do NOT show an ℹ icon

#### Scenario: Clicking the icon reveals an inline input

- **WHEN** the researcher clicks the ℹ icon on a group node
- **THEN** a single-line input field appears below the row, pre-filled with the current description (or empty)
- **AND** the input receives focus automatically

#### Scenario: Blurring the input saves the description

- **WHEN** the researcher blurs the inline description input
- **THEN** the trimmed input value is saved to `SchemaNode.description`
- **AND** if the value is empty after trimming, `description` is set to `undefined`

#### Scenario: Icon color reflects description presence

- **WHEN** `SchemaNode.description` is a non-empty string
- **THEN** the ℹ icon is rendered in the accent color
- **AND** when `description` is absent or empty, the icon is rendered in the muted ink color

### Requirement: JSON view encodes descriptions as `_description` keys

The JSON tab SHALL render a display template that includes a `"_description"` key at the start of each group object whose node has a non-empty description. This gives researchers a single JSON surface to inspect and bulk-edit both structure and descriptions. `_description` is a reserved convention — it is not a field name the researcher can assign to a real field.

#### Scenario: Group with description shows `_description` in JSON

- **WHEN** the JSON tab renders and a group node has a non-empty description
- **THEN** the rendered JSON object for that group starts with `"_description": "<description>"`

#### Scenario: Group without description omits `_description`

- **WHEN** a group node has no description
- **THEN** its JSON object does not contain a `_description` key

#### Scenario: `templateToNodes` reads `_description` into node description

- **WHEN** a JSON object with a `"_description"` string key is parsed by `templateToNodes`
- **THEN** the resulting `SchemaNode` has `description` set to that string
- **AND** `_description` is NOT included as a child field of the node

### Requirement: JSON tab is editable

The JSON tab SHALL provide an Edit button that switches the read-only `<pre>` display to an editable `<textarea>`. The researcher may freely edit the JSON, including `_description` keys. Saving SHALL parse the JSON, call `templateToNodes` (which reads `_description` back into node descriptions), update the node state, and call `onTemplateChange`. A parse error SHALL be shown inline; the textarea remains open until the error is resolved or the researcher cancels.

#### Scenario: Edit button activates editing mode

- **WHEN** the researcher clicks the Edit button in the JSON tab
- **THEN** the `<pre>` display is replaced by a `<textarea>` containing the current display template JSON
- **AND** Save and Cancel buttons appear

#### Scenario: Valid JSON is saved and parsed back to nodes

- **WHEN** the researcher edits the JSON and clicks Save
- **AND** the JSON is valid and parses to an object
- **THEN** `templateToNodes` converts the JSON (reading `_description` keys) to a new node tree
- **AND** node state and `onTemplateChange` are updated
- **AND** editing mode closes

#### Scenario: Invalid JSON shows an error

- **WHEN** the researcher clicks Save with syntactically invalid JSON
- **THEN** an inline error message is shown below the textarea
- **AND** the textarea remains open

#### Scenario: Cancel discards edits

- **WHEN** the researcher clicks Cancel in editing mode
- **THEN** the textarea closes with no changes to node state

### Requirement: Descriptions are compiled into extraction instructions

When extraction runs, the server-side Extraction operation SHALL compile all non-empty group descriptions from the pinned Schema Revision into a structured text block supplied to the model. If no group has a description, the instructions string SHALL be empty. The extraction template JSON sent to the model SHALL NOT contain any `_description` keys.

#### Scenario: Descriptions compiled into instructions block

- **WHEN** extraction runs and one or more group nodes have non-empty descriptions
- **THEN** the model instructions contain one line per described group in the format `- <field.path>: <description>`
- **AND** the extraction template JSON contains no `_description` keys

#### Scenario: No descriptions — instructions empty

- **WHEN** extraction runs and no group node has a description
- **THEN** the compiled instructions string is empty
- **AND** extraction proceeds without description guidance

#### Scenario: Nested group descriptions use dot-separated paths

- **WHEN** a nested group node (e.g. `parent.child`) has a description
- **THEN** the compiled instructions line uses the full dot-separated path as the label
