<!-- markdownlint-disable MD013 -->

# Tasks: runtime-model-configuration

Each numbered group is one fresh implementation session. Groups are dependency ordered and must leave Studio tests/build green at their stopping boundary.

## 1. Durable unconfigured state through the configuration API

**Blocking task groups:** None.

**Expected outcome:** A fresh local Studio has one validated machine-wide configuration source, `GET /api/model_config` returns the exact empty/configured wire view without probing, and malformed saved state fails closed through the stable error envelope.

**Explicit non-goals:** Keyring mutation, provider discovery, non-null route creation, model execution cutover, and Model Connection UI exposure.

- [x] 1.1 Add the required Studio dependencies and implement the shared strict wire schemas, `ApiError`/error mapper, bounded validation details, provider kinds, one shared round-trippable configuration shape, response metadata, and empty configuration document in cohesive `_http.ts` and `_model_config.ts` seams
- [x] 1.2 Implement `env-paths('FREE Studio')` config-path resolution, absent-file behavior, complete stored-document validation, byte-preserving fail-closed reads, and flushed sibling-temp atomic replacement with injectable config root/filesystem seams
- [x] 1.3 Define the ordered seven-provider descriptor table sufficiently for GET metadata and validate provider API bases without username/password/query/fragment components, retained path prefixes, null CLI bases, at most one connection per CLI kind, UUID identity, duplicate IDs, raw-flag combinations, and dangling routes without consulting `AI_*`
- [x] 1.4 Add `GET /api/model_config` and strict local Vite routing/error handling; return static provider descriptors and a UUID-keyed credential-state map, degrading keyring-status reads to `unavailable`
- [x] 1.5 Add focused tests for absent, valid, corrupt, duplicate-ID, invalid-root, embedded-userinfo, supplied-version-base, dangling-route, atomic-replacement-failure, descriptor order, no-probe GET, and ignored `AI_*` environment values
- [x] 1.6 Run `pnpm --filter studio test -- api/_model_config.test.ts api/_provider.test.ts src/apiEndpoints.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop with GET available only as a read-only, unconfigured/configured contract; do not expose editable UI or runtime routing until saves and credential behavior are durable.

## 2. Whole-document saves with OS-keyring credentials

**Blocking task groups:** 1.

**Expected outcome:** `PUT /api/model_config` accepts one complete editable draft plus write-only credential changes, atomically replaces JSON, and never stores or returns a plaintext secret.

**Explicit non-goals:** Provider probing, model construction, operation routing, and browser Model Connection workflows.

- [x] 2.1 Add the narrow `@napi-rs/keyring` adapter using service `FREE Studio` and account `model-connection/<UUID>`, with injectable fakes and no plaintext, environment, process-memory, or file fallback
- [x] 2.2 Implement strict PUT parsing and semantic validation for unknown fields, immutable provider kind per UUID, explicit model IDs, credential preserve/replace/delete, best-effort credential cleanup for removed connections, and managed/optional/external auth rules and partial credential-state maps
- [x] 2.3 Apply explicit credential changes, atomically commit JSON state, best-effort clean credentials for removed connections, and return normalized `config` plus UUID-keyed credential states without provider descriptors, rollback, or action-journal machinery
- [x] 2.4 Test configuration round-tripping without transforms, credential service/account naming, tri-state actions, redaction, unavailable-keyring GET degradation, required-keyring PUT failure, old/new provider identity, arbitrary model IDs, URL normalization, atomic JSON failure, and inert orphan cleanup
- [x] 2.5 Run `pnpm --filter studio test -- api/_model_config.test.ts src/apiEndpoints.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop once durable edits and write-only credentials are tested; do not claim transactional rollback or expose a researcher-facing Apply before probing is available.

## 3. Explicit ephemeral discovery across all seven provider contracts

**Blocking task groups:** 2.

**Expected outcome:** A side-effect-free probe of valid draft connection details reports current usability and a bounded catalog without changing configuration or credentials.

**Explicit non-goals:** Paid/test generation, model suitability inference, execution-time catalog gating, UI workflows, and operation routing.

