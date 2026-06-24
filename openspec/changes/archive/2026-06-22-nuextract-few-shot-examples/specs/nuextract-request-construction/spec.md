# nuextract-request-construction Delta Specification

## MODIFIED Requirements

### Requirement: NuExtract request builder prepares outbound model requests

The backend SHALL construct NuExtract-specific outbound model requests through a dedicated request builder before those requests reach `ModelGateway`.

#### Scenario: Structured extraction request is fully prepared for message-text control

- **WHEN** structured extraction source content, an extraction schema, researcher instructions, reasoning, and temperature are provided to the NuExtract request builder with message text as the authoritative control channel
- **THEN** it returns a `ModelRequest` whose content begins with the structured NuExtract task prompt
- **AND** the content includes readable researcher-instruction and extraction-schema controls
- **AND** the request does not duplicate extraction schema or researcher instructions in provider template kwargs
- **AND** the request carries the requested reasoning flag and temperature

#### Scenario: Structured extraction request is fully prepared for template-kwargs control

- **WHEN** structured extraction source content, an extraction schema, researcher instructions, reasoning, and temperature are provided to the NuExtract request builder with template kwargs as the authoritative control channel
- **THEN** it returns a `ModelRequest` whose content contains source context without duplicate readable extraction-schema or researcher-instruction controls
- **AND** the request contains provider-neutral template kwargs for mode, extraction schema, researcher instructions, and thinking
- **AND** the request carries the requested reasoning flag and temperature

#### Scenario: Structured extraction embeds a few-shot example when provided

- **WHEN** a `FewShotExample` is passed to `structured_extraction`
- **THEN** the request content includes a text block showing the example schema and the correctly filled result
- **AND** the example block appears before the source document content so the model sees the pattern before the document
- **AND** the example is included regardless of the authoritative control channel

#### Scenario: Structured extraction omits few-shot block when no example is provided

- **WHEN** `structured_extraction` is called without a `few_shot` argument (or with `None`)
- **THEN** the request content does not include any few-shot example block
- **AND** the request is otherwise identical to a request built without the parameter
