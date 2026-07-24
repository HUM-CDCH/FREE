# Self-Inflicted Wound Review — `runtime-model-configuration` (merged)

Merge of six independent reviews (`agy`, `cc`, `codex-sol-high`, `oc-luna-max`,
`oc-sol-max`, `pi-terra-med`). Scope: `design.md`, `proposal.md`, and every
`specs/*/spec.md` in this change.

A *self-inflicted wound* is spec-created complexity that buys no UX or safety and
would dissolve with a design tweak. Findings are ranked by consensus first, then
by the surface (types / transforms / validation paths / scenarios / tests) the
fix deletes. Each finding notes how many of the six reviews raised it.

## Interview decision log

Decisions confirmed so far:

1. **A — Accept:** use one shared `ModelConfig` / `ModelConnection` shape for
   persistence, GET, PUT, and the React draft. Keep server-owned
   credential state and provider descriptors separate.
2. **B — Accept:** persist `nuextractRaw?: true` only on the Extraction Route.
   Keep `profile` solely as an internal resolved-target discriminator.
3. **D — Reject the proposed union:** keep the flat Model Connection shape with
   `provider: ProviderKind` and `baseUrl: string | null`. Enforce the HTTP/CLI
   combination with one centralized validation rule; this is simpler than
   propagating discriminated unions through the provider table, wire contract,
   forms, and probe path.
4. **C — Accept:** store the actual API base expected by each provider/AI SDK
   adapter and append only resource-local paths. Do not require an unversioned
   universal service root.
5. **F — Accept:** represent temperature support consistently as
   `temperatureSupported: boolean` and carry it unchanged into execution
   targets.
6. **G — Accept:** flatten ephemeral probe fields into `ProbeResult`, remove the
   echoed `connectionId`, and represent upstream status only as
   `upstream.status`.
7. **H — Accept:** reuse the complete `ModelConnection` draft in probe requests.
   The probe ignores `name`; no probe-specific connection DTO or frontend
   field-picking is needed.
8. **E — Accept with a narrow UI contract:** expose only
   `supportsNuextractRaw: boolean` as UI-required capability metadata, derived
   from the provider table. Keep JSON-output and temperature capabilities
   backend-only.
9. **I — Accept:** credential actions may target only connections in the
   submitted configuration. Connection absence solely represents removal;
   commit JSON first, then best-effort delete the removed connection's inert
   credential.
10. **J — Accept:** return credential-state entries only for `managed` and
    `optional` providers, with values `present | absent | unavailable`. Map
    absence means FREE does not manage that provider's credential. Remove the
    unused `none` authentication mode and `not_applicable` state.
11. **K — Accept:** every completed connectivity check returns
    `200 ProbeResult`, including negative observations. Reserve non-2xx responses
    for invalid requests, unavailable required keyring access, and unexpected
    server failures.
12. **L — Accept:** `studio-model-operation-contract` solely owns request
    parsing, HTTP envelopes, and pre-stream versus committed-stream error
    behavior. `capability-route-resolution` keeps only route-specific causes and
    no-fallback requirements, with a cross-reference to the owning contract.
13. **Additional decision — no configuration versioning:** use `ModelConfig`
    without a persisted version field. Backward compatibility and configuration
    migration are not requirements; a future incompatible contract may replace
    the current file shape.

All merged-review findings are decided.

---

## A. Duplicate persisted vs. editable configuration types — **6/6**

*Backing: agy #4, cc #1, codex #2, oc-luna #1, oc-sol #1, pi #3*

- **Where:** `design.md:84-98`, `design.md:155-169`; `proposal.md:33-36`;
  `specs/model-connection-configuration/spec.md:26-28`.
- **Pattern:** 1 (redundant representation) + 5 (hand-synced parallel types).
- **Wound:** `StoredModelConfigV1`/`StoredConnection` and `EditableModelConfig`
  now describe the exact same document — the credentialState→sibling-map fix
  removed the last distinguishing field. GET and PUT deliberately round-trip the
  same `config` shape, so two hand-synced type definitions exist for a
  distinction that no longer does. All genuinely server-owned data
  (`credentialStates`, `providers`) already lives outside `config` in
  `ModelConfigState` / `GetModelConfigResponse`.
- **Minimal tweak:** Collapse to one `ModelConfig` + one `ModelConnection` used
  for persistence, GET, PUT, and the React draft; keep credential states and
  provider descriptors as siblings.
