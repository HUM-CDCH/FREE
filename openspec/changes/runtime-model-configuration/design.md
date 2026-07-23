## Context

Studio currently has two unrelated model-configuration paths. The Model
Connection page keeps fabricated connections, credentials, catalogs, and
statuses in React state, while the four model operations read `AI_*`
environment variables and construct providers in `_model.ts` and `_provider.ts`.
Those paths have already diverged. Provider selection, model defaults, generic
versus raw extraction, and errors consequently vary by operation.

This change is for one humanities researcher running the Studio source
prototype through Vite. Model Connections and Capability Routes are
machine-wide, not Project Context data. The supported deployment remains
Vite's implicit localhost default. Loopback is not enforced by an explicit host
binding, Host/Origin check, or socket guard; exposing Vite on another interface
is unsupported rather than prevented. Hosted Vercel and a distributable local
host cannot satisfy the local provider, user-config-directory, and OS-keyring
assumptions and remain out of scope.

The implementation must preserve Studio's current page structure and its
Single model and Capability Routes views, but the backend becomes authoritative
for provider metadata, configuration, credentials, discovery observations, and
runtime route resolution. The existing hand-built NuExtract prompt is also an
architectural constraint: Ollama ignores the control kwargs used by other
NuExtract runtimes, so raw Ollama requests must continue reconstructing the
NuExtract control-token prompt and sending it to `/api/generate` with
`raw: true`.

## Goals / Non-Goals

**Goals:**

- Persist one machine-wide, versioned model-configuration document and keep all
  FREE-managed secrets exclusively in the OS credential store.
- Define exact whole-document configuration and saved-connection probe APIs.
- Make one typed seven-provider table authoritative for UI metadata,
  authentication mode, discovery, model construction, and concrete execution
  capabilities.
- Resolve each model operation once to either an AI SDK v7 `LanguageModel` or
  the explicit raw NuExtract target.
- Expose exactly the Extraction Route and Interaction Route, with no provider,
  connection, model, route, or environment substitution.
- Preserve offline observations and selected models without treating discovery
  as a paid capability test or an execution-time allowlist.
- Use one stable error envelope and test narrow storage, keyring, provider, HTTP,
  resolver, and UI seams.

**Non-Goals:**

- Supporting remote/shared Studio deployment, adding authentication, enforcing
  loopback access, or packaging a production host.
- Retaining `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, or
  `AI_API_KEY` as bootstrap, override, or fallback inputs.
- Adding fallback routes, fallback models, provider inference, route chains,
  ensembles, or per-Project Context routes.
- Adding public Model Attribution to successful operation responses.
- Performing generation during discovery or inferring model suitability from
  names or probe results.
- Introducing provider classes, a dependency-injection framework, AI SDK's
  provider registry, a FREE-owned universal generation wrapper, or one module
  per provider.
- Redesigning unrelated model-output tolerance, Source Document input, Evidence,
  or successful operation response contracts.

## Decisions

### Persist one versioned JSON document in the OS user config directory

Use `env-paths` with the application name `FREE Studio` and store
`model-config.json` in its `config` directory. Create the directory when the
first configuration is committed. The complete persisted v1 document is:

```ts
type StoredModelConfigV1 = {
  version: 1
  connections: StoredConnection[]
  routes: {
    extraction: ExtractionRoute | null
    interaction: InteractionRoute | null
  }
}

type StoredConnection = {
  id: string                 // UUID created with crypto.randomUUID() in Studio
  name: string
  provider: ProviderKind
  baseUrl: string | null     // HTTP service root; null for CLI providers
  catalog: ModelDescriptor[] // last successful catalog; server-owned
  probe: ProbeObservation | null
}

type ModelDescriptor = { id: string; label: string }

type ProbeStatus =
  | 'connected'
  | 'authentication_failed'
  | 'unreachable'
  | 'not_installed'
  | 'invalid_response'
  | 'discovery_failed'
  | 'timed_out'

type ProbeObservation = {
  checkedAt: string          // ISO 8601 UTC
  status: ProbeStatus
  message: string            // sanitized, at most 512 Unicode code points
  upstreamStatus: number | null
}

