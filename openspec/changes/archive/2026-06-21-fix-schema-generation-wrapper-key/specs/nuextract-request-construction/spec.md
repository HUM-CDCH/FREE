## MODIFIED Requirements

### Requirement: NuExtract request builder prepares outbound model requests

The backend SHALL construct NuExtract-specific outbound model requests through a dedicated request builder before those requests reach `ModelGateway`.

#### Scenario: Schema suggestion request is fully prepared
- **WHEN** schema-suggestion source content and natural-language schema-suggestion guidance are provided to the NuExtract request builder
- **THEN** the guidance is treated as task input message text
- **AND** template-kwargs-authoritative providers receive provider-neutral template kwargs for template-generation mode with thinking disabled
- **AND** message-text-authoritative providers receive message content sufficient to request a schema suggestion without relying on template-generation kwargs

#### Scenario: Schema suggestion instructs the model against wrapper keys
- **WHEN** the NuExtract request builder prepares a schema-suggestion request
- **THEN** the task instructions sent to the model include a constraint that top-level keys must be semantic field names
- **AND** the instructions prohibit using record identifiers, document titles, or subject names as top-level wrapper keys