- **Deletes:** one type definition; the stored↔editable transform/reconcile
  logic; schema-parity tests; and the
  `model-connection-configuration/spec.md` scenario "Server-owned data is
  submitted → 400" (once `config` carries no server-owned fields, that is just
  an unknown field, already covered by the generic `400 invalid_request` rule).

---

## B. Raw NuExtract has incompatible representations + an impossible 409 — **6/6**

*Backing: agy #1, cc #2, codex #3, oc-luna #3, oc-sol #3, pi #1*

- **Where:** `design.md:176-183`, `design.md:205-209`, `design.md:562-579`;
  `proposal.md:56-57`; `specs/capability-route-resolution/spec.md:47-67`.
- **Pattern:** 1 (redundant representation) + 3 (invalid combination represented
  then rejected) + 5 (hand-synced parallel types).
- **Wound:** The persisted route uses `nuextractRaw?: boolean`, while the
  capability spec and execution target frame the same choice as
  `profile: 'general' | 'nuextract-raw'`. This forces boolean↔profile
  translation, gives `false` and omission two ways to mean "general", and demands
  a `409` "Raw NuExtract is invalid for Interaction" path for a state the wire
  type already makes unrepresentable (`interaction` is `Route | null`, no
  `nuextractRaw` field — a client forcing the field would get `400`, not `409`).
- **Minimal tweak (chosen):** Keep `nuextractRaw?: true` **only** on the
  Extraction Route; reserve `profile` solely as the resolved *internal*
  execution-target discriminator; describe that exact shape everywhere. The one
  check `design.md` retains is `nuextractRaw` on a non-Ollama connection.
  *(agy/pi preferred a discriminated `GeneralRoute`/`ExtractionRoute` union;
  the flag-only shape from cc/codex/oc-luna/oc-sol was adopted as the smaller
  change.)*
- **Deletes:** the false-vs-absent state; profile↔flag conversion vocabulary;
  the impossible Interaction `409` scenario, its validation branch, and its
  tests; the Interaction-profile branch that can never fire. Reword the
  "profile is selected" scenarios and the `model-connection-configuration`
  echo ("with the general profile") to the flag/derived-profile vocabulary.

---

## D. HTTP and CLI connections share an invalid nullable shape — **5/6** (contested)

*Backing: codex #4, oc-luna #2, oc-sol #6, pi #2, cc #3 (dissent)*

- **Where:** `design.md:91-97`, `design.md:186-199`, `design.md:386-394`;
  `specs/model-connection-configuration/spec.md:104-118`.
- **Pattern:** 3 (validation matrix a type could make unrepresentable).
- **Wound:** `{ provider: ProviderKind, baseUrl: string | null }` admits
  HTTP-with-null and CLI-with-URL, so stored config, editable drafts, and probe
  payloads all need transport-dependent semantic checks.
- **Decision — rejected:** Keep the flat `{ provider: ProviderKind, baseUrl:
  string | null }` shape and enforce the HTTP/CLI combination through one
  centralized validation rule. Runtime validation remains necessary at the JSON
  boundary either way, while a discriminated union would propagate provider
  subsets and branching through the provider table, wire contract, forms, and
  probe path. The flat shape is less complicated overall.

---

## C. Unversioned-root contract creates its own invalid URLs — **3/6**

*Backing: agy #2, codex #1, oc-sol #5*

- **Where:** `design.md:186-199`, `design.md:484-509`; `proposal.md:24-30`;
  `specs/model-connection-configuration/spec.md:120-130`.
- **Pattern:** 2 (stored-but-derivable) + 3 (representation-forced validation).
- **Wound:** Storing an unversioned parent root and appending suffixes itself
  makes conventional researcher-pasted roots ending in `/v1`, `/api`, or
  `/v1beta` invalid, forcing a per-provider suffix-rejection matrix.
- **Decision — accepted:** Store the exact base URL expected by each provider's
  AI SDK/adapter and append only resource-local paths (`/models`, `/responses`,
  `/chat/completions`); retain userinfo/query/fragment safety checks. This removes
  the suffix-validation matrix, versioned-root `409`, root-to-SDK-base
  transforms, and path-duplication scenarios while matching conventional URLs
  researchers paste.

---

## F. Temperature support is translated between parallel types — **3/6**

*Backing: agy #6, oc-luna #5, oc-sol #11*

- **Where:** `design.md:327-331`, `design.md:519-529`, `design.md:562-578`;
  `proposal.md:71-74`; `specs/capability-route-resolution/spec.md:90-110`.
