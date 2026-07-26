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
for provider metadata, configuration, credentials, and runtime route resolution.
Explicit probe results remain ephemeral UI assistance. The existing hand-built NuExtract prompt is also an
architectural constraint: Ollama ignores the control kwargs used by other
NuExtract runtimes, so raw Ollama requests must continue reconstructing the
NuExtract control-token prompt and sending it to `/api/generate` with
`raw: true`.

## Goals / Non-Goals

**Goals:**

- Persist one machine-wide model-configuration document and keep all
  FREE-managed secrets exclusively in the OS credential store.
- Define exact whole-document configuration and draft-connection probe APIs.
- Make one typed seven-provider table authoritative for UI metadata,
  authentication mode, discovery, model construction, and concrete execution
  capabilities.
- Resolve each model operation once to either an AI SDK v7 `LanguageModel` or
  the explicit raw NuExtract target.
- Expose exactly the Extraction Route and Interaction Route, with no provider,
  connection, model, route, or environment substitution.
- Report current connection usability while valid connection input settles or on
  explicit retry, and accept manual model IDs without treating discovery as a
  paid capability test or allowlist.
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

The broader CQ follow-ups remain deliberately outside this change. Runtime
configuration changes the client-request boundary and error transport, but does
not add cancellation propagation, centralize the schema-type vocabulary, expose
partial Extraction validation issues, change evidence unwrapping, or require
integer-only Evidence pages. Existing generated-output tolerance also remains
unchanged: parseable Extraction output that does not match its schema stays on
the current tolerant path, individual invalid conversational Extraction Schema
edit operations remain filtered, and a non-array edit result remains the
existing no-op. These behaviors are regression-tested rather than tightened
under the new `502` provider/generated-output error mapping.

## Decisions

### Persist one JSON document in the OS user config directory

Use `env-paths` with the application name `FREE Studio` and store
`model-config.json` in its `config` directory. Create the directory when the
first configuration is committed. The complete persisted document is:

```ts
type ModelConfig = {
  connections: ModelConnection[]
  routes: Routes
}

type ModelConnection = {
  id: string                 // UUID created with crypto.randomUUID() in Studio
  name: string
  provider: ProviderKind
  baseUrl: string | null     // Provider API base; null for CLI providers
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

// ProbeStatus is exhaustive. invalid_response means the provider answered but
// its discovery payload could not be parsed or validated; discovery_failed is
// any other provider/CLI model-listing failure. timed_out is FREE's own deadline.
// unreachable is reserved for transport failures before an HTTP response.
```

Probe adapters map observations consistently: `connected` means the discovery
response or CLI catalog was valid; `authentication_failed` means an HTTP 401/403
or an equivalent authenticated-harness failure; `unreachable` means transport
failure before an HTTP response; `not_installed` means a required CLI harness is
absent; `invalid_response` means a response violates the bounded discovery
shape; `timed_out` means the 15-second FREE deadline elapsed; and
`discovery_failed` covers other provider or CLI listing failures, including
non-authentication HTTP failures.

An absent file means the valid empty configuration: no connections, both routes
`null`, and no implicit environment-derived defaults. Reads parse JSON strictly
and validate the complete shape. A malformed document, duplicate connection ID,
invalid URL, invalid provider kind, or dangling route produces
`409 invalid_model_config` with the path and bounded validation detail. FREE
leaves the file byte-for-byte unchanged and does not auto-reset, back up, or
replace it.

Writes create a sibling temporary file, flush and close it, then rename it over
`model-config.json`; the JSON document is atomic at the replacement boundary.
There is no document revision field, optimistic conflict protocol, or save
queue. The Apply button is disabled while its request is active. External file
editing, overlapping PUT requests, and coordination across Studio processes are
unsupported.

Alternatives considered:

- SQLite adds schema, migration, and dependency surface without useful query or
  concurrency requirements for this one small document.
- Browser storage cannot be machine-wide or coordinate with server-side
  credentials and model execution.
- Repository-local storage would make the configuration checkout-wide rather
  than machine-wide and conflicts with the accepted domain term.

### Share one configuration shape and keep server-owned state separate

`ModelConfig` and `ModelConnection` are the single non-secret configuration
shapes used for persistence, GET and PUT `config`, and the React draft. The
client may edit only connection identity/configuration and the two routes;
credential states and provider descriptors remain server-owned siblings.

