## ADDED Requirements

### Requirement: Shared model configuration requires an authenticated researcher

Model Connections, Capability Routes, credential states, and probes SHALL remain deployment-wide shared state. Every authenticated Researcher Account that is not marked for mandatory password change SHALL be allowed to view, probe, and replace that shared configuration, while unauthenticated and mandatory-change callers SHALL be denied. FREE SHALL NOT add per-account Model Connections, routes, credentials, or overrides, and SHALL continue to withhold credential values from every response.

#### Scenario: Authenticated researcher opens configuration

- **WHEN** an authenticated Researcher Account that is not marked for mandatory password change requests the Model Connection page
- **THEN** FREE returns the shared configuration, provider descriptors, and redacted credential states

#### Scenario: Authenticated researcher applies shared configuration

- **WHEN** an authenticated Researcher Account that is not marked for mandatory password change applies a valid complete draft
- **THEN** FREE replaces the deployment-wide configuration for every researcher
- **AND** no response exposes a stored credential value

#### Scenario: Unauthenticated caller addresses model configuration

- **WHEN** an unauthenticated caller requests configuration, applies a draft, or probes a connection
- **THEN** FREE returns HTTP 401 without reading credentials or contacting a provider

#### Scenario: Mandatory-change account addresses model configuration

- **WHEN** an authenticated account marked for mandatory password change requests configuration, applies a draft, or probes a connection
- **THEN** FREE refuses the model operation and directs the browser to the password-change surface

## MODIFIED Requirements

### Requirement: Apply uses one editable draft

The Model Connection page SHALL own one editable React draft and submit it through one Apply request. Apply SHALL be disabled while that request is pending. Success SHALL replace the draft with the returned normalized `config` object in one assignment; failure SHALL retain the draft, display the error, and allow retry. FREE SHALL atomically replace the JSON document but SHALL NOT claim transactional coordination with the credential store, retain old secret values for rollback, or expose a credential-action journal. The single Studio process SHALL serialize overlapping whole-document PUT writes; a later committed complete document SHALL be authoritative without field-level merge or rollback.

#### Scenario: Apply succeeds

- **WHEN** the researcher applies valid configuration and credential changes
- **THEN** FREE returns the committed normalized `config` and credential-state map and the page replaces its draft with `config`
- **AND** no discovery probe is started automatically

#### Scenario: Apply fails

- **WHEN** credential-store or configuration persistence fails
- **THEN** the page retains the editable draft, displays the stable error, and enables Apply for retry
- **AND** FREE does not return old credential values or claim that the two stores changed atomically

#### Scenario: A removed connection leaves a credential

- **WHEN** configuration deletion commits but best-effort credential cleanup fails
- **THEN** the removed UUID remains absent from the authoritative JSON configuration
- **AND** the inert credential does not appear in configuration views or become available to another connection

#### Scenario: Two researchers apply overlapping drafts

- **WHEN** two authenticated researchers submit complete valid drafts concurrently
- **THEN** FREE commits each document atomically without interleaving their fields
- **AND** the document whose commit completes later becomes the complete authoritative configuration

### Requirement: Configuration and probe endpoints expose stable observable results

FREE SHALL expose authenticated `GET /api/model_config`, whole-document `PUT /api/model_config`, and `POST /api/model_probe` with the exact response and related wire types defined in the design. GET SHALL return the shared `config`, UUID-keyed credential states, and static provider descriptors. PUT SHALL accept that `config` unchanged plus optional write-only credential actions and return the normalized `config` plus UUID-keyed credential states without re-sending provider descriptors. GET and PUT SHALL not perform a provider network or CLI probe. POST SHALL accept one complete `ModelConnection` draft and an optional write-only credential action: omission reuses a matching saved credential, a non-empty string overrides it for this request only, and `null` probes without one. Configuration API failures SHALL use `{ "error": { "code": string, "message": string, "details"?: unknown } }` with 400 for invalid requests, 401 for missing or invalid authentication, 409 for invalid model configuration, 503 for required keyring failure, and 500 for unexpected failure. A completed probe, including a negative provider observation, returns HTTP 200 with `ProbeResult`. Immediate provider details MAY include a raw verbatim response body only within the design's size bound; the API MUST NOT add FREE-managed credentials, request headers, full request bodies, stack traces, or arbitrary thrown objects. A probe response and transient credential are ephemeral and MUST NOT mutate saved state or the keyring.

#### Scenario: Configuration starts unconfigured and is read locally

- **WHEN** an authenticated researcher calls `GET /api/model_config` on a fresh hosted Studio deployment
- **THEN** they receive the empty configuration and provider descriptors without provider or CLI traffic
- **AND** the response contains no credential value

#### Scenario: Apply does not probe

- **WHEN** the page successfully applies a changed local or remote Model Connection
- **THEN** PUT returns HTTP 200 with the normalized committed `config` and credential states without probing it or re-sending static provider descriptors
- **AND** the researcher may explicitly refresh that saved connection later

#### Scenario: An explicit probe reports a provider failure

- **WHEN** `POST /api/model_probe` completes after a provider is offline, unauthenticated, unreachable, malformed, or not installed
- **THEN** FREE returns HTTP 200 with a flattened `ProbeResult` whose status identifies the advisory failure
- **AND** it contains no credential or request body

#### Scenario: A new draft is probed

- **WHEN** `POST /api/model_probe` supplies a valid new connection and any required transient credential
- **THEN** FREE probes those draft values without first saving the connection
- **AND** it never stores or returns the transient credential

#### Scenario: Probes overlap

- **WHEN** two explicit probes overlap
- **THEN** each independently returns the result of the draft snapshot it probed
- **AND** neither result changes saved configuration
