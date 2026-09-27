# model-connection-configuration Specification

## Purpose
Defines each Researcher Account's Model Connections, keys held in the researcher's browser, provider discovery, the deployment's read-only connections, and the Model Configuration page.

## Requirements

### Requirement: Each Researcher Account has one durable configuration
FREE SHALL store one configuration per Researcher Account in PostgreSQL: connections, the Interaction and Schema Suggestion Routes, the Extraction Model Choice, and the Ingestion Model Choice. It SHALL NOT store any key there. An account that never applied reads the empty configuration. `GET` and `PUT /api/model_config` SHALL read and replace only the signed-in account's configuration; applies for one account serialize on its row. FREE MUST NOT import or fall back to `AI_*` settings.

#### Scenario: A fresh account reads an empty configuration
- **WHEN** a new Researcher Account calls `GET /api/model_config`
- **THEN** it receives an empty valid configuration with no keys
- **AND** no value is imported from `AI_*` settings

#### Scenario: A second account reads none of the first's configuration
- **WHEN** one account applies a configuration and a second account reads its own
- **THEN** the second account sees only its own configuration

#### Scenario: Two applies from one account serialize
- **WHEN** two complete configuration writes for one account overlap
- **THEN** they serialize on that account's row and the last committed whole draft is authoritative

#### Scenario: A stored document that fails validation is a 500 that echoes nothing
- **WHEN** a stored configuration fails validation on read
- **THEN** the endpoint returns HTTP 500 without echoing its contents
- **AND** no reset is offered or performed

### Requirement: Configuration writes accept only researcher-editable state
`PUT /api/model_config` SHALL accept one complete editable draft with stable connection UUIDs, names, provider kinds and bases where applicable. Server-owned provider descriptors SHALL NOT be accepted inside the draft. A non-null route SHALL reference a submitted connection and MAY use any non-empty model ID without prior discovery. A researcher-defined Codex CLI or Claude Code connection SHALL be refused by Apply and Probe.

#### Scenario: Existing identity changes provider kind
- **WHEN** a submitted connection keeps its UUID but changes provider kind
- **THEN** FREE refuses the change with `invalid_model_config`
- **AND** the researcher must use a new UUID for the new kind

#### Scenario: A route dangles after an edit
- **WHEN** a connection is removed but a submitted route still names it
- **THEN** FREE refuses Apply without silently clearing or reassigning the route

#### Scenario: A researcher-defined CLI connection is refused
- **WHEN** a researcher submits a Codex CLI or Claude Code connection in Apply or Probe
- **THEN** FREE refuses it; CLI providers are available only as deployment connections

### Requirement: Keys stay in the researcher's browser
A connection SHALL record only `hasKey` (managed kinds always do). The page SHALL keep each key in `localStorage` under the signed-in account, bound to connection ID and API base; changing the base or provider SHALL clear it at once and cancel a scheduled probe. The page SHALL send keys with `PUT /api/model-keys` (write-only; entries merge; `null` removes one) on load, after Apply, before starting model work, when a response carries a new `X-FREE-Studio-Boot`, and once after `model_key_required`. Studio SHALL reject a handoff whose account differs from the session and accept a key only for one of that account's connections at its current provider and base. Studio SHALL keep keys only in memory, use a cached key only while provider and base match, and clear an account's keys at sign-out. Malformed key or probe bodies SHALL receive fixed errors that echo nothing.

#### Scenario: A key sent for one base is never used for another
- **WHEN** a researcher's page sent a key for a connection at one API base, and the connection's base is then changed
- **THEN** Studio does not use that key for the new base
- **AND** the page clears its stored key for that connection at once and schedules no probe with it

#### Scenario: A stale tab's handoff under another account is rejected
- **WHEN** a tab sends a key naming an account other than the current signed-in account
- **THEN** Studio rejects it without caching or echoing the key

#### Scenario: Sign-out clears this browser's keys and Studio's copy
- **WHEN** the researcher signs out
- **THEN** the page removes its account keys and Studio clears its in-memory copies

#### Scenario: A Studio restart is followed by a resend
- **WHEN** an open page receives a changed `X-FREE-Studio-Boot` after Studio restarts
- **THEN** it resends keys for its signed-in account before starting keyed work