```ts
type Route = {
  connectionId: string
  modelId: string
}

// Only extraction can opt into raw NuExtract. The flag is absent for the
// general path and is not representable on Interaction.
type Routes = {
  extraction: (Route & { nuextractRaw?: true }) | null
  interaction: Route | null
}
```

Connection IDs are stable UUIDs. An existing ID cannot be reused with a
different provider kind; changing provider kind requires deleting the old Model
Connection and creating a new one. At most one `codex-cli` connection and one
`claude-code` connection may exist because each kind resolves the same local
executable and external authentication; HTTP provider kinds may have multiple
connections. Names and HTTP-provider URLs are editable. HTTP providers require an
absolute `http:` or `https:` provider API base with no username, password,
query, or fragment and may point to any researcher-selected local or remote
destination. A trailing slash is semantically irrelevant. The configured base
is stored exactly as entered (apart from insignificant trailing slashes), so
conventional API bases such as `/v1` are valid. Adapters append only their
resource-local paths. CLI providers require `baseUrl: null`.

A non-null route must reference a connection in the submitted document. A new
route selection accepts its exact non-empty model ID without prior discovery.
Model IDs are opaque provider identifiers and are never substituted or rejected
because an explicit probe omitted them.

`nuextractRaw` on the Extraction Route is valid only when its connection is
Ollama; every other route target runs the general path, and the Interaction
Route cannot request raw NuExtract at all. The server rejects a `nuextractRaw`
Extraction Route whose connection is not Ollama with `409 invalid_model_config`
rather than coercing it.

### Use explicit credential actions and expose no secret values

Use `@napi-rs/keyring` behind a narrow adapter. Every FREE-managed credential
uses service name `FREE Studio` and account name
`model-connection/<connection UUID>`. The UUID, not the display name or URL,
makes rename and URL edits stable. No credential value or masked placeholder is
written to JSON, logged, included in probe results, or returned over HTTP.

PUT carries an optional credential-action map with an explicit tri-state:

```ts
type CredentialActions = Record<string, string | null>
// omitted ID: preserve the existing keyring entry
// non-empty string: create or replace the entry
// null: delete the entry
```

Empty strings are invalid rather than aliases for preserve or delete. Action
keys must name connections in the submitted document. A managed credential must
be supplied or already present for providers whose authentication mode is
`managed`; `optional` providers remain valid without one. Removing a Model
Connection is represented solely by its absence. After the JSON commit, FREE
best-effort deletes any credential belonging to the removed connection; an inert
orphan is harmless. External CLI authentication is never represented as a
FREE-managed credential and is neither created nor deleted by this API.

Configuration responses report credential state in a sibling map keyed by
connection UUID:

```ts
type CredentialState = 'present' | 'absent' | 'unavailable'
```

`present` and `absent` apply only to `managed` and `optional` providers;
`unavailable` means the keyring could not be queried. An absent map entry means
FREE does not manage a credential for that connection. CLI installation and
login are reported only by probe state, never as credential presence.

If the keyring is unavailable, reading configuration and using `external`
connections still work. Any PUT action or route resolution that
requires a FREE-managed credential fails with `503 keyring_unavailable`. There
is no plaintext, environment, or process-memory fallback.

### Keep Apply a simple single-user workflow

The page owns one editable React draft and sends it through one Apply request.
Existing credential values are never loaded into that draft: an omitted action
preserves a credential, a non-empty value replaces it, and `null` removes it.
While Apply is pending the page disables Apply; success replaces the draft with
the returned normalized `config`, while failure keeps the draft and displays the
error so the researcher can retry.

Connection checking is separate from Apply. Once a draft connection has a valid
provider, API base where applicable, and required credential source, the
page waits 500 ms after the latest provider/API-base/credential edit and probes
that draft. It shows checking, connected, or the bounded failure beside the edited
connection. Changing only its name or a route model ID does not probe. Opening
the panel does not probe every saved connection. Refresh models provides an
immediate retry.

The browser aborts an in-flight request when probe inputs change and ignores any
response except the latest request for that connection. Probe failure never
disables Apply: the check is useful evidence, not a generation capability test.
The status and catalog live only in page state and disappear on reload.

Each PUT performs these steps:

1. Strictly parse and structurally validate the request.
2. Read and validate the current JSON document and query only credential states
   needed to validate the requested change.