- **Pattern:** 5 (hand-synced parallel types).
- **Wound:** The provider table stores `temperature: boolean`; the general
  execution target re-encodes it as `'supported' | 'unsupported'`; the raw target
  carries the constant literal `'supported'` — forcing string↔boolean mapping
  across resolver boundaries.
- **Decision — accepted:** Use `temperatureSupported: boolean` consistently and
  carry it unchanged from the provider table into execution targets. This keeps
  existing responsibility boundaries while deleting the string union,
  boolean-to-string mapping, and representation-parity tests. Unsupported-
  temperature behavior stays.

---

## G. Probe result echoes / duplicates derivable fields — **3/6**

*Backing: agy #7, codex #8, oc-sol #8*

- **Where:** `design.md:98-120`, `design.md:334-345`, `design.md:439-453`;
  `specs/model-connection-configuration/spec.md:151-153`.
- **Pattern:** 2 (stored-but-derivable) + 4 (over-modeled sub-entity).
- **Wound:** `ProbeObservation` exists only nested in `ProbeResult` yet is
  described as persisted (probes are explicitly ephemeral); upstream status
  appears both as `observation.upstreamStatus` and `upstream.status`; the probe
  echoes `connectionId` the requesting closure already supplies.
- **Decision — accepted:** Flatten `checkedAt`/`status`/`message` into the
  ephemeral `ProbeResult`; keep upstream status once as `upstream.status` when an
  HTTP response exists; drop the echoed `connectionId` because the request
  closure already supplies correlation. This deletes one type, nesting/access
  plumbing, request-identity echoing, dual-status reconciliation, and field-
  consistency tests.

---

## H. Probe requests use a stripped parallel connection type — **3/6**

*Backing: codex #2 (partial), oc-luna #4, oc-sol #9*

- **Where:** `design.md:160-169`, `design.md:383-400`;
  `specs/model-connection-configuration/spec.md:193-219`.
- **Pattern:** 1 (redundant representation) + 5 (hand-synced parallel types).
- **Wound:** A draft connection is full-shaped in configuration but manually
  reduced to `{ id, provider, baseUrl }` for probing under strict
  unknown-field rejection — a third connection projection.
- **Decision — accepted:** Reuse the complete `ModelConnection` draft in probe
  requests and ignore `name` during probing. This deletes the probe-only
  DTO/schema, frontend field-picking, and synchronization fixtures/tests. It
  follows directly from A's shared connection shape while retaining D's flat
  representation.

---

## E. Backend-only execution capabilities leaked onto the public descriptor — **2/6**

*Backing: agy #5, codex #7 (related: pi #4)*

- **Where:** `design.md:321-331`, `design.md:477-482`.
- **Pattern:** 1 (duplicated backend representation) + 4 (speculative public
  generality).
- **Wound:** `ProviderDescriptor` serializes internal execution flags
  (`jsonOutput`, `temperature`, `nuextractRaw`) over `GET /api/model_config`,
  though no specified v1 client consumes them.
- **Decision — accepted with a narrow UI contract:** Expose UI metadata, auth
  requirements, the default API base, and
  `supportsNuextractRaw: boolean`. Derive that boolean from the provider table's
  execution-profile metadata. Keep JSON-output and temperature capabilities
  backend-only. This removes the generic `capabilities` wire object and
  frontend parallel execution types without hardcoding Ollama behavior in
  React.

---

## I. Credential deletion has two representations and two orderings — **2/6**

*Backing: codex #5, oc-sol #4*

- **Where:** `design.md:219-235`, `design.md:276-294`;
  `specs/model-connection-configuration/spec.md:64-68`, `:98-102`.
- **Pattern:** 1 (redundant representation).
- **Wound:** Removing a connection implicitly deletes its credential, but old IDs
  may also carry an explicit `null` action, producing contradictory
  pre-commit-must-succeed and post-commit-best-effort paths.
- **Decision — accepted:** Credential actions may target only connections in
  the submitted document. Connection absence solely represents removal. Commit
  the authoritative JSON first, then best-effort delete each removed
  connection's now-inert credential. This deletes old-vs-new action-key
  reconciliation, the redundant deletion path, pre-commit deletion failures,
  and conflicting ordering tests.

---

## J. Credential state materializes derivable / dead entries — **2/6**

*Backing: codex #6, oc-sol #10*

- **Where:** `design.md:237-247`, `design.md:321-331`, `design.md:349-353`,
  `design.md:491-499`; `specs/model-connection-configuration/spec.md:48-56`.
