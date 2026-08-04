# model-connection-configuration Specification

## Purpose
TBD - created by archiving change runtime-model-configuration. Update Purpose after archive.
## Requirements
### Requirement: Model configuration has one durable machine-wide source

FREE SHALL persist non-secret Model Connections and the Capability Route map in `model-config.json` in the operating system user configuration directory for `FREE Studio`. An absent file SHALL represent an empty valid configuration: no Model Connections and null Extraction and Interaction Routes. Saved runtime configuration SHALL be the sole source of model configuration; FREE MUST NOT import, overlay, or fall back to `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, or `AI_API_KEY`.

#### Scenario: FREE starts without configuration

- **WHEN** `model-config.json` does not exist
- **THEN** `GET /api/model_config` returns an empty valid configuration with both routes null
- **AND** no Model Connection or route is derived from `AI_*` process settings

#### Scenario: AI settings are present after configuration exists

- **WHEN** a saved configuration and one or more `AI_*` process settings are present
- **THEN** `GET /api/model_config` and subsequent saves expose only the saved configuration
- **AND** the `AI_*` settings do not alter a Model Connection, credential state, or route

#### Scenario: Saved configuration is corrupt or invalid

- **WHEN** the saved document is malformed, has duplicate connection IDs, has an invalid connection, or has a dangling route
- **THEN** the configuration endpoint returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** its error details identify the configuration path and bounded validation information
- **AND** FREE leaves the saved document unchanged and does not reset or replace it automatically

### Requirement: Configuration writes accept only researcher-editable state

`PUT /api/model_config` SHALL accept a complete editable configuration and optional explicit credential actions. The editable configuration SHALL have exactly the same wire schema as the `config` object returned by GET and PUT, so it can be submitted without field stripping or reconstruction. A Model Connection SHALL have a stable UUID, name, provider kind, and provider base URL where applicable. Credential states and provider descriptors are server-owned sibling data and MUST NOT be accepted inside the editable configuration. A non-null submitted route SHALL reference a submitted Model Connection and MAY use any non-empty model ID without prior discovery.

#### Scenario: Existing identity changes provider kind

- **WHEN** a submitted existing connection keeps its UUID but changes provider kind
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** the researcher must delete that Model Connection and create a new UUID for the other kind

#### Scenario: A route dangles after an edit

- **WHEN** a PUT removes a Model Connection while a non-null route still references it
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** it does not silently clear, reassign, or preserve the dangling route

### Requirement: Credential values are exclusive to the OS credential store

FREE SHALL store FREE-managed credentials only in the operating system credential store under `FREE Studio` and `model-connection/<connection UUID>`. Credential values MUST NOT appear in the JSON document, configuration views, probe results, logs, or error responses. In a PUT credential-action map, an omitted ID SHALL preserve the credential, a non-empty string SHALL replace it, and `null` SHALL delete it; action keys SHALL name submitted connections and an empty string SHALL be invalid. Connection removal alone owns orphan cleanup after the JSON commit.

#### Scenario: A configuration response redacts secrets

- **WHEN** a connection has a stored managed credential
- **THEN** GET and PUT responses report only its credential state in a UUID-keyed sibling map containing only managed or optional returned connections
- **AND** neither response nor its persisted configuration contains the credential value or a reversible masked value

#### Scenario: Researcher preserves, replaces, and deletes a credential

- **WHEN** sequential saves omit a connection from credential actions, send it a non-empty credential, and send it `null`
- **THEN** the keyring entry is respectively preserved, replaced, and deleted
- **AND** no prior credential value is returned to the client at any step

#### Scenario: A connection with a credential is deleted

- **WHEN** a PUT deletes a Model Connection with a FREE-managed credential
- **THEN** FREE commits the connection deletion and attempts to delete its credential
- **AND** a credential-deletion failure may leave only an inert UUID-keyed entry that no saved connection can use

#### Scenario: Required keyring access fails

- **WHEN** a PUT needs to query, create, replace, or delete a FREE-managed credential and the keyring is unavailable
- **THEN** FREE returns HTTP 503 with `error.code` `keyring_unavailable`
- **AND** it does not persist a plaintext, memory-only, environment, or file-based credential fallback

#### Scenario: Keyring status cannot be read

- **WHEN** the keyring is unavailable during `GET /api/model_config`
- **THEN** GET succeeds and affected managed or optional connections report credential state `unavailable`
- **AND** credentialless and externally authenticated connections remain visible and usable

### Requirement: Apply uses one editable draft

The Model Connection page SHALL own one editable React draft and submit it through one Apply request. Apply SHALL be disabled while that request is pending. Success SHALL replace the draft with the returned normalized `config` object in one assignment; failure SHALL retain the draft, display the error, and allow retry. FREE SHALL atomically replace the JSON document but SHALL NOT claim transactional coordination with the credential store, retain old secret values for rollback, or expose a credential-action journal. Overlapping PUT requests and multiple Studio processes are unsupported.

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

### Requirement: Seven provider kinds have explicit connection contracts

FREE SHALL support exactly these Model Connection kinds: Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and OpenAI-compatible. HTTP providers SHALL use an absolute `http:` or `https:` provider base URL without username, password, query, or fragment; adapter-required version prefixes such as `/v1` are valid and trailing slashes are insignificant. Ollama SHALL store the server base expected by its adapter rather than an API base ending in `/api`. CLI providers SHALL have a null base URL and external installation/authentication state. A configured native-provider base SHALL retain that provider's native protocol, while an OpenAI-compatible base SHALL guarantee `/models` and `/chat/completions` beneath the stored base.

#### Scenario: Each provider kind is represented

- **WHEN** the configuration is requested with GET
- **THEN** it contains serializable descriptors for Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and OpenAI-compatible in stable provider order
- **AND** each descriptor exposes its applicable credential mode and UI-required `supportsNuextractRaw` flag without exposing backend execution capabilities or a credential value

#### Scenario: A duplicate CLI connection is submitted

- **WHEN** a submitted configuration contains more than one Codex CLI Model Connection or more than one Claude Code Model Connection
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** HTTP provider kinds remain available for multiple independently named Model Connections

#### Scenario: Provider bases preserve supplied versions and prefixes

- **WHEN** an HTTP connection is saved with a valid provider base, including
  a base ending in `/v1` or `/v1beta`
- **THEN** each adapter appends only resource-local paths below that exact base
- **AND** a path prefix in the stored base is retained without suffix rejection

#### Scenario: An API base contains embedded credentials

- **WHEN** an HTTP connection API base contains a username or password component
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** it does not persist or send the embedded value as connection configuration

#### Scenario: A native API base is customized

- **WHEN** an Ollama, OpenAI, Anthropic, or Google connection uses a custom valid API base
- **THEN** FREE uses the selected native provider contract at that base
- **AND** it does not reinterpret the connection as OpenAI-compatible

#### Scenario: An Ollama server base reaches each native resource once

- **WHEN** an Ollama connection stores `http://127.0.0.1:11434` or a custom path-prefixed server base
- **THEN** discovery uses `{base}/api/tags`, general generation uses `{base}/api/chat`, and raw NuExtract uses `{base}/api/generate`
- **AND** FREE neither appends `/api` twice nor strips or rewrites the stored base

