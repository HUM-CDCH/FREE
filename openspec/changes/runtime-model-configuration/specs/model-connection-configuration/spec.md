## ADDED Requirements

### Requirement: Model configuration has one durable machine-wide source

FREE SHALL persist non-secret Model Connections and the v1 Capability Route map in `model-config.json` in the operating system user configuration directory for `FREE Studio`. An absent file SHALL represent an empty valid v1 configuration: no Model Connections and null Extraction and Interaction Routes. Saved runtime configuration SHALL be the sole source of model configuration; FREE MUST NOT import, overlay, or fall back to `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, or `AI_API_KEY`.

#### Scenario: FREE starts without configuration

- **WHEN** `model-config.json` does not exist
- **THEN** `GET /api/model_config` returns an empty valid v1 configuration with both routes null
- **AND** no Model Connection or route is derived from `AI_*` process settings

#### Scenario: AI settings are present after configuration exists

- **WHEN** a saved configuration and one or more `AI_*` process settings are present
- **THEN** `GET /api/model_config` and subsequent saves expose only the saved configuration
- **AND** the `AI_*` settings do not alter a Model Connection, credential state, catalog, or route

#### Scenario: Saved configuration is corrupt or unsupported

- **WHEN** the saved document is malformed, has an unsupported version, has duplicate connection IDs, has an invalid connection, or has a dangling route
- **THEN** the configuration endpoint returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** its error details identify the configuration path and bounded validation information
- **AND** FREE leaves the saved document unchanged and does not reset, migrate, or replace it automatically

### Requirement: Configuration writes accept only researcher-editable state

`PUT /api/model_config` SHALL accept a complete editable v1 configuration and optional explicit credential actions. A Model Connection SHALL have a stable UUID, name, provider kind, and service root where applicable. Catalogs, their non-secret source fingerprints, probe observations, their source fingerprints, credential state, provider descriptors, and route readiness are server-owned and MUST NOT be accepted from the client. A non-null submitted route SHALL reference a submitted Model Connection.

#### Scenario: Server-owned data is submitted

- **WHEN** a PUT includes a catalog, probe observation, credential state, provider descriptor, or route readiness value as editable state
- **THEN** FREE returns HTTP 400 with `error.code` `invalid_request`
- **AND** it does not commit the submitted configuration

#### Scenario: Existing identity changes provider kind

- **WHEN** a submitted existing connection keeps its UUID but changes provider kind
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** the researcher must delete that Model Connection and create a new UUID for the other kind

#### Scenario: A route dangles after an edit

- **WHEN** a PUT removes a Model Connection while a non-null route still references it
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** it does not silently clear, reassign, or preserve the dangling route

### Requirement: Credential values are exclusive to the OS credential store

FREE SHALL store FREE-managed credentials only in the operating system credential store under `FREE Studio` and `model-connection/<connection UUID>`. Credential values MUST NOT appear in the JSON document, configuration views, probe observations, logs, or error responses. In a PUT credential-action map, an omitted ID SHALL preserve the credential, a non-empty string SHALL replace it, and `null` SHALL delete it; an empty string SHALL be invalid.

#### Scenario: A configuration response redacts secrets

- **WHEN** a connection has a stored managed credential
- **THEN** GET and PUT responses report only its credential state
- **AND** neither response nor its persisted configuration contains the credential value or a reversible masked value

#### Scenario: Researcher preserves, replaces, and deletes a credential

- **WHEN** sequential saves omit a connection from credential actions, send it a non-empty credential, and send it `null`
- **THEN** the keyring entry is respectively preserved, replaced, and deleted
- **AND** no prior credential value is returned to the client at any step

#### Scenario: A connection with a credential is deleted

- **WHEN** a PUT deletes a Model Connection with a FREE-managed credential
- **THEN** FREE deletes the credential before committing the connection deletion
- **AND** a credential-deletion failure prevents the JSON configuration from being committed

#### Scenario: Required keyring access fails

- **WHEN** a PUT needs to query, create, replace, or delete a FREE-managed credential and the keyring is unavailable
- **THEN** FREE returns HTTP 503 with `error.code` `keyring_unavailable`
- **AND** it does not persist a plaintext, memory-only, environment, or file-based credential fallback

#### Scenario: Keyring status cannot be read

- **WHEN** the keyring is unavailable during `GET /api/model_config`
- **THEN** GET succeeds and affected managed or optional connections report credential state `unavailable`
- **AND** credentialless and externally authenticated connections remain visible and usable

### Requirement: Saves have determinate last-write-wins outcomes

FREE SHALL serialize overlapping complete PUT workflows in one Studio process and apply them in arrival order so the last queued save owns the resulting editable configuration and credential actions. FREE SHALL make cross-store partial outcomes observable rather than claiming a transaction or compensating with retained secret values.

#### Scenario: Two saves overlap

- **WHEN** two valid PUT requests with conflicting connection or credential edits arrive before the first completes
- **THEN** FREE completes the first workflow before beginning the second
- **AND** the final configuration and credential state reflect the second request

#### Scenario: Credential mutation fails before configuration commit

- **WHEN** a credential action fails after one or more prior credential actions completed
- **THEN** FREE returns a stable error containing the completed connection IDs and `configCommitted: false`
- **AND** the prior JSON configuration remains active

#### Scenario: JSON commit fails after credential mutations

- **WHEN** requested credential actions complete but the first atomic JSON replacement fails
- **THEN** FREE returns a stable error containing the completed connection IDs and `configCommitted: false`
- **AND** the prior JSON configuration remains active while the completed credential mutations remain without compensating rollback

#### Scenario: Persisting probe observations fails after a save

- **WHEN** FREE has committed editable configuration but cannot persist the post-save probe observations
- **THEN** FREE returns a stable error containing `configCommitted: true`
- **AND** the committed editable configuration remains active and can be safely retried or manually probed

### Requirement: Seven provider kinds have explicit connection contracts

FREE SHALL support exactly these Model Connection kinds: Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and OpenAI-compatible. HTTP providers SHALL use an absolute `http:` or `https:` unversioned service root without username, password, query, or fragment; trailing slashes are insignificant. CLI providers SHALL have a null service root and external installation/authentication state. A configured native-provider root SHALL retain that provider's native protocol, while an OpenAI-compatible root SHALL guarantee `/v1/models` and `/v1/chat/completions` beneath the stored root.

#### Scenario: Each provider kind is represented

- **WHEN** the configuration view is requested
- **THEN** it contains serializable descriptors for Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and OpenAI-compatible in stable provider order
- **AND** each descriptor exposes its applicable credential mode without exposing a credential value

#### Scenario: A duplicate CLI connection is submitted

- **WHEN** a submitted configuration contains more than one Codex CLI Model Connection or more than one Claude Code Model Connection
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** HTTP provider kinds remain available for multiple independently named Model Connections

#### Scenario: HTTP service roots are used without duplicate version suffixes

- **WHEN** an HTTP connection is saved with a valid unversioned root
- **THEN** Ollama resources are addressed below `/api`, OpenAI, Anthropic, and OpenAI-compatible resources below `/v1`, and Google resources below `/v1beta`
- **AND** a path prefix in the stored root is retained

#### Scenario: A versioned root is submitted

- **WHEN** a provider root already ends in that provider's appended API suffix
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** it does not request or construct a duplicated suffix such as `/v1/v1`

#### Scenario: A root contains embedded credentials

- **WHEN** an HTTP connection root contains a username or password component
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** it does not persist or send the embedded value as connection configuration

#### Scenario: A native root is customized

- **WHEN** an Ollama, OpenAI, Anthropic, or Google connection uses a custom valid service root
- **THEN** FREE uses the selected native provider contract at that root
- **AND** it does not reinterpret the connection as OpenAI-compatible

#### Scenario: Native OpenAI and OpenAI-compatible use distinct generation protocols

- **WHEN** otherwise equivalent routes select an OpenAI connection and an OpenAI-compatible connection
- **THEN** the native OpenAI adapter constructs a Responses model and generates through `{root}/v1/responses`
- **AND** the OpenAI-compatible adapter constructs a Chat Completions model and generates through `{root}/v1/chat/completions`
- **AND** neither adapter falls back to or substitutes the other protocol

### Requirement: Discovery is advisory, persisted, and selection-gating

FREE SHALL probe only saved Model Connections and SHALL never generate model content as part of a probe. Successful discovery SHALL persist the latest catalog and connected observation with the non-secret provider, normalized-root, and credential-revision fingerprint that produced them. A failed, non-stale probe SHALL persist its bounded failure observation while retaining the last successful catalog for offline display. A retained catalog SHALL gate a new route selection only when its fingerprint matches the current connection; readiness SHALL use an observation fingerprint matching the current connection. Probe status SHALL be exactly one of `connected`, `authentication_failed`, `unreachable`, `not_installed`, `invalid_response`, `discovery_failed`, or `timed_out`. Each probe SHALL have a 15-second wall-clock deadline, read at most 1 MiB of discovery response, accept at most 10,000 unique models, and bound model IDs, labels, and persisted messages as defined by the design wire contract. New route selections SHALL be limited to the latest matching catalog, except that a successfully authenticated Claude Code connection SHALL expose only the static aliases `fable`, `opus`, `sonnet`, and `haiku` as its catalog.

#### Scenario: Discovery failure preserves the offline catalog

- **WHEN** a connection with a previously discovered catalog is probed while its provider is offline, unauthenticated, unreachable, malformed, or not installed
- **THEN** FREE persists the failed observation and retains the previous catalog for offline display
- **AND** the retained catalog is not eligible for a new route selection unless its connection fingerprint still matches
- **AND** the probe performs no paid or test generation

#### Scenario: A probe is advisory

- **WHEN** a valid Model Connection is saved while its automatic discovery probe is unavailable
- **THEN** FREE commits the editable configuration and returns the bounded advisory probe result without rolling back the save
- **AND** the connection remains available for a later explicit probe, while a new route selection still requires a matching discovered catalog

#### Scenario: Route selection is discovered-only

- **WHEN** a researcher selects a model for a route that was not already selected
- **THEN** FREE accepts it only when its exact ID is in that connection's latest catalog whose fingerprint matches the current connection
- **AND** an offline connection without a matching catalog may be saved but cannot receive a new route target

#### Scenario: Claude Code has no dynamic model listing

- **WHEN** a Claude Code probe confirms its external harness is installed and authenticated
- **THEN** its persisted catalog contains exactly `fable`, `opus`, `sonnet`, and `haiku`
- **AND** no other manually entered Claude Code identifier is accepted as a new route selection

#### Scenario: A selected model disappears

- **WHEN** later successful discovery omits a currently selected model
- **THEN** FREE preserves that route and returns its readiness as `model_unavailable`
- **AND** it does not select another model automatically

### Requirement: Configuration and probe endpoints expose stable observable results

FREE SHALL expose `GET /api/model_config`, whole-document `PUT /api/model_config`, and `POST /api/model_probe` with the exact `ProviderDescriptor`, `ProbeResult`, and related wire types defined in the design. GET SHALL not perform a provider network or CLI probe. A changed connection saved by PUT SHALL be committed before it is automatically probed; an advisory probe failure SHALL not roll back the save. Configuration API failures SHALL use `{ "error": { "code": string, "message": string, "details"?: unknown } }` with 400 for invalid requests, 409 for invalid model configuration, 502 for provider failure, 503 for required keyring failure, and 500 for unexpected failure. Immediate provider details MAY include a raw verbatim response body only within the design's size bound; the API MUST NOT add FREE-managed credentials, request headers, full request bodies, stack traces, or arbitrary thrown objects, and persisted observations SHALL retain only a bounded summary. A completed probe SHALL be applied only if its connection fingerprint and per-connection generation are still current; a stale result SHALL report `superseded`, `connection_changed`, or `connection_deleted` and SHALL NOT mutate saved state.

#### Scenario: Configuration starts unconfigured and is read locally

- **WHEN** a client calls `GET /api/model_config` on a fresh local Studio prototype
- **THEN** it receives the empty configuration and provider descriptors without provider or CLI traffic
- **AND** the API remains supported only through the local Vite/Studio source prototype, not a hosted deployment

#### Scenario: A changed connection is saved while offline

- **WHEN** a client PUTs a valid changed local or remote Model Connection whose automatic probe fails
- **THEN** PUT returns HTTP 200 with the committed configuration and that connection's advisory probe result
- **AND** the returned result and persisted observation do not contain a credential or raw provider response body

#### Scenario: An explicit probe fails

- **WHEN** `POST /api/model_probe` fails for a saved connection
- **THEN** FREE persists the bounded observation and returns HTTP 502 with `error.code` `provider_failure`
- **AND** its details identify the connection and retained catalog without a credential or request body

#### Scenario: An unknown connection is probed

- **WHEN** `POST /api/model_probe` names a connection absent from saved configuration
- **THEN** FREE returns HTTP 409 with `error.code` `invalid_model_config`
- **AND** it does not probe a draft connection or transient credential

#### Scenario: An overlapping probe result becomes stale

- **WHEN** a probe completes after a newer probe was allocated or after its connection, URL, or credential revision changed or was deleted
- **THEN** FREE does not persist that completed observation or catalog
- **AND** its response reports `superseded`, `connection_changed`, or `connection_deleted` while preserving the completed attempt's HTTP success or provider-failure status

### Requirement: The Model Connection page offers equivalent Single model and Capability Routes modes

The Model Connection page SHALL load backend-owned configuration state and retain visible Single model and Capability Routes modes. Single model mode SHALL save one selected discovered model as both routes. Capability Routes mode SHALL save independently selected discovered models for Extraction and Interaction. Both modes SHALL use the same whole-document save, explicit credential actions, advisory probe results, and unavailable-model display.

#### Scenario: Single model mode configures a local-only setup

- **WHEN** a researcher selects one discovered local Ollama model in Single model mode and saves
- **THEN** the saved Extraction and Interaction Routes reference that same local connection and model with the general profile
- **AND** no separate inline provider or credential configuration is created

#### Scenario: Capability Routes mode configures mixed routing

- **WHEN** a researcher assigns a local Ollama model to Extraction and a remote OpenAI model to Interaction in Capability Routes mode and saves
- **THEN** both saved routes retain their independently selected connections and models
- **AND** the page displays the returned persisted route state rather than fabricated connection status

#### Scenario: An unavailable selected model is displayed

- **WHEN** GET returns a route with readiness `model_unavailable`
- **THEN** the page displays the saved selected model as unavailable
- **AND** it does not substitute, clear, or hide that selection