3. Validate routes and calculate deleted connections.
4. Apply explicit credential creates, replacements, and deletions for submitted
   connections only.
5. Atomically replace the JSON document. At this point the configuration is
   committed and usable.
6. Best-effort delete credentials belonging to removed connections and return
   the normalized configuration and credential states. A leftover credential is
   inert because its UUID is absent from the authoritative JSON document.

Keyring and filesystem writes cannot form a transaction and no compensating
rollback is attempted. A rare failure after a credential replacement but before
the JSON replacement can leave that credential paired with the old
configuration. The API returns the ordinary storage error, keeps no action
journal, and permits Apply to be retried. JSON remains authoritative; orphaned
credentials are harmless and may be cleaned up by a later successful Apply.

Alternatives considered:

- Writing JSON first can activate a route whose requested credential was never
  stored.
- Secret rollback and action journals add failure states and retained secret
  handling disproportionate to a single-user local prototype.

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
  authentication: 'managed' | 'optional' | 'external'
  supportsNuextractRaw: boolean
}

type ImmediateUpstreamDetail = {
  status: number | null
  body: string
  truncated: boolean
}

type ProbeResult = {
  checkedAt: string
  status: ProbeStatus
  message: string
  catalog: ModelDescriptor[]
  upstream?: ImmediateUpstreamDetail
}

type ModelProbeResponse = ProbeResult

type ModelConfigState = {
  config: ModelConfig
  // Entries exist only for managed and optional connections.
  credentialStates: Record<string, CredentialState>
}

type GetModelConfigResponse = ModelConfigState & {
  providers: ProviderDescriptor[]
}

type PutModelConfigResponse = ModelConfigState

```

`GET /api/model_config` has no request body, performs no provider network or CLI
probe, and returns `200 GetModelConfigResponse`. It reads only the JSON document,
provider table, and credential presence required for the view. A keyring query
failure does not fail GET; affected map entries use `unavailable`.

`PUT /api/model_config` accepts exactly:

```ts
type PutModelConfigRequest = {
  config: ModelConfig
  credentials?: CredentialActions
}
```

On a successful commit it returns `PutModelConfigResponse`, including the
normalized configuration but not the static provider descriptors. It never
probes. Structural invalidity is `400`; a semantically
invalid submitted or saved configuration is `409`; required keyring failure is
`503`; and an unexpected storage failure is `500`.

`POST /api/model_probe` accepts exactly:

```ts
type ModelProbeRequest = {
  connection: ModelConnection
  credential?: string | null
}
```

It probes the supplied structurally valid draft. An omitted credential reuses
the keyring entry only when the UUID and provider identify an existing saved
connection; a non-empty string is a request-local override, and `null` explicitly
tests without a managed credential. Empty strings are invalid. A reused keyring
entry is therefore sent to the draft's API base, not the saved one, so editing a
saved connection's API base and checking it before Apply discloses that
credential to the edited host. This is accepted: the researcher supplies both the
host and the credential, Studio is loopback-only, and refusing to check an edited
API base would make the credential unverifiable exactly when it changed hosts. The request-local
credential is never logged, returned, or stored. Probes may overlap and
independently return `ModelProbeResponse`; they never mutate configuration or the
keyring. A successful discovery has `status: 'connected'` and a catalog that the
current page session may offer as selection help. Every completed probe,
including a negative connectivity or discovery observation, returns `200` with
this same `ProbeResult` shape.

An omitted required credential with no matching saved keyring entry is `409`.
Unavailable required keyring access is `503`. Invalid requests and unexpected
server failures use their normal non-2xx envelopes; provider connectivity,
authentication, installation, timeout, response-shape, and discovery failures
are completed probe observations rather than `502` errors. No probe performs
model generation or writes configuration.

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
| `502` | Provider, CLI, generation, or generated-response failure for model operations |
| `503` | OS credential store unavailable for an operation that requires it |
| `500` | Unexpected implementation or storage failure |

A probe has a 15-second wall-clock deadline, including CLI startup and response
reading. HTTP discovery reads at most 1 MiB of response body and accepts at most
10,000 unique models; exceeding either bound is `invalid_response`. Model IDs and
labels are each at most 512 Unicode code points; an invalid item makes the whole
response `invalid_response` rather than producing a partial catalog.

For an immediate credentialless provider failure, `details.upstream` may contain
its numeric status and raw verbatim provider response body truncated to 8,192
UTF-8 bytes, with `truncated` true exactly when bytes were omitted. `body` is
decoded as UTF-8 with replacement. This credentialless raw detail is
immediate-only and is not described as sanitized. When the effective HTTP probe
credential is non-null, FREE omits immediate upstream detail from every
observation, including authentication failures, other non-2xx responses,
oversized bodies, invalid JSON, and invalid catalogs. FREE MUST NOT add request
headers, FREE-managed credentials, full request bodies, stack traces, or
arbitrary error objects to the envelope. Ephemeral `ProbeResult` keeps only its
bounded timestamp, status, message, catalog, and any permitted credentialless
immediate upstream detail; it never persists a raw provider body.
Unknown thrown values become a generic `500 unexpected_failure`; their internal
cause is retained only for safe server-side diagnostics, never serialized into
an API response or persisted configuration.

Document chat has two error phases. Request parsing, route resolution, credential
lookup, and any other failure caught before the UI-message stream response is
created return the mapped HTTP status and `ApiErrorBody`. Once stream headers are
sent, the status and content type cannot change: a provider or generation
failure emits the standard AI SDK UI-message stream error part
`{ type: 'error', errorText: string }`. `errorText` is a sanitized public
message of at most 512 Unicode code points; it carries no cause, upstream body,
or `details`. Protocol finish
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
contain UI metadata, default API base, authentication mode, discovery function,
AI SDK model factory, and concrete execution capabilities. The serializable
provider descriptor exposes only UI metadata, authentication, default base, and
`supportsNuextractRaw`; JSON-output and temperature capabilities remain
backend-only.

Every HTTP `baseUrl` in storage is the exact provider API base, including any
version prefix researchers supply. Derive URLs by removing trailing slashes and
appending only resource-local paths without discarding an existing path prefix.
For example, the OpenAI-compatible base `https://host.example/proxy/openai/v1`
yields `https://host.example/proxy/openai/v1/models`; no suffix rejection or
version normalization is performed.