#### Scenario: Native OpenAI and OpenAI-compatible use distinct generation protocols

- **WHEN** otherwise equivalent routes select an OpenAI connection and an OpenAI-compatible connection
- **THEN** the native OpenAI adapter constructs a Responses model and generates through `{base}/responses`
- **AND** the OpenAI-compatible adapter constructs a Chat Completions model and generates through `{base}/chat/completions`
- **AND** neither adapter falls back to or substitutes the other protocol

### Requirement: Discovery is advisory, ephemeral, and seamless

FREE SHALL probe a structurally valid draft Model Connection after its provider, API base, or credential input has remained unchanged for 500 ms, and SHALL also offer an immediate Refresh models retry. It SHALL never generate model content or modify saved configuration or credentials as part of a probe. A probe SHALL return a bounded flattened result and catalog for the current page session. Probe status SHALL be exactly one of `connected`, `authentication_failed`, `unreachable`, `not_installed`, `invalid_response`, `discovery_failed`, or `timed_out`. Each probe SHALL have a 15-second wall-clock deadline, read at most 1 MiB of discovery response, accept at most 10,000 unique models, and bound model IDs, labels, and messages as defined by the design wire contract. Route model IDs SHALL remain manually editable and SHALL NOT require prior discovery or membership in a probe result.

#### Scenario: A researcher enters a valid connection

- **WHEN** valid provider, API-base, and credential input settles for 500 ms
- **THEN** FREE reports whether the connection is currently usable and returns its current catalog
- **AND** the page may offer that catalog as selection help for the current session
- **AND** neither success nor failure changes `model-config.json`

#### Scenario: Probe input changes

- **WHEN** provider, API-base, or credential input changes while a probe is pending
- **THEN** the page aborts that request where possible and ignores its response
- **AND** only the latest probe for that connection may update its inline status or catalog

#### Scenario: The panel opens with saved connections

- **WHEN** the researcher opens the configuration panel without editing probe inputs
- **THEN** FREE does not probe every saved connection automatically
- **AND** each connection offers Refresh models for an immediate current check

#### Scenario: Discovery fails

