## MODIFIED Requirements

### Requirement: Pending-diff card shows changes before commit

After ops are applied the system SHALL display the diff inline in the schema tree (see `schema-inline-diff` spec) and present Apply and Discard actions in a sticky action bar at the bottom of the chat column. The system SHALL NOT show a separate diff card listing text lines inside the chat scroll area.

#### Scenario: Researcher reviews and applies changes

- **WHEN** the op list produces one or more changes
- **THEN** the schema tree shows the diff inline with colour-annotated nodes
- **AND** a sticky action bar appears at the bottom of the chat column with "Apply changes" and "Discard" buttons
- **AND** clicking Apply commits the new schema, removes the diff overlay, and hides the action bar
- **AND** clicking Discard reverts the tree to its pre-edit state and hides the action bar
