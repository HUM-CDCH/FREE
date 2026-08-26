## ADDED Requirements

### Requirement: Schema chat uses the acknowledged Current Schema Revision
Before conversational schema editing, Studio SHALL flush a pending researcher edit and SHALL select the resulting acknowledged Current Schema Revision id as the conversational edit base. A failed or conflicted save SHALL block the conversational request.

#### Scenario: Researcher edit is queued before chat
- **WHEN** the researcher requests a conversational edit while a direct edit is dirty, saving, or queued
- **THEN** Studio waits until the latest draft is durably acknowledged
- **AND** submits that Schema Revision id as the conversational edit base

#### Scenario: Direct edit conflicts before chat
- **WHEN** the required direct-edit flush returns a revision conflict
- **THEN** Studio does not send the conversational edit request
- **AND** the pending chat instruction remains available after the researcher resolves the conflict