// ProbeStatus is exhaustive. invalid_response means the provider answered but
// its discovery payload could not be parsed or validated; discovery_failed is
// any other provider/CLI model-listing failure. timed_out is FREE's own deadline.
// unreachable is reserved for transport failures before an HTTP response.
```

An absent file means the valid empty v1 configuration: no connections, both
routes `null`, and no implicit environment-derived defaults. Reads parse JSON
strictly and validate the complete versioned shape. A malformed document,
unsupported version, duplicate connection ID, invalid URL, invalid provider
kind, invalid observation, or dangling route produces `409 invalid_model_config`
with the path and bounded validation detail. FREE leaves the file byte-for-byte
unchanged and does not auto-reset, migrate, back up, or replace it.

Writes create a sibling temporary file, flush and close it, then rename it over
`model-config.json`; the JSON document is atomic at the replacement boundary.
There is no revision field or optimistic conflict protocol. An in-process FIFO
queue serializes complete PUT workflows so last-arriving Save wins coherently
within one Studio process. External file editing and coordination across Studio
processes are unsupported.

Alternatives considered:

- SQLite adds schema, migration, and dependency surface without useful query or
  concurrency requirements for this one small document.
- Browser storage cannot be machine-wide or coordinate with server-side
  credentials and model execution.
- Repository-local storage would make the configuration checkout-wide rather
  than machine-wide and conflicts with the accepted domain term.

### Separate editable configuration from server-owned state

The client may edit only connection identity/configuration and the two routes:

```ts
type EditableModelConfig = {
  version: 1
  connections: Array<{
    id: string
    name: string
    provider: ProviderKind
    baseUrl: string | null
  }>
  routes: {
    extraction: ExtractionRoute | null
    interaction: InteractionRoute | null
  }
}

type ExtractionRoute = {
  connectionId: string
  modelId: string
  profile: 'general' | 'nuextract-raw'
}

