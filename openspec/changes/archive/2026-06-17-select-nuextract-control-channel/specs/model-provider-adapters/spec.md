## ADDED Requirements

### Requirement: Provider adapters remain NuExtract task-channel agnostic
Provider adapters SHALL serialize prepared model requests without deciding NuExtract task-control placement.

#### Scenario: Adapter serializes prepared content unchanged
- **WHEN** a provider adapter receives prepared model content
- **THEN** it serializes that content into the provider request unchanged except for provider transport formatting
- **AND** it does not prepend NuExtract task prompts or append extraction controls

#### Scenario: Adapter serializes prepared template kwargs unchanged
- **WHEN** a provider adapter receives provider-neutral template kwargs
- **THEN** it maps those kwargs to the provider payload field used for template kwargs
- **AND** it does not add or remove NuExtract task controls such as mode, extraction schema, researcher instructions, markdown mode, or template-generation mode

#### Scenario: Adapter handles provider transport controls only
- **WHEN** a provider requires transport-specific fields such as endpoint normalization, authorization headers, streaming flags, token limits, or Ollama reasoning payloads
- **THEN** the adapter may add those provider-specific transport fields
- **AND** those fields do not decide whether message text or template kwargs are authoritative for NuExtract task controls