| Kind | Metadata and auth | Discovery URL from stored API base | Generation construction and URL | Concrete capabilities |
| --- | --- | --- | --- | --- |
| `ollama` | Ollama; default API base `http://127.0.0.1:11434/api`; `optional` managed bearer credential | `GET {root}/tags` | `createOllama({ baseURL: root, apiKey })`; general generation uses `{root}/chat`, raw NuExtract uses `{root}/generate` | JSON `native`; `temperatureSupported: true`; `general` and `nuextract-raw` |
| `openai` | OpenAI; default API base `https://api.openai.com/v1`; `managed` credential | Native `GET {root}/models` | `createOpenAI({ baseURL: root, apiKey }).responses(modelId)`; generation uses `{root}/responses` | JSON `native`; `temperatureSupported: true`; `general` |
| `anthropic` | Anthropic; default API base `https://api.anthropic.com/v1`; `managed` credential | Native `GET {root}/models` with Anthropic headers | `createAnthropic` receives API root `{root}`; generation uses `{root}/messages` | JSON `prompt` because schema-less JSON mode is not guaranteed; `temperatureSupported: true`; `general` |
| `google` | Google; default API base `https://generativelanguage.googleapis.com/v1beta`; `managed` credential | Native `GET {root}/models` | `createGoogleGenerativeAI` receives API root `{root}`; generation uses `{root}/models/{modelId}:generateContent` or the streaming form of that resource | JSON `native`; `temperatureSupported: true`; `general` |
| `codex-cli` | Codex CLI; no URL; `external` authentication | Provider `listModels()` through the installed/authenticated app server | Existing isolated, tool-disabled `createCodexAppServer` factory; no HTTP URL is derived by FREE | JSON `prompt` for schema-less output; `temperatureSupported: false`; `general` |
| `claude-code` | Claude Code; no URL; `external` authentication | Check installation/authentication without generation, then expose static `fable`, `opus`, `sonnet`, `haiku` aliases | `claudeCode(modelId, { tools: [], settingSources: [] })`; no HTTP URL is derived by FREE | JSON `prompt`; `temperatureSupported: false`; `general` |
| `openai-compatible` | OpenAI-compatible; no default API base; `optional` managed bearer credential | Guaranteed `GET {root}/models` | `createOpenAICompatible({ name: 'free-openai-compatible', baseURL: root, ...credential }).chatModel(modelId)`; generation uses `{root}/chat/completions` | JSON `prompt`; `temperatureSupported: true` under the guaranteed Chat Completions contract; `general` |