type InteractionRoute = {
  connectionId: string
  modelId: string
  profile: 'general'
}
```

Connection IDs are stable UUIDs. An existing ID cannot be reused with a
different provider kind; changing provider kind requires deleting the old Model
Connection and creating a new one. Names and HTTP-provider URLs are editable. HTTP providers require an absolute
`http:` or `https:` service-root URL with no query or fragment and may point to
any researcher-selected local or remote destination. A trailing slash is
semantically irrelevant. Provider-specific validation rejects a root that
already ends in the protocol suffix FREE appends (`/api` for Ollama, `/v1` for
OpenAI, Anthropic, and OpenAI-compatible, or `/v1beta` for Google), preventing a
stored `/v1` from becoming `/v1/v1`. CLI providers require `baseUrl: null`.

Catalogs, probe observations, managed-credential presence, provider metadata,
and route readiness are server-owned and are never accepted from PUT. The
server carries the last successful catalog forward by connection ID. A failed
probe replaces the latest probe observation but does not erase that catalog.
Changing a name does not trigger a probe; creating a connection, changing its
URL, or replacing/deleting its credential does.

A non-null route must reference a connection in the submitted document. A new
route selection is valid only when its exact model ID is in that connection's
server-owned catalog. Claude Code's static aliases are its catalog after a
successful authentication probe. Therefore a new offline connection can be
saved but cannot receive a route until discovery has produced a catalog. If an
already selected model disappears from a later successful catalog, the route is
preserved, returned as `model_unavailable`, and still executed. The client may
also preserve that route in later PUTs, but cannot create a new selection of an
absent model.

Only Ollama on the Extraction Route may use `nuextract-raw`; all other route
targets use `general`. The server rejects invalid connection/profile/provider
combinations with `409 invalid_model_config` rather than changing them.

### Use explicit credential actions and expose no secret values

Use `@napi-rs/keyring` behind a narrow adapter. Every FREE-managed credential
uses service name `FREE Studio` and account name
`model-connection/<connection UUID>`. The UUID, not the display name or URL,
makes rename and URL edits stable. No credential value or masked placeholder is
written to JSON, logged, persisted in probe observations, or returned over HTTP.

PUT carries an optional credential-action map with an explicit tri-state:

```ts
type CredentialActions = Record<string, string | null>
// omitted ID: preserve the existing keyring entry
// non-empty string: create or replace the entry
// null: delete the entry
```

Empty strings are invalid rather than aliases for preserve or delete. Action
keys must name connections in either the old or submitted document. A managed
credential must be supplied or already present for providers whose
authentication mode is `managed`; `optional` providers remain valid without
one. Deleting a Model Connection also schedules deletion of its keyring entry,
if present, without requiring a redundant `null` action. That deletion must
succeed before the JSON commit. External CLI authentication is never represented
as a FREE-managed credential and is neither created nor deleted by this API.

The configuration view reports:

```ts
type CredentialState = 'present' | 'absent' | 'unavailable' | 'not_applicable'
```

`present` and `absent` apply only to `managed` and `optional` providers;
`unavailable` means the keyring could not be queried; and `not_applicable`
applies to `none` and `external` authentication. CLI installation and login are
reported only by probe state, never as credential presence.

If the keyring is unavailable, reading configuration and using `none` or
`external` connections still work. Any PUT action or route resolution that
requires a FREE-managed credential fails with `503 keyring_unavailable`. There
is no plaintext, environment, or process-memory fallback.

### Make save ordering and cross-store partial states explicit

Each queued PUT performs these steps:

1. Strictly parse and structurally validate the request.
2. Read and validate the current JSON document and query only credential states
   needed to validate the requested change.
3. Merge server-owned catalogs and observations into the submitted editable
   document, validate routes against those catalogs, and calculate changed and
   deleted connections.
4. Apply credential creates/replacements/deletions sequentially and
   idempotently, recording each completed action.
5. Atomically replace the JSON document. At this point the configuration is
   committed and usable.
6. Probe changed non-deleted connections concurrently with bounded per-provider
   timeouts. Probe failures are advisory and do not fail or roll back the Save.
7. Atomically replace the document again with updated probe observations and
   successful catalogs, then return the final configuration view and immediate
   probe outcomes.

Keyring and filesystem writes cannot form a transaction and no compensating
rollback is attempted. If a keyring operation fails, earlier completed keyring
operations remain. If the first JSON replacement fails, a newly created or
replaced credential can remain while the old JSON stays active, or a deleted
credential can be absent while the old JSON still references that connection.
If the second replacement fails, the committed editable configuration remains
active, probes may already have contacted providers, and the prior observations
remain on disk. Error details include the completed credential action IDs and a
`configCommitted` boolean so the result is determinate and the same PUT can be
retried safely.

Route resolution deliberately does not wait for an active Save. It reads one
validated JSON snapshot and then resolves the credential needed by that
snapshot. During the short keyring-before-JSON window it may combine the old
document with a newly replaced credential, or find that a credential was
deleted before the old document was replaced. This accepted partial state is
reported normally if it causes failure; adding read/save coordination was
rejected as disproportionate for the single-researcher prototype.

Alternatives considered:

- Writing JSON first can activate a route whose requested credential was never
  stored.
- Secret rollback requires reading and retaining old secret values and itself
  has failure states, creating a misleading transaction facade.
- Unqueued PUTs can let different requests win the keyring and JSON stores.

### Define exact configuration HTTP contracts

All endpoints use `application/json`; malformed JSON, wrong content type, unknown
fields, and schema/type violations are `400 invalid_request`. Dates are ISO 8601
UTC strings, IDs are canonical UUID strings, and response arrays preserve the
stored connection order. Provider descriptors are ordered by the provider table.
The following are wire types, not illustrative implementation types:

```ts
type ProviderKind =
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'codex-cli'
  | 'claude-code'
  | 'openai-compatible'

type ProviderDescriptor = {
  kind: ProviderKind
  label: string
  transport: 'http' | 'cli'
  defaultBaseUrl: string | null
  authentication: 'none' | 'managed' | 'optional' | 'external'
  capabilities: {
    jsonOutput: 'native' | 'prompt'
    temperature: boolean
    extractionProfiles: Array<'general' | 'nuextract-raw'>
    interactionProfiles: Array<'general'>
  }
}

type ImmediateUpstreamDetail = {
  status: number | null
  body: string
  truncated: boolean
}

type ProbeApplication =
  | 'applied'
  | 'superseded'
  | 'connection_changed'
  | 'connection_deleted'

type ProbeResult = {
  connectionId: string
  application: ProbeApplication
  observation: ProbeObservation
  catalog: ModelDescriptor[]
  upstream?: ImmediateUpstreamDetail
}

type ModelProbeResponse = ProbeResult

// For application:'applied', observation and catalog are the values now stored.
// For a discarded stale result, observation describes this completed attempt and
// catalog is the currently retained catalog (or [] after connection_deleted).