- **WHEN** an explicit probe finds a provider offline, unauthenticated, unreachable, malformed, or not installed
- **THEN** FREE returns a bounded advisory failure for the current page session
- **AND** it neither changes saved configuration or credentials nor performs paid or test generation
- **AND** Apply remains available

#### Scenario: A model ID is entered manually

- **WHEN** a researcher enters a non-empty model ID that has not appeared in a probe result
- **THEN** FREE accepts and persists the route
- **AND** execution later attempts that exact ID without substitution

#### Scenario: Claude Code has no dynamic model listing

- **WHEN** a Claude Code probe confirms its external harness is installed and authenticated
- **THEN** its probe result suggests exactly `fable`, `opus`, `sonnet`, and `haiku`
- **AND** the suggestions do not prevent manual entry of another non-empty model ID

### Requirement: Configuration and probe endpoints expose stable observable results

FREE SHALL expose `GET /api/model_config`, whole-document `PUT /api/model_config`, and `POST /api/model_probe` with the exact response and related wire types defined in the design. GET SHALL return the shared `config`, UUID-keyed credential states, and static provider descriptors. PUT SHALL accept that `config` unchanged plus optional write-only credential actions and return the normalized `config` plus UUID-keyed credential states without re-sending provider descriptors. GET and PUT SHALL not perform a provider network or CLI probe. POST SHALL accept one complete `ModelConnection` draft and an optional write-only credential action: omission reuses a matching saved credential, a non-empty string overrides it for this request only, and `null` probes without one. Configuration API failures SHALL use `{ "error": { "code": string, "message": string, "details"?: unknown } }` with 400 for invalid requests, 409 for invalid model configuration, 503 for required keyring failure, and 500 for unexpected failure. A completed probe, including a negative provider observation, returns HTTP 200 with `ProbeResult`. Immediate provider details MAY include a raw verbatim response body only within the design's size bound; the API MUST NOT add FREE-managed credentials, request headers, full request bodies, stack traces, or arbitrary thrown objects. A probe response and transient credential are ephemeral and MUST NOT mutate saved state or the keyring.

#### Scenario: Configuration starts unconfigured and is read locally

- **WHEN** a client calls `GET /api/model_config` on a fresh local Studio prototype
- **THEN** it receives the empty configuration and provider descriptors without provider or CLI traffic
- **AND** the API remains supported only through the local Vite/Studio source prototype, not a hosted deployment

#### Scenario: Apply does not probe

- **WHEN** the page successfully applies a changed local or remote Model Connection
- **THEN** PUT returns HTTP 200 with the normalized committed `config` and credential states without probing it or re-sending static provider descriptors
- **AND** the researcher may explicitly refresh that saved connection later

#### Scenario: An explicit probe reports a provider failure

- **WHEN** `POST /api/model_probe` completes after a provider is offline,
  unauthenticated, unreachable, malformed, or not installed
- **THEN** FREE returns HTTP 200 with a flattened `ProbeResult` whose status
  identifies the advisory failure
- **AND** it contains no credential or request body

#### Scenario: A new draft is probed

- **WHEN** `POST /api/model_probe` supplies a valid new connection and any required transient credential
- **THEN** FREE probes those draft values without first saving the connection
- **AND** it never stores or returns the transient credential

#### Scenario: Probes overlap

- **WHEN** two explicit probes overlap
- **THEN** each independently returns the result of the draft snapshot it probed
- **AND** neither result changes saved configuration

### Requirement: The Model Connection page offers equivalent Single model and Capability Routes modes

The Model Connection page SHALL load backend-owned configuration into one draft using the shared configuration shape and retain visible Single model and Capability Routes modes. Single model mode SHALL save one explicit model ID as both routes. Capability Routes mode SHALL save independently entered model IDs for Extraction and Interaction. Both modes SHALL use the same Apply action and write-only credential changes; seamless draft checks and Refresh models SHALL report current connection usability and MAY assist selection without gating it.

#### Scenario: Single model mode configures a local-only setup

- **WHEN** a researcher enters one local Ollama model ID in Single model mode and saves
- **THEN** the saved Extraction and Interaction Routes reference that same local connection and model without the raw NuExtract flag
- **AND** no separate inline provider or credential configuration is created

#### Scenario: Capability Routes mode configures mixed routing

- **WHEN** a researcher assigns a local Ollama model to Extraction and a remote OpenAI model to Interaction in Capability Routes mode and saves
- **THEN** both saved routes retain their independently selected connections and models
- **AND** the page displays the returned persisted route state rather than fabricated connection status

#### Scenario: A manual model ID is displayed

- **WHEN** GET returns a route whose model ID was entered manually
- **THEN** the page displays that exact saved model ID
- **AND** a later probe result does not substitute, clear, or hide it