- [x] 3.1 Complete the single typed provider table with auth metadata, capability declarations, default API bases, path-prefix-preserving resource joins, discovery adapters, CLI installation/auth checks, and credential-aware probe inputs for Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and OpenAI-compatible
- [x] 3.2 Implement provider-specific model-list parsing, Claude Code’s exact static aliases, 15-second wall-clock deadlines, 1 MiB response and 10,000-model limits, 512-code-point field/observation bounds, exact probe statuses, 8 KiB immediate upstream detail, and explicit proof that discovery never generates content
- [x] 3.3 Add strict, side-effect-free `POST /api/model_probe` for draft connection details with write-only credential preserve/override/none semantics, and return connectivity/auth/CLI/timeout/shape/discovery failures as completed `200 ProbeResult` observations
- [x] 3.4 Table-test all seven providers, exact native discovery URLs from each stored API base, retained URL prefixes, auth headers without leakage, OpenAI versus OpenAI-compatible discovery boundaries, static aliases, size/count/time limits, concurrent probes, no configuration writes, and no-generation behavior
- [x] 3.5 Run `pnpm --filter studio test -- api/_model_config.test.ts api/_provider.test.ts api/model_config.test.ts api/model_probe.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop with GET/PUT/probe wire contracts complete and deterministic through fake HTTP/CLI/keyring/config seams; probes are ephemeral and side-effect-free, and no test may touch the researcher’s real config directory, keyring, provider network, or CLI process.

## 4. Backend-owned Model Connection and Capability Route workflow

**Blocking task groups:** 3.

**Expected outcome:** The existing Model Connection page preserves Single model and Capability Routes views while loading, editing, saving, accepting manual model IDs, and seamlessly showing current-session connection checks beside valid drafts.

**Explicit non-goals:** A visual redesign, frontend provider registry, runtime model-operation cutover, remote-egress warnings, and browser access to real credentials/providers/config files.

- [x] 4.1 Replace `providerConfig.data.ts`’s fabricated catalogs/connections/routes with exact round-trippable configuration and response metadata types, strict response/error decoding, and small view helpers; add frontend clients for GET, whole-document PUT, and draft-connection POST probe
- [x] 4.2 Refactor `ProviderConfigPage` to load backend state, preserve the current page structure, create stable UUIDs, show all provider descriptors and configured API bases, and render loading, corrupt-config, keyring-unavailable, and inline draft probe states without substitution
- [x] 4.3 Keep one draft in `ProviderConfigPage` using the shared configuration shape, disable Apply while pending, send that configuration unchanged with write-only credential changes once, replace the draft directly with the normalized response `config`, retain it on error, ensure Apply itself starts no probe, and never repopulate or display a credential value
- [x] 4.4 Probe a structurally valid connection after 500 ms of settled provider/API-base/credential input, abort and ignore superseded attempts, show checking/connected/failure inline, retain Refresh models, and never probe merely because the panel opened or a name/model ID changed
- [x] 4.5 Implement Single model mode as one explicit model assigned to both routes without the raw flag and Capability Routes mode as independent Extraction/Interaction targets, including Ollama-only `nuextractRaw?: true` on Extraction, manual model IDs, and optional selection from the latest probe result
- [ ] 4.6 Add React tests with mocked fetch for load, Apply/reload, pending Apply, retained draft on failure, debounce, cancellation, stale response suppression, transient credential redaction, inline probe states, manual retry, no panel-open or Apply probe, manual IDs, credential tri-state and partial credential-state display, keyring failure, corrupt configuration, offline save, route/raw-flag gating, mixed routes, and stable errors
- [ ] 4.7 Add Playwright setup and mocked-HTTP workflows for Single model and mixed routes, Apply/reload, seamless draft checking, manual refresh, manual IDs, offline save, credential-state display, and errors, proving no browser test reaches real config, keyring, provider, CLI boundaries, or model-operation endpoints
- [ ] 4.8 Run `pnpm --filter studio test -- src/providerConfig/ProviderConfigPage.test.tsx src/api.test.ts` plus the targeted mocked Playwright project and `pnpm --filter studio build`

**Stopping boundary:** Stop with configuration UX fully verifiable but model operations still on their pre-cutover path; do not partially route only some operations through saved state.

## 5. One saved-route resolver and provider execution target

**Blocking task groups:** 3 and 4.

**Expected outcome:** One resolver maps each operation exactly once from the saved route’s immutable connection/model/raw choice and credential to either a direct AI SDK v7 model or explicit raw NuExtract target with no fallback.

**Explicit non-goals:** Changing handler success payloads, changing raw NuExtract prompt/transport, adding a universal generation wrapper, caching models, per-project routes, fallback targets, or public Model Attribution.

- [x] 5.1 Complete credential-aware general model factories in the provider table for all seven kinds, retaining isolated tool-disabled Codex and Claude Code settings and asserting native OpenAI Responses versus OpenAI-compatible Chat Completions construction and exact resource roots
- [x] 5.2 Implement `resolveCapabilityRoute()` over one validated immutable snapshot with the fixed extraction/schema-suggestion and interaction/chat/schema-edit mappings, exact selected IDs, only the selected credential, raw-flag validation and internal target derivation, no discovery dependency, and no provider/model/default/environment substitution
- [x] 5.3 Return direct `LanguageModel` capability metadata for general targets and the exact Ollama API-base/model/authorization/temperatureSupported value for `nuextract-raw`; reject explicit temperature before invocation for Codex CLI and Claude Code with `400 unsupported_temperature`
- [x] 5.4 Add table tests for all operation mappings, seven factories, missing/null/dangling routes, arbitrary selected model IDs, raw-flag restrictions, managed/optional/external credentials, mixed local/remote routes, unsupported/supported temperature, exact IDs/URLs, one resolver call, ignored `AI_*`, and no fallback
- [x] 5.5 Run `pnpm --filter studio test -- api/_provider.test.ts api/_model_config.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop at a tested resolver/factory seam; do not alter the four public operation handlers until all can cut over together while preserving their success contracts.