type ModelConfigView = {
  config: {
    version: 1
    connections: Array<{
      id: string
      name: string
      provider: ProviderKind
      baseUrl: string | null
      credentialState: CredentialState
      catalog: ModelDescriptor[]
      probe: ProbeObservation | null
    }>
    routes: {
      extraction: RouteView<ExtractionRoute> | null
      interaction: RouteView<InteractionRoute> | null
    }
  }
  providers: ProviderDescriptor[]
}

type RouteView<T> = T & {
  readiness: 'ready' | 'connection_unavailable' | 'model_unavailable'
}
```

Readiness is an informational calculation over the same persisted snapshot used
to build the response; GET performs no fresh probe. Calculate it in this order:

1. `connection_unavailable` when the latest probe is absent or is not
   `connected`, when a `managed` credential is anything other than `present`, or
   when an `optional` credential is `unavailable`. An absent optional credential
   remains usable. CLI installation and authentication failures therefore enter
   this state through `not_installed` or `authentication_failed`; keyring query
   failure enters it through credential state.
2. `model_unavailable` when the connection is otherwise available but the
   selected model ID is absent from its latest catalog.
3. `ready` otherwise.

`connection_unavailable` takes precedence when both conditions apply. Readiness
does not gate execution: the resolver still attempts the exact selected route
and does not consult probe status or catalog membership, while a missing
required credential fails through the normal execution error contract.

`GET /api/model_config` has no request body, performs no provider network or CLI
probe, and returns `200 ModelConfigView`. It reads only the JSON document,
provider table, and credential presence required for the view. A keyring query
failure does not fail GET; affected entries use `credentialState: 'unavailable'`.

`PUT /api/model_config` accepts exactly:

```ts
type PutModelConfigRequest = {
  config: EditableModelConfig
  credentials?: CredentialActions
}
```

On a successful commit it returns:

```ts
type PutModelConfigResponse = ModelConfigView & {
  probes: ProbeResult[] // changed connections only, request order
}
```

Each changed, non-deleted connection has exactly one `ProbeResult`, in submitted
connection order. `application` reports whether that attempt was persisted.
An ordinary connectivity, authentication, installation, timeout, invalid-response,
or discovery failure is represented in this array while PUT remains `200`, because
probing occurs after commit and is advisory. `upstream` is present only for an
immediate HTTP failure with response detail. Structural invalidity is `400`; a
semantically invalid submitted or saved configuration is `409`; required keyring
failure is `503`; and an unexpected storage failure is `500` with the
completed-action information described above.

`POST /api/model_probe` accepts exactly:

```ts
type ModelProbeRequest = { connectionId: string }
```

It probes only a saved Model Connection, never a draft and never a transient
credential. Probes for the same or different connections may overlap with one
another, but persisting their server-owned observation is queued through the
same atomic document-update boundary as saves so a probe cannot restore an old
editable snapshot. It returns `ModelProbeResponse`. A successful discovery normally has
`application: 'applied'`, `status: 'connected'`, and the newly persisted catalog.

A missing saved connection at request start or corrupt saved document is `409`.
Unavailable required keyring access is `503`. Provider connectivity,
authentication, installation, timeout, response-shape, or discovery failure
returns `502 provider_failure`; its error `details` is exactly the corresponding
`ProbeResult`. The failure observation is persisted only when `application` is
`applied`; otherwise it was discarded by the stale-result rule below. No probe
performs model generation.

Every probe captures `(connectionId, provider, normalized baseUrl, credential
revision, probe generation)` before I/O. Probe generations are monotonically
allocated per connection in the document-update queue. At completion, its result
is applied only if the connection still has the same provider, normalized URL,
and credential revision and no newer generation has been allocated. Otherwise
it cannot mutate the document: `application` is respectively
`connection_deleted`, `connection_changed`, or `superseded`. This check and the
observation write occur in one queued atomic update. A discarded explicit POST
still reports its own provider success (`200`) or failure (`502`) with that
application value; it never masquerades as the current persisted observation.

### Use one ApiError envelope and bounded provider detail

Replace `RequestError`, route-specific `{ error }`, and `{ detail }` responses
with one class carrying `status`, stable `code`, public `message`, optional
JSON-safe `details`, and an internal `cause`. Every configuration error,
non-streaming model-operation error, and model-operation failure detected before
a streaming response begins uses:

```ts
type ApiErrorBody = {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
```

The status mapping is deliberately small:

| Status | Meaning |
| --- | --- |
| `400` | Invalid request syntax, JSON, form value, or explicit unsupported option |
| `409` | Invalid, incomplete, corrupt, or unsupported saved/submitted model state |
| `502` | Provider, CLI, discovery, generation, or generated-response failure |
| `503` | OS credential store unavailable for an operation that requires it |
| `500` | Unexpected implementation or storage failure |

A probe has a 15-second wall-clock deadline, including CLI startup and response
reading. HTTP discovery reads at most 1 MiB of response body and accepts at most
10,000 unique models; exceeding either bound is `invalid_response`. Model IDs and
labels are each at most 512 Unicode code points; an invalid item makes the whole
response `invalid_response` rather than producing a partial catalog.

For an immediate provider failure, `details.upstream` may contain its numeric
status and verbatim text body truncated to 8,192 UTF-8 bytes, with `truncated`
true exactly when bytes were omitted. `body` is decoded as UTF-8 with replacement.
Never include request headers, credentials, full request bodies, stack traces,
or arbitrary error objects. Persisted `ProbeObservation` keeps only timestamp,
status, upstream status, and a sanitized message truncated to 512 Unicode code
points; it never stores the raw body. Unknown thrown values become a generic `500 unexpected_failure` and are
logged with their internal cause.

Document chat has two error phases. Request parsing, route resolution, credential
lookup, and any other failure caught before the UI-message stream response is
created return the mapped HTTP status and `ApiErrorBody`. Once stream headers are
sent, the status and content type cannot change: a provider or generation
failure emits the standard AI SDK UI-message stream error part
`{ type: 'error', errorText: string }`. `errorText` is a bounded, sanitized
public message; it carries no cause, upstream body, or `details`. Protocol finish
chunks and the SSE completion marker may follow that error part, so the frontend
must call `readUIMessageStream({ stream, terminateOnError: true })` (or provide
equivalent error termination) and treat it as a failed operation rather than a
completed assistant message. The stream keeps its already committed status
(normally `200`), and an `ApiErrorBody` is never encoded as a stream event. Use
AI SDK v7's standalone `toUIMessageStream` with `createUIMessageStreamResponse`
rather than the deprecated result response helper.

Model-operation request JSON remains strict. In particular, conversational
Extraction Schema input no longer uses model-output repair. Repair remains
confined to generated text and a generated-output failure remains `502`.

### Keep one typed seven-provider table

`_provider.ts` owns one literal satisfying a `ProviderTable` type. Its entries
contain UI metadata, default URL, authentication mode, discovery function,
AI SDK model factory, and only the capabilities current orchestration consumes:
`jsonOutput`, `temperature`, and allowed execution profiles.

Every HTTP `baseUrl` in storage is an unversioned service root, not an endpoint
or versioned API root. Derive URLs by removing trailing slashes and appending the
relative path shown below without discarding any existing path prefix. For
example, the OpenAI-compatible root `https://host.example/proxy/openai` yields
`https://host.example/proxy/openai/v1/models`; no code detects or de-duplicates
an already supplied version suffix because validation rejects one.

| Kind | Metadata and auth | Discovery URL from stored root | Generation construction and URL | Concrete capabilities |
| --- | --- | --- | --- | --- |
| `ollama` | Ollama; default root `http://127.0.0.1:11434`; `optional` managed bearer credential | `GET {root}/api/tags` | `createOllama({ baseURL: root, apiKey })`; general generation uses `{root}/api/chat`, raw NuExtract uses `{root}/api/generate` | JSON `native`; temperature supported; `general` and `nuextract-raw` |
| `openai` | OpenAI; default root `https://api.openai.com`; `managed` credential | Native `GET {root}/v1/models` | `createOpenAI({ baseURL: '{root}/v1', apiKey }).responses(modelId)`; generation uses the native Responses resource at `{root}/v1/responses` | JSON `native`; temperature supported; `general` |
| `anthropic` | Anthropic; default root `https://api.anthropic.com`; `managed` credential | Native `GET {root}/v1/models` with Anthropic headers | `createAnthropic` receives API root `{root}/v1`; generation uses `{root}/v1/messages` | JSON `prompt` because schema-less JSON mode is not guaranteed; temperature supported; `general` |
| `google` | Google; default root `https://generativelanguage.googleapis.com`; `managed` credential | Native `GET {root}/v1beta/models` | `createGoogleGenerativeAI` receives API root `{root}/v1beta`; generation uses `{root}/v1beta/models/{modelId}:generateContent` or the streaming form of that resource | JSON `native`; temperature supported; `general` |
| `codex-cli` | Codex CLI; no URL; `external` authentication | Provider `listModels()` through the installed/authenticated app server | Existing isolated, tool-disabled `createCodexAppServer` factory; no HTTP URL is derived by FREE | JSON `prompt` for schema-less output; temperature unsupported; `general` |
| `claude-code` | Claude Code; no URL; `external` authentication | Check installation/authentication without generation, then expose static `fable`, `opus`, `sonnet`, `haiku` aliases | `claudeCode(modelId, { tools: [], settingSources: [] })`; no HTTP URL is derived by FREE | JSON `prompt`; temperature unsupported; `general` |
| `openai-compatible` | OpenAI-compatible; no default root; `optional` managed bearer credential | Guaranteed `GET {root}/v1/models` | `createOpenAICompatible({ name: 'free-openai-compatible', baseURL: '{root}/v1', ...credential }).chatModel(modelId)`; generation uses `{root}/v1/chat/completions` | JSON `prompt`; temperature supported by the guaranteed Chat Completions contract; `general` |

Derive discovery resource URLs separately, and pass each factory its required
base: the stored root for Ollama, `{root}/v1` for OpenAI, Anthropic, and
OpenAI-compatible, and `{root}/v1beta` for Google. SDK default base URLs are
never combined with a stored root. Native-provider custom roots retain that
provider's protocol. The join helper must preserve path prefixes; for example,
it may construct `new URL('v1/models',`${trimmedRoot}/`)` but must not use a
leading `/v1/models`, which would discard `/proxy/openai`. This makes the generic
provider's contract exactly the two relative resources `/v1/models` and
`/v1/chat/completions` beneath the stored root and prevents `/v1/v1/...` joins.

`managed` means a credential is required and owned by FREE, `optional` means
FREE may own one, and `external` means the provider harness owns installation
and authentication. The table is converted to serializable
`ProviderDescriptor` values for the UI; functions and secrets never cross the
HTTP boundary. The generic provider guarantees only `/v1/models` and
`/v1/chat/completions`, including streaming. Native-provider custom URLs still
use that provider's native protocol and are not silently treated as generic.

These capabilities describe adapter/protocol behavior, not per-model
suitability. Discovery metadata cannot override them. If an operation includes
an explicit temperature and the resolved entry says temperature is unsupported,
the operation returns `400 unsupported_temperature`; it does not warn or omit
the option. This is a breaking validation change for Codex CLI and Claude Code,
which previously accepted an explicit temperature and silently omitted it. The
proposal and Capability Route delta specification must identify that break. If
temperature is absent, provider-specific current defaults remain
unchanged. Generic structured generation uses AI SDK `Output.json()` only for
`jsonOutput: 'native'`; otherwise it uses the existing JSON-only prompt and
generated-text parse/repair path, without retrying through another mode.

Alternatives considered:

- Provider classes or files add boilerplate without independent provider
  lifecycles or extension loading.
- Separate metadata, discovery, and construction switches recreate the current
  synchronization problem.
- AI SDK's provider registry does not model saved connections, credentials,
  catalogs, profiles, or route identity and would create a second registry.
- Behavioral capability probes are paid, stale, and cannot prove that ignored
  parameters were honored.

### Resolve exactly two Capability Routes to direct execution targets

Keep the route map keyed by `extraction` and `interaction` so another named
capability family can be added later, but define exactly these two keys in v1.
The operation mapping is fixed:

| Operation | Capability Route |
| --- | --- |
| Extraction | Extraction Route |
| Schema Suggestion | Extraction Route |
| Document chat | Interaction Route |
| Conversational Extraction Schema editing | Interaction Route |

Each operation calls `resolveCapabilityRoute()` once. Resolution reads and
validates one immutable configuration snapshot, finds the exact route and Model
Connection, reads only that connection's credential if required, and constructs
the selected target per operation. Apart from retaining the process-owning
Codex app server, models/providers are not cached and therefore require no
configuration invalidation.

```ts
type GeneralExecutionTarget = {
  profile: 'general'
  model: LanguageModel
  jsonOutput: 'native' | 'prompt'
  temperature: 'supported' | 'unsupported'
}

type NuExtractRawExecutionTarget = {
  profile: 'nuextract-raw'
  modelId: string
  baseUrl: string
  authorization: string | null
  temperature: 'supported'
}

type ExecutionTarget = GeneralExecutionTarget | NuExtractRawExecutionTarget
```

The general target deliberately exposes AI SDK v7's `LanguageModel` directly.
The existing orchestrator uses `generateText`, `streamText`, `Output`, and
`convertToModelMessages` without a FREE generation gateway. The raw target is
data for the one specialized NuExtract transport already owned by `_model.ts`;
it is not a universal transport interface.

Missing routes, missing connections, unsupported profiles, and required
credential absence fail explicitly. The resolver does not consult the other
route, another connection, another model, the latest catalog, model-name
heuristics, environment variables, or provider defaults. A selected model
missing from the latest catalog is still passed unchanged to the selected
factory because discovery is advisory. Provider or model failure is returned
unchanged in routing terms and never triggers substitution.

Both Interaction-routed operations have an explicit Source Document context
contract. Document chat sends canonical Source Document Markdown with the
conversation. Conversational Extraction Schema editing sends that same canonical
Markdown when its existing nullable document source is present; when the source
is `null`, editing proceeds with the conversation and current Extraction Schema
only, without a synthetic document placeholder. Neither operation sends raw
Docling output or selects a different provider based on input media. Existing
successful response shapes and the nullable schema-edit source contract remain
unchanged.

### Preserve the raw NuExtract prompt as a specialized path

For an Ollama Extraction Route with `profile: 'nuextract-raw'`, preserve the
current `renderNuExtractPrompt` and `/api/generate` behavior:

- Build the hand-authored `<|im_start|>` prompt with `【task】`, optional
  `【template_start】...【template_end】`, structured-only
  `【instructions_start】...【instructions_end】`,
  `【document_start】...【document_end】`, image placeholders, and the existing
  non-thinking `<think></think>` assistant suffix.
- Put schema-suggestion guidance first in template-generation message content;
  do not invent an instructions slot for that mode.
- Send `raw: true`, `stream: false`, extracted base64 images, the exact selected
  `modelId`, the resolved Model Connection URL/credential, and temperature
  `0.2` when the caller did not supply one.
- Do not send `chat_template_kwargs`, infer NuExtract from a model ID, route raw
  NuExtract through AI SDK, or move prompt semantics into the provider table.

This is the only exception to direct AI SDK model execution. It preserves the
archived control-channel evidence while allowing general Ollama models to use
the same AI SDK path as other providers.

### Keep the module shape small

Make the minimum cohesive changes under `prototypes/studio`:

- Add `_model_config.ts` for schemas, OS-path persistence, atomic replacement,
  the save queue, and the narrow keyring adapter.
- Evolve `_provider.ts` into the single provider table plus discovery,
  serializable metadata, credential-aware construction, and route resolution.
- Keep `_model.ts` as the one orchestrator for the four operations and the raw
  NuExtract renderer/transport; remove all environment selection and direct
  general-provider construction from it.
- Keep `_http.ts` as `ApiError`, JSON response helpers, strict option parsing,
  and the single error mapper.
- Add only `model_config.ts` and `model_probe.ts` route modules.
- Replace the legacy code module `providerConfig.data.ts`'s fabricated
  provider/catalog state with API types and small view helpers; the filename is
  an implementation identifier, not a visible domain label. Do not create a
  frontend provider registry.

Plain function parameters provide test seams for storage root, keyring adapter,
clock, fetch/CLI discovery adapters, and provider factories. Production exports
bind the real dependencies. No general DI container or composition root is
needed.

### Test through narrow deterministic seams

Vitest covers real module behavior with isolated adapters:

- Use a temporary config root to test absent, valid, corrupt, unsupported,
  atomic-replacement-failure, observation-preservation, and concurrent-save
  behavior without touching the researcher's config directory.
- Use a fake keyring to test credential tri-state, service/account naming,
  required deletion, unavailable-keyring degradation, mutation ordering,
  idempotent retries, and every documented cross-store partial state.
- Use fake HTTP/CLI provider adapters to table-test all seven metadata entries,
  auth modes, discovery mappings, static Claude aliases, retained catalogs,
  bounded upstream detail, and no generation during probes. Assert separately
  that native OpenAI constructs a Responses model targeting `/v1/responses`,
  while OpenAI-compatible constructs a Chat Completions model targeting
  `/v1/chat/completions`, so the two adapters cannot collapse onto one protocol.
- Test GET, PUT, and POST handlers against the exact wire schemas, readiness
  precedence, and status mapping, including advisory PUT probe failures.
- Test document chat failures before stream creation as HTTP `ApiErrorBody`
  responses and failures after stream commitment as AI SDK error parts.
- Table-test all four operation-to-route mappings, exact selected IDs,
  disappeared selected models, missing routes, profile restrictions,
  unsupported temperature, both Interaction context cases (including nullable
  schema-edit source), no `AI_*` reads, and no fallback.
- Retain focused golden tests for every raw NuExtract mode and request field so
  provider refactoring cannot change its hand-built prompt or `raw: true` call.
- Test the React page with mocked fetch for load, explicit Save, post-commit
  probe results, credential preserve/replace/delete, keyring unavailability,
  corrupt configuration, offline connection save, catalog-gated route selection,
  and unavailable selected-model display.

Add Playwright only for browser UI workflows, intercepting
`/api/model_config` and `/api/model_probe` with mocked HTTP. Cover Single model
and mixed Capability Routes, Save/reload, probe refresh, offline save, route
gating, credential-state display, and stable error rendering. Playwright must
not access the real config directory, keyring, provider network, or CLI processes;
Vitest
owns those integration boundaries.

## Risks / Trade-offs

- **Supported localhost can be overridden and expose credential-backed APIs** ->
  Document `pnpm dev` with Vite's implicit localhost as the only supported
  deployment and require a new authenticated-host design before supporting any
  non-loopback binding.
- **Keyring and JSON cannot commit atomically** -> Apply idempotent credential
  actions first, report completed actions and `configCommitted`, serialize saves,
  and document safe retry instead of claiming rollback.
- **Resolution can observe a Save's cross-store intermediate state** -> Keep the
  accepted behavior explicit; failures are visible and no unintended provider,
  route, or model is substituted.
- **Post-commit probing makes PUT slower** -> Probe only changed connections,
  run probes concurrently with timeouts, and avoid background job state.
- **A second observation write can fail after configuration commit** -> Return
  `configCommitted: true`, leave the committed editable document active, and
  allow a manual probe or retry to refresh observations.
- **Discovery catalogs can be incomplete or stale** -> Use them only to gate new
  selections and inform UI readiness; preserve and attempt existing selections.
- **Provider-wide capabilities can overstate a particular model** -> Treat them
  as protocol-path declarations only; return provider/model failures without
  fallback and add a capability field only when orchestration needs it.
- **Arbitrary HTTP URLs can send Source Document content or credentials over an
  insecure or remote connection** -> Display the configured URL and rely on the
  researcher's explicit route selection, as accepted; add no hidden URL rewrite
  or special egress confirmation.
- **Persisted provider summaries can contain sensitive text** -> Bound and
  normalize the summary, persist no raw body, and expose at most 8 KiB of raw
  upstream response only in the immediate error.
- **Native keyring availability varies, especially on headless Linux** -> Degrade
  only managed-credential operations and keep credentialless and external-auth
  connections usable without a fallback secret store.

## Migration Plan

`tasks.md` owns the executable sequence. Its work items must be fresh-session,
vertical tracer slices: each slice is independently understandable and
verifiable, leaves the workspace building, and includes the relevant tests and
documentation rather than relying on a later slice to repair it. The rollout
must not expose a researcher-facing path until the configuration it depends on
is durable and its failure behavior is covered. The final cutover must preserve
raw NuExtract behavior, remove `AI_*` model configuration without fallback, and
keep browser tests isolated from real credentials, providers, CLI processes,
and configuration files.

There is no persisted legacy configuration to migrate. A fresh install begins
unconfigured. Rollback requires reverting the code; the v1 JSON and keyring
entries may remain inert for a later retry or can be removed manually. Rollback
must not silently translate them back into environment variables.

## Open Questions

None. The loopback, cross-store partial-state, URL-root, readiness, Interaction
context, streaming-error, temperature, and offline-route contracts are resolved
above.
