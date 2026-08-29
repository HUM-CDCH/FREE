## ADDED Requirements

### Requirement: Raw NuExtract uses settled context and output options

Raw NuExtract requests sent to Ollama SHALL set `num_ctx` to 32768 and `num_predict` to 8192. Other provider transports SHALL retain their native option behavior.

#### Scenario: Ollama runs Article values extraction

- **WHEN** Article values extraction uses an Ollama NuExtract route
- **THEN** the outbound `/api/generate` request includes `options.num_ctx` equal to 32768
- **AND** `options.num_predict` equal to 8192

### Requirement: Provider completion metadata reaches the Article lifecycle

The model execution boundary SHALL expose provider finish reason, usage counts when available, and request duration to the server-owned Article lifecycle without exposing raw provider output outside the tolerant parser.

#### Scenario: Ollama stops at the output limit

- **WHEN** Ollama returns `done_reason: "length"`
- **THEN** the Article lifecycle receives finish reason `length`
- **AND** it can persist the attempt as incomplete while retaining any usable parsed result