#### Scenario: A malformed body echoes nothing
- **WHEN** a key handoff or probe body is malformed
- **THEN** Studio returns a fixed error without key material or raw body content

### Requirement: Keyed and keyless connections call their servers as declared
A connection with `hasKey` SHALL never call its server anonymously: with no cached key its attempt waits up to 60 seconds for a resend, ends early on an abort or workflow cancel, then fails with `model_key_required` (`isRetryable: false`). A connection without `hasKey` SHALL call anonymously, and a keyless Ollama connection SHALL NOT send the environment's `OLLAMA_API_KEY`.

#### Scenario: No cached key, no page open
- **WHEN** background work starts for a keyed connection and no page resends its key within 60 seconds
- **THEN** it fails with non-retryable `model_key_required` without calling the provider

#### Scenario: A cancel during the wait never reaches the provider
- **WHEN** a keyed attempt is cancelled while waiting for a key
- **THEN** the wait ends and no provider request is sent

#### Scenario: A keyless Ollama connection stays anonymous
- **WHEN** a keyless Ollama connection is used while `OLLAMA_API_KEY` exists in Studio's environment
- **THEN** its request has no authorization derived from that variable

### Requirement: Eight provider kinds; CLI providers are deployment connections
FREE SHALL support Ollama, OpenAI, Anthropic, Google, vLLM and OpenAI-compatible researcher connections, and Codex CLI and Claude Code only as deployment connections enabled by `FREE_DEPLOYMENT_CLI_PROVIDERS`. Deployment connections (vLLM servers from `FREE_DEPLOYMENT_*` and enabled CLI providers) SHALL be listed read-only with reserved IDs, never saved, and usable by every researcher. HTTP bases SHALL preserve valid supplied version and path prefixes, reject embedded credentials, and use the selected provider's native resource protocol.

#### Scenario: Provider bases preserve supplied versions and prefixes
- **WHEN** an HTTP connection is saved with a valid base ending in `/v1` or `/v1beta`
- **THEN** its adapter appends only resource paths beneath that exact base

#### Scenario: An API base contains embedded credentials
- **WHEN** an HTTP API base includes a username or password
- **THEN** FREE refuses it without persisting or sending the embedded value

#### Scenario: A native API base is customized
- **WHEN** an Ollama, OpenAI, Anthropic or Google connection uses a custom valid base
- **THEN** FREE keeps that provider's native protocol rather than interpreting it as OpenAI-compatible

#### Scenario: An Ollama server base reaches each native resource once
- **WHEN** an Ollama connection stores a server base with or without a path prefix
- **THEN** discovery uses `{base}/api/tags` and general generation uses `{base}/api/chat`
- **AND** FREE does not append `/api` twice or strip the prefix

#### Scenario: Native OpenAI and OpenAI-compatible use distinct generation protocols
- **WHEN** otherwise equivalent routes choose OpenAI and OpenAI-compatible connections
- **THEN** native OpenAI generates through `{base}/responses` and OpenAI-compatible through `{base}/chat/completions`
- **AND** neither adapter substitutes the other protocol

#### Scenario: An enabled CLI provider is a read-only deployment connection
- **WHEN** the operator enables Codex CLI or Claude Code
- **THEN** every researcher sees it as read-only with a reserved ID
- **AND** no account saves its own copy of that connection

### Requirement: Discovery is advisory, ephemeral and seamless
FREE SHALL probe structurally valid draft connections after provider, API base or key input settles for 500 ms, on panel open for eligible connections, and on immediate Refresh. The panel SHALL probe a keyed connection only with this browser's key for its account, provider and base. Probes SHALL always carry the key the page holds; the server never looks one up for a probe. A probe SHALL NOT generate content or change saved configuration. It SHALL return a bounded page-session result and catalog; route model IDs remain manually editable regardless of discovery. Each probe has a 15-second deadline, reads at most 1 MiB, accepts at most 10,000 unique models, and reports one of `connected`, `authentication_failed`, `unreachable`, `not_installed`, `invalid_response`, `discovery_failed`, or `timed_out`.

#### Scenario: A researcher enters a valid connection
- **WHEN** valid provider, base and key input settles for 500 ms
- **THEN** the page reports current connectivity and a catalog without saving configuration

