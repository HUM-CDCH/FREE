## Why

Studio’s Model Connection page is an in-memory prototype, while model operations
select providers and models independently from environment variables. Humanities
researchers need one durable, machine-wide configuration that represents
available Model Connections truthfully and routes each family of model work
without silent substitution or duplicated provider rules.

## What Changes

- Preserve the Model Connection page’s visual structure and its single-model and
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
  construction, and concrete execution capabilities. Generic connections
  guarantee `/v1/models` and `/v1/chat/completions`. Custom Model Connections
  accept any researcher-supplied HTTP or HTTPS URL; custom URLs for native
  providers retain that provider’s native contract, and the configured URL is
  displayed without special remote-egress warnings or confirmation.
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
  documented static aliases. A selected model that disappears remains selected,
  is marked unavailable, and is still attempted.
- Resolve each model operation once from an immutable configuration snapshot.
  Extraction and Schema Suggestion use the Extraction Route; document chat and
  conversational Extraction Schema editing use the Interaction Route. Missing
  routes and provider failures fail explicitly without fallback.
- Resolve general execution through registry-declared provider capabilities,
  retain raw Ollama NuExtract as an explicit Extraction Route profile, and use
  canonical Source Document Markdown as Interaction Route context.
- Parse client-supplied JSON strictly, confine repair to generated model output,
  and replace endpoint-specific request and provider failure bodies with one
  stable FREE error envelope.
- Keep runtime configuration and paid model operations within the supported
  local-loopback Vite/Studio source-prototype deployment. This change adds no
  explicit host binding or socket-level guard.
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
  Routes, per-operation resolution, execution profiles, Interaction context,
  strict model-operation request parsing, stable runtime errors, and no-fallback
  behavior.

### Modified Capabilities

- `model-call-composition`: Replace the existing buffered model-failure
  `{ detail }` response requirement with the stable FREE error envelope used by
  model operations.

## Non-goals

- Exposing or retaining public Model Attribution in model-operation responses.
- Changing successful Extraction, Schema Suggestion, document-chat, or
  Extraction Schema-edit response payloads; error responses intentionally move
  to the stable FREE error envelope.
- Introducing the future `ParsedDocument.v2` Source Context projection.
- Supporting hosted/Vercel runtime-model configuration or adding a distributable
  local production host.
- Providing fallback routes, models, or configuration sources, including
  compatibility with `AI_*` model settings.
- A wholesale visual redesign of the Model Connection page; replacing its state
  model and workflows is in scope.
- Changing schema-edit tolerance or the nullable document-source contract.
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
  Playwright UI workflows with mocked configuration HTTP APIs.
- Studio README and local setup documentation for saved model configuration;
  unrelated `VITE_*` settings remain supported.
- Local source-prototype operation only; hosted deployment remains outside this
  change.