Derive discovery resource URLs by appending `/models` to the exact stored API
base, and pass each factory that same base. SDK default base URLs are never
combined with a stored API base. Native-provider custom bases retain that
provider's protocol. The join helper must preserve path prefixes and must not use a leading
slash that discards them. The generic provider's contract is exactly the two
relative resources `/models` and `/chat/completions` beneath its stored API base.

`managed` means a credential is required and owned by FREE, `optional` means
FREE may own one, and `external` means the provider harness owns installation
and authentication. The table is converted to serializable
`ProviderDescriptor` values for the UI; functions and secrets never cross the
HTTP boundary. The generic provider guarantees only `/models` and `/chat/completions`, including streaming. Native-provider custom URLs still
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

Define the route map with exactly the two current keys, `extraction` and
`interaction`.
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
  temperatureSupported: boolean
}

type NuExtractRawExecutionTarget = {
  profile: 'nuextract-raw'
  modelId: string
  baseUrl: string
  authorization: string | null
  temperatureSupported: boolean
}

type ExecutionTarget = GeneralExecutionTarget | NuExtractRawExecutionTarget
```

The general target deliberately exposes AI SDK v7's `LanguageModel` directly.
The existing orchestrator uses `generateText`, `streamText`, `Output`, and
`convertToModelMessages` without a FREE generation gateway. The raw target is
data for the one specialized NuExtract transport already owned by `_model.ts`;
it is not a universal transport interface.

Missing routes, missing connections, a `nuextractRaw` Extraction Route on a
non-Ollama connection, and required credential absence fail explicitly. The resolver does not consult the other
route, another connection, another model, an explicit probe result, model-name
heuristics, environment variables, or provider defaults. A selected model
missing from an explicit probe result is still passed unchanged to the selected
factory because discovery is advisory. Provider or model failure is returned
unchanged in routing terms and never triggers substitution.

Both Interaction-routed operations have an explicit Source Document context
contract. Transport envelopes and pre-stream versus committed-stream behavior
are owned by `studio-model-operation-contract`; this route specification keeps
only route-specific causes and no-fallback requirements. Document chat sends canonical Source Document Markdown with the
conversation. Conversational Extraction Schema editing sends that same canonical
Markdown when its existing nullable document source is present; when the source
is `null`, editing proceeds with the conversation and current Extraction Schema
only, without a synthetic document placeholder. Neither operation sends raw
Docling output or selects a different provider based on input media. Existing
successful response shapes and the nullable schema-edit source contract remain
unchanged.

### Preserve the raw NuExtract prompt as a specialized path

For an Ollama Extraction Route with `nuextractRaw: true`, preserve the
current `renderNuExtractPrompt` and `/generate` resource behavior beneath the
stored Ollama API base:

- Build the hand-authored `<|im_start|>` prompt with `【task】`, optional
  `【template_start】...【template_end】`, structured-only
  `【instructions_start】...【instructions_end】`,
  `【document_start】...【document_end】`, image placeholders, and the existing
  non-thinking `<think></think>` assistant suffix.
- Put schema-suggestion guidance first in template-generation message content;
  do not invent an instructions slot for that mode.
- Send `raw: true`, `stream: false`, extracted base64 images, the exact selected
  `modelId`, the resolved Model Connection API base/credential, and temperature
  `0.2` when the caller did not supply one.
- Do not send `chat_template_kwargs`, infer NuExtract from a model ID, route raw
  NuExtract through AI SDK, or move prompt semantics into the provider table.

This is the only exception to direct AI SDK model execution. It preserves the
archived control-channel evidence while allowing general Ollama models to use
the same AI SDK path as other providers.

### Keep the module shape small

Make the minimum cohesive changes under `prototypes/studio`:

- Add `_model_config.ts` for schemas, OS-path persistence, atomic replacement,
  and the narrow keyring adapter.
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

- Use a temporary config root to test absent, valid, malformed, duplicate-ID,
  dangling-route, and atomic-replacement-failure cases without touching the
  researcher's config directory. Also test that embedded URL userinfo is
  rejected.
- Use a fake keyring to test credential tri-state, service/account naming,
  unavailable-keyring degradation, and best-effort orphan cleanup.
- Use fake HTTP/CLI provider adapters to table-test all seven metadata entries,
  auth modes, discovery mappings, static Claude aliases, CLI singleton
  validation, bounded upstream detail, and no generation during
  probes. Assert separately that native OpenAI constructs a Responses model
  targeting `/responses`, while OpenAI-compatible constructs a Chat
  Completions model targeting `/chat/completions`, so the two adapters cannot
  collapse onto one protocol.
- Test GET, PUT, and POST handlers against the exact wire schemas and status
  mapping, including no probes during GET/PUT and no writes during POST.
- Test document chat failures before stream creation as HTTP `ApiErrorBody`
  responses and failures after stream commitment as AI SDK error parts with the
  512-code-point public error bound.
- Table-test all four operation-to-route mappings, exact selected IDs,
  arbitrary selected model IDs, missing routes, raw-flag restrictions,
  unsupported temperature, both Interaction context cases (including nullable
  schema-edit source), no `AI_*` reads, and no fallback.
- Retain regression tests for the deferred output behavior: tolerant
  parseable Extraction mismatches, filtered invalid schema-edit operations,
  non-array schema-edit no-ops, and existing fractional Evidence-page handling.
- Retain focused golden tests for every raw NuExtract mode and request field so
  provider refactoring cannot change its hand-built prompt or `raw: true` call.
- Test the React page with mocked fetch for load, Apply, debounced draft probes,
  stale response suppression, no panel-open or Apply probe, manual model IDs, credential preserve/replace/delete,
  keyring unavailability, corrupt configuration, and offline connection save.

Add Playwright only for browser UI workflows, intercepting
`/api/model_config` and `/api/model_probe` with mocked HTTP. Cover Single model
and mixed Capability Routes, Save/reload, seamless draft checking, manual probe
refresh, manual model IDs, offline save, credential-state display, and stable error rendering. The earlier idea
of browser tests against fake provider servers is superseded: Playwright does
not exercise real model operations or provider servers. It must not access the
real config directory, keyring, provider network, or CLI processes; Vitest owns
those integration boundaries.

## Risks / Trade-offs

- **Supported localhost can be overridden and expose credential-backed APIs** ->
  Document `pnpm dev` with Vite's implicit localhost as the only supported
  deployment and require a new authenticated-host design before supporting any
  non-loopback binding.
- **Keyring and JSON cannot commit atomically** -> Keep JSON authoritative, show
  an ordinary Apply error, permit retry, and tolerate inert orphaned credentials
  instead of adding rollback, transaction journals, or save coordination.
- **Discovery catalogs can be incomplete or immediately stale** -> Keep them
  ephemeral, label Refresh models as a current connectivity check, permit manual
  model IDs, and never use a result to gate saved configuration or execution.
- **Provider-wide capabilities can overstate a particular model** -> Treat them
  as protocol-path declarations only; return provider/model failures without
  fallback and add a capability field only when orchestration needs it.
- **Arbitrary HTTP URLs can send Source Document content or credentials over an
  insecure or remote connection** -> Display the configured URL and rely on the
  researcher's explicit route selection, as accepted; add no hidden URL rewrite
  or special egress confirmation.
- **Provider summaries can contain sensitive text** -> Bound and normalize the
  ephemeral summary, and expose at most 8 KiB of raw upstream response only in
  the immediate error.
- **Native keyring availability varies, especially on headless Linux** -> Degrade
  only managed-credential operations and keep credentialless and external-auth
  connections usable without a fallback secret store.

## Rollout Plan

`tasks.md` owns the executable sequence. Its work items must be fresh-session,
vertical tracer slices: each slice is independently understandable and
verifiable, leaves the workspace building, and includes the relevant tests and
documentation rather than relying on a later slice to repair it. The rollout
must not expose a researcher-facing path until the configuration it depends on
is durable and its failure behavior is covered. The final cutover must preserve
raw NuExtract behavior, remove `AI_*` model configuration without fallback, and
keep browser tests isolated from real credentials, providers, CLI processes,
and configuration files.

A fresh install begins unconfigured. Reverting the code may leave the JSON and
keyring entries inert; they can be removed manually and are never translated
into environment variables.

## Open Questions

None. The loopback, credential workflow, URL-root, discovery, Interaction
context, streaming-error, temperature, and offline-route contracts are resolved
above.