#### Scenario: Probe input changes
- **WHEN** provider, base or key input changes during a probe
- **THEN** the page aborts where possible and ignores the obsolete response

#### Scenario: The panel opens with saved connections
- **WHEN** the page opens
- **THEN** FREE probes every eligible deployment or keyless connection and each keyed connection for which this browser holds the matching key
- **AND** it does not probe a keyed connection without a matching browser key

#### Scenario: Discovery fails
- **WHEN** a probe finds a provider offline, unauthenticated, malformed or not installed
- **THEN** its bounded failure remains advisory and Apply stays available

#### Scenario: A model ID is entered manually
- **WHEN** a researcher enters a non-empty model ID absent from discovery
- **THEN** Apply accepts it and execution later attempts that exact ID

### Requirement: Configuration and probe endpoints expose stable observable results
FREE SHALL expose `GET /api/model_config`, whole-document `PUT /api/model_config`, and `POST /api/model_probe` with the design's envelope and status rules. GET SHALL return the signed-in account's `config` and provider descriptors; PUT SHALL accept that config unchanged and return the normalized result. GET and PUT SHALL NOT probe a provider. POST SHALL accept a complete connection draft and key supplied by the page and SHALL NOT read a cached key for a probe. Configuration failures SHALL use the stable error envelope; completed negative probes return HTTP 200 with a bounded `ProbeResult`. Responses MUST NOT include a key, request headers, full request body, stack trace or arbitrary thrown object.

#### Scenario: Apply does not probe
- **WHEN** the page applies a changed connection
- **THEN** PUT returns its committed normalized configuration without a provider probe

#### Scenario: An explicit probe reports a provider failure
- **WHEN** an explicit probe reaches an unavailable or rejecting provider
- **THEN** it returns HTTP 200 with a bounded advisory failure and no key material

#### Scenario: A new draft is probed
- **WHEN** Probe receives an unsaved connection and the key the page supplies
- **THEN** it checks those draft values without first saving them
- **AND** it never returns or stores the supplied key

#### Scenario: Probes overlap
- **WHEN** two probes overlap
- **THEN** each returns the result of its own draft snapshot without changing saved configuration

### Requirement: The Model Configuration page follows the researcher's work
The page SHALL have Models and Connections tabs sharing one draft and one Apply. Models SHALL have three steps: *Reading documents* (the Ingestion Model Choice), *Schema & chat* (the *Assistant model*, which is the Interaction Route; Schema Suggestion follows it until given its own route, and an explicit Schema Suggestion route stays explicit even when equal to it), and *Extracting data* (the Extraction Model Choice). "Use defaults" SHALL remove a step's stored choice. There SHALL be no Single/Routes mode.

#### Scenario: An unset Schema Suggestion route follows the Assistant model
- **WHEN** the Assistant model is chosen and the Schema Suggestion route is unset
- **THEN** the page shows Schema Suggestion following the Assistant model

#### Scenario: An explicit route stays explicit across a reload
- **WHEN** the Schema Suggestion route is explicitly saved equal to the Assistant model
- **THEN** reloading the page retains that explicit choice

#### Scenario: Use defaults removes the stored choice
- **WHEN** a researcher chooses Use defaults for a model step and applies
- **THEN** that step's explicit route or model choice is removed from the saved configuration

#### Scenario: A manual model ID is displayed
- **WHEN** GET returns a route with a manually entered model ID
- **THEN** the page displays that exact ID even when discovery omits it

### Requirement: The Ingestion Model Choice lists what the deployment serves
The page SHALL offer OCR models from `GET /api/ingestion-models`, marking one the OCR server does not serve as not selectable, and layout presets, which are always selectable. A saved choice the listing no longer offers SHALL stay saved and shown; a listing failure SHALL block no other edit.

#### Scenario: An OCR model the server does not serve cannot be chosen
- **WHEN** the listing marks an OCR model as not serving
- **THEN** the page shows it but does not allow it as a new choice

#### Scenario: A saved choice the listing dropped stays
- **WHEN** a saved ingestion model is absent from the current listing
- **THEN** the page keeps and displays the saved choice

#### Scenario: A listing failure blocks nothing else
- **WHEN** the ingestion-model listing fails
- **THEN** the researcher can still edit and apply the other configuration steps
