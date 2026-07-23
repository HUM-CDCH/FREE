## Why

Studio’s Model Connection page is an in-memory prototype, while model operations
select providers and models independently from environment variables. Humanities
researchers need one durable, machine-wide configuration that represents
available Model Connections truthfully and routes each family of model work
without silent substitution or duplicated provider rules.

## What Changes

- Preserve the Model Connection page’s visual structure and its Single model and
  Capability Route configuration concepts while replacing its local catalogs,
  credential workflow, and fabricated status with backend-owned state and APIs.
- Persist non-secret Model Connections, advisory discovery observations, and
  exactly two Capability Routes in one versioned document in the operating
  system’s user application-config directory.
- Store FREE-managed credentials only in the operating system credential store,
  with no plaintext or memory-only fallback. Report managed credential presence
  separately from external CLI installation and authentication; credentialless
  and externally authenticated connections remain usable without secure storage.
- Support Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and generic
  OpenAI-compatible Model Connections through one backend provider registry
  that owns provider metadata, defaults, credential modes, discovery, model
  construction, and concrete execution capabilities. Every stored HTTP URL is
  an unversioned service root: adapters append Ollama `/api`,
  OpenAI/Anthropic/generic `/v1`, or Google `/v1beta` resources exactly once for
  both discovery and generation. Generic connections thereby guarantee
  `/v1/models` and `/v1/chat/completions` beneath the stored root. Custom Model
  Connections accept any valid researcher-supplied HTTP or HTTPS service root
  without query, fragment, or embedded userinfo;
  native providers retain that provider’s native contract, and the configured
  root is displayed without special remote-egress warnings or confirmation.
- Add whole-document `GET/PUT /api/model_config` and `POST /api/model_probe`.
  Discovery remains advisory, persists observations for offline display, and
  never performs paid test generation. Saving changed connections commits the
  configuration first, then automatically refreshes their observations; probe
  failure is advisory and never rolls back the saved configuration.
- Give Model Connections stable identities, preserve server-owned discovery
  observations during updates, serialize concurrent saves, and reject Capability
  Routes that reference missing Model Connections.
- Make managed credential updates explicit and recoverable. Configuration and
  credential-store changes fail visibly rather than claiming cross-store
  transactional atomicity or silently leaving an indeterminate result.
- Fail closed when the saved configuration is malformed or uses an unsupported
  version, preserving the document unchanged for manual recovery.
- Offer newly selectable models only from discovery, except for Claude Code’s
  documented static aliases. Retain stale catalogs for offline display, but
  allow them to gate new selections only when their non-secret connection
  fingerprint matches the current provider, root, and credential revision. A
  selected model that disappears remains selected, is marked unavailable, and is
  still attempted.
- Resolve each model operation once from an immutable configuration snapshot.
  Extraction and Schema Suggestion use the Extraction Route; document chat and
  conversational Extraction Schema editing use the Interaction Route. Missing
  routes and provider failures fail explicitly without fallback.
- Resolve general execution through registry-declared provider capabilities and
  retain raw Ollama NuExtract as an explicit Extraction Route profile. Both
  Interaction-routed operations use canonical Source Document Markdown when it
  is present; conversational Extraction Schema editing preserves its nullable
  document source and proceeds without Source Document Markdown when it is
  absent.
- Parse client-supplied JSON strictly and confine repair to generated model
  output. Buffered failures and failures detected before a model stream begins
  use one stable FREE error envelope; failures after document-chat stream headers
  are sent use the standard AI SDK UI-message error event with sanitized public
  text.
- Keep runtime configuration and paid model operations within the supported
  Vite/Studio source-prototype deployment using Vite's implicit localhost
  default. Non-loopback exposure is unsupported, not prevented: this change adds
  no explicit host binding or socket-level guard.
- **BREAKING**: Reject an explicitly supplied temperature with HTTP 400
  `unsupported_temperature` when the selected provider does not support it.
  Codex CLI and Claude Code previously accepted the value and silently omitted
  it.
- **BREAKING**: Remove `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`,
  and `AI_API_KEY` as runtime model-configuration inputs; saved configuration
  becomes the sole source.

## Capabilities

### New Capabilities

- `model-connection-configuration`: Machine-wide Model Connection persistence,
  managed-credential and external-auth state, provider metadata and protocol
  boundaries, advisory discovery, configuration/probe APIs, configuration
  request/error behavior, and the Studio configuration workflow.
- `capability-route-resolution`: Explicit Extraction and Interaction Capability
  Routes, per-operation resolution, execution profiles, nullable Interaction
  context, unsupported-temperature validation, pre-stream versus in-stream error
  contracts, and no-fallback behavior.
- `studio-model-operation-contract`: Request, success-response, and failure
  contracts for Studio’s TypeScript `/api/extract`, `/api/generate_schema`,
  `/api/edit_schema`, and `/api/chat` handlers, including the boundary between
  pre-stream HTTP errors and committed AI SDK stream errors.

## Non-goals

- Exposing or retaining public Model Attribution in model-operation responses.
- Changing successful Extraction, Schema Suggestion, document-chat, or
  Extraction Schema-edit response payloads. Buffered and pre-stream error
  responses intentionally move to the stable FREE envelope; committed streams
  retain their standard error event.
- Introducing the future `ParsedDocument.v2` Source Context projection.
- Supporting hosted/Vercel runtime-model configuration or adding a distributable
  local production host.
- Providing fallback routes, models, or configuration sources, including
  compatibility with `AI_*` model settings.
- A wholesale visual redesign of the Model Connection page; replacing its state
  model and workflows is in scope.
- Changing schema-edit tolerance, parseable extraction-mismatch handling, or the
  nullable document-source contract.
- Cancellation propagation, centralized schema-type vocabulary,
  partial-extraction validation issues, and integer-only Evidence pages; these CQ
  follow-ups remain deferred.

## Impact

- Studio frontend Model Connection state and API client code under
  `prototypes/studio/src/`.
- Studio’s local TypeScript/Vite API handlers and model orchestration under
  `prototypes/studio/api/`.
- New local configuration, OS-keyring, provider-registry, discovery, and
  route-resolution boundaries, with platform config-path, keyring, and AI SDK
  provider-adapter dependencies.
- Provider construction for all four model workflows and removal of model
  selection from the environment.
- Vitest coverage for storage, handlers, providers, and route resolution, plus
  Playwright UI workflows with mocked configuration HTTP APIs. Browser tests do
  not exercise real provider servers or model operations.
- Studio README and local setup documentation for saved model configuration;
  unrelated `VITE_*` settings remain supported.
- Local source-prototype operation only; hosted deployment remains outside this
  change.