## 6. Atomic cutover of all four model operations and error protocols

**Blocking task groups:** 5.

**Expected outcome:** Extraction, Schema Suggestion, document chat, and conversational Extraction Schema editing all use saved routes; buffered/pre-stream failures share one safe envelope, committed chat failures use the AI SDK error part, and successful payloads remain unchanged.

**Explicit non-goals:** Retrying or repairing client JSON, fallback routing, changing extraction/schema/edit success shapes, streaming buffered operations, changing model-output tolerance, adding cancellation propagation, or introducing `ParsedDocument.v2` Source Context.

- [x] 6.1 Refactor `_model.ts` so each operation receives its one resolved execution target, general operations use AI SDK v7 directly according to `jsonOutput`, and only the internally resolved Ollama Extraction `nuextract-raw` target uses the specialized raw transport
- [x] 6.2 Preserve golden raw NuExtract prompts for structured/content/template-generation/markdown modes and exact `/api/generate` fields (`raw: true`, `stream: false`, images, selected model/API-base/auth, and default 0.2 temperature) without model-name inference or `chat_template_kwargs`
- [x] 6.3 Pass canonical Source Document Markdown to document chat; extend schema-edit request/context so nullable Markdown is included when present and omitted without a synthetic placeholder when null
- [x] 6.4 Make extract/generate-schema/edit-schema and pre-stream chat parsing strict, replace route-specific `{ error }`, `{ detail }`, `RequestError`, and client-input repair with the stable bounded `ApiErrorBody`, and preserve existing single-JSON 200 success contracts
- [x] 6.5 Use AI SDK v7 `toUIMessageStream` with `createUIMessageStreamResponse`; sanitize committed provider failures into standard `{ type: 'error', errorText }` parts while preserving status, and update Studio consumption to terminate and fail on in-stream errors
- [x] 6.6 Add handler/orchestrator/frontend regressions for strict malformed inputs, every status class, bounded immediate raw upstream detail, sanitized 512-code-point committed-stream errors, pre-stream versus committed-stream failure, all operation-route mappings, both Interaction context cases, explicit temperature, generated-output failures, deferred output-tolerance behavior, buffered success payloads, and absence of fallback or `AI_*` reads
- [x] 6.7 Run `pnpm --filter studio test -- api/_model.test.ts api/_provider.test.ts src/apiEndpoints.test.ts src/api.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop only when all four operations have crossed the saved-configuration boundary together and raw NuExtract golden behavior plus public success contracts remain green.

## 7. Remove obsolete configuration paths and document the supported local workflow

**Blocking task groups:** 6.

**Expected outcome:** Saved model configuration is the sole surviving runtime source, obsolete catalogs and browser plaintext credentials are gone, environment routing is not duplicated, and current documentation describes only the supported local Vite/Studio configuration workflow.

**Explicit non-goals:** Migrating legacy environment values, deleting inert user config/keyring entries on rollback, enforcing loopback at the socket/Host/Origin layer, supporting hosted/Vercel deployment, or adding authenticated remote hosting.

- [x] 7.1 Delete obsolete static provider/model catalogs, fabricated initial connections/statuses, plaintext browser `apiKey` state/fields/placeholders, and any compatibility adapters retained only for the prototype configuration path
- [x] 7.2 Delete duplicated environment/provider/model/base-URL/API-key routing and its tests from `_model.ts`, `_provider.ts`, Vite environment loading where no longer needed, and all model-operation code; add a repository assertion that production Studio code contains no reads of `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, or `AI_API_KEY`
- [x] 7.3 Remove stale `AI_*` setup documentation and update the Studio README plus relevant runtime-model ADR/documentation to describe fresh unconfigured startup, saved Model Connections/Capability Routes, the one-draft Apply workflow, OS-keyring behavior, explicit ephemeral discovery, implicit-localhost-only support, and no hosted/remote guarantee
- [ ] 7.4 Run focused Studio tests, the mocked browser workflows, `pnpm --filter studio lint`, `pnpm --filter studio test`, `pnpm --filter studio build`, `git diff --check`, and diagnostics for every edited source file
- [x] 7.5 Confirm repository searches find no obsolete static catalogs, plaintext browser credential state, duplicated environment routing, or stale instructional `AI_*` documentation outside historical interview/change artifacts

**Stopping boundary:** Stop with cleanup and verification complete; do not archive the change or broaden scope into unrelated deployment, parsing, Evidence, schema vocabulary, cancellation, or output-tolerance work.