- **Pattern:** 2 (stored-but-derivable) + 4 (parallel representation).
- **Wound:** The credential-state map mirrors every connection and stores
  `not_applicable`, though applicability is fully derivable from the provider
  descriptor. Authentication mode `none` is a dead branch — no v1 provider uses
  it.
- **Decision — accepted:** Limit authentication to
  `managed | optional | external`. Return credential-state entries only for
  managed/optional connections, with values
  `present | absent | unavailable`; map absence means FREE does not manage a
  credential for that provider. Derive external-auth presentation from the
  descriptor. This deletes `not_applicable`, the unused `none` branch,
  exact-cardinality reconciliation, synthesized entries, and their tests.

---

## K. Probe outcomes have two response representations (200 vs 502) — **1/6**

*Backing: oc-sol #2*

- **Where:** `design.md:340-359`, `design.md:396-409`;
  `specs/model-connection-configuration/spec.md:193-195`, `:209-214`.
- **Pattern:** 1 (redundant representation).
- **Wound:** A connected probe returns `ProbeResult` directly; a normal
  non-connected observation returns the same `ProbeResult` nested inside a
  `502 ApiErrorBody.details`.
- **Decision — accepted:** Return `200 ProbeResult` for every completed
  connectivity check, including negative observations. Reserve non-2xx for
  invalid requests, unavailable required keyring access, and unexpected server
  failures. This deletes probe-specific `provider_failure` wrapping, frontend
  success/error unwrapping, the `502` probe scenario, and their tests.

---

## L. Operation error contract is hand-synced across two specs — **1/6**

*Backing: oc-sol #7*

- **Where:** `specs/studio-model-operation-contract/spec.md:25-63`;
  `specs/capability-route-resolution/spec.md:112-154`.
- **Pattern:** 1 + 5.
- **Wound:** Strict request parsing, buffered errors, pre-stream errors,
  committed-stream errors, and frontend termination are specified nearly twice.
- **Decision — accepted:** `studio-model-operation-contract` solely owns strict
  request parsing, HTTP envelopes, and pre-stream versus committed-stream error
  behavior. `capability-route-resolution` retains only route-specific causes and
  no-fallback requirements and cross-references the owning contract. This
  removes duplicate normative requirements and scenarios without changing the
  essential two-phase stream behavior.

---

## Deliberate non-findings

- **Route-map speculative generality** (agy #3, `design.md:542-545`): **rejected
  by 5 of 6 reviews.** The `Routes` type is already a fixed two-field struct
  (`{ extraction, interaction }`); only the "add another capability family later"
  *rationale* is removable prose and deletes no implementation surface. Cut the
  prose if desired; it is not a type-level wound.
- Excluded as essential by consensus: credential redaction / OS-keyring
  isolation, two-phase (pre-stream vs committed-stream) streaming error
  transport, dangling/route-reference validation, immutable snapshot resolution,
  the general/raw execution-target union, and the credential tri-state itself.

---

## Consensus table

| # | Finding | Reviews | Fix decided |
| - | ------- | :-----: | ----------- |
| A | Duplicate config types | 6/6 | one unversioned `ModelConfig`/`ModelConnection` |
| B | Raw NuExtract dual rep + impossible 409 | 6/6 | flag-only `nuextractRaw?: true` on extraction; `profile` internal |
| D | HTTP/CLI nullable shape | 5/6 | **rejected:** keep flat shape + centralized validation |
| C | Unversioned-root URL matrix | 3/6 | **accepted:** store adapter API base, append resource paths |
| F | Temperature boolean↔string | 3/6 | **accepted:** carry `temperatureSupported` boolean through |
| G | Probe echoed/duplicated fields | 3/6 | **accepted:** flatten, drop echo, keep status once |
| H | Stripped probe connection type | 3/6 | **accepted:** reuse complete `ModelConnection` draft |
| E | Leaked backend capabilities | 2/6 | **accepted:** UI-only `supportsNuextractRaw` |
| I | Credential deletion two orderings | 2/6 | **accepted:** submitted-only actions + post-commit cleanup |
| J | Derivable/dead credential states | 2/6 | **accepted:** partial map; drop `not_applicable`/`none` |
| K | Probe 200 vs 502 | 1/6 | **accepted:** completed probes always return `200 ProbeResult` |
| L | Error contract hand-synced | 1/6 | **accepted:** `studio-model-operation-contract` owns it |
| X | Route-map generality | 1/6 (5 reject) | **not a finding** — prose-only |
