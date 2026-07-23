<!-- markdownlint-disable MD013 -->

# Tasks: runtime-model-configuration

Each numbered group is one fresh implementation session. Groups are dependency ordered and must leave Studio tests/build green at their stopping boundary.

## 1. Durable unconfigured state through the configuration API

**Blocking task groups:** None.

**Expected outcome:** A fresh local Studio has one validated v1 machine-wide configuration source, `GET /api/model_config` returns the exact empty/configured wire view without probing, and malformed or unsupported saved state fails closed through the stable error envelope.

**Explicit non-goals:** Keyring mutation, provider discovery, non-null route creation, model execution cutover, and Model Connection UI exposure.

- [ ] 1.1 Add the required Studio dependencies and implement the shared strict wire schemas, `ApiError`/error mapper, bounded validation details, provider kinds, editable/stored/view types, and empty v1 document in cohesive `_http.ts` and `_model_config.ts` seams
- [ ] 1.2 Implement `env-paths('FREE Studio')` config-path resolution, absent-file behavior, complete stored-document validation, byte-preserving fail-closed reads, and flushed sibling-temp atomic replacement with injectable config root/filesystem seams
- [ ] 1.3 Define the ordered seven-provider descriptor table sufficiently for GET metadata and validate provider-specific unversioned HTTP roots without username/password/query/fragment components, retained path prefixes, null CLI roots, at most one connection per CLI kind, UUID identity, duplicate IDs, profile combinations, and dangling routes without consulting `AI_*`
- [ ] 1.4 Add `GET /api/model_config` and strict local Vite routing/error handling; compute route readiness from one snapshot without provider/CLI traffic and degrade keyring-status reads to `credentialState: unavailable`
- [ ] 1.5 Add focused tests for absent, valid, corrupt, unsupported, duplicate-ID, invalid-root, embedded-userinfo, version-suffix, dangling-route, atomic-replacement-failure, descriptor order, readiness precedence, no-probe GET, and ignored `AI_*` environment values
- [ ] 1.6 Run `pnpm --filter studio test -- api/_model_config.test.ts api/_provider.test.ts src/apiEndpoints.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop with GET available only as a read-only, unconfigured/configured contract; do not expose editable UI or runtime routing until saves and credential behavior are durable.

## 2. Whole-document saves with OS-keyring credentials

**Blocking task groups:** 1.

**Expected outcome:** `PUT /api/model_config` serializes complete save workflows, accepts only researcher-editable state plus explicit credential actions, preserves server-owned observations, and reports every cross-store partial outcome without storing or returning a secret.

**Explicit non-goals:** Provider probing, model construction, operation routing, and browser Model Connection workflows.

- [ ] 2.1 Add the narrow `@napi-rs/keyring` adapter using service `FREE Studio` and account `model-connection/<UUID>`, with injectable fakes and no plaintext, environment, process-memory, or file fallback
- [ ] 2.2 Implement strict PUT parsing and semantic validation for unknown/server-owned fields, immutable provider kind per UUID, current-fingerprint route/catalog gating, preserved disappeared selections, credential preserve/replace/delete, automatic credential deletion for removed connections, and managed/optional/none/external auth rules
- [ ] 2.3 Implement the in-process FIFO save queue, sequential idempotent credential mutations before atomic JSON commit, carried-forward catalogs/observations, last-write-wins ordering, and stable failure details containing completed action IDs and `configCommitted`
- [ ] 2.4 Return the exact `PutModelConfigResponse` view while leaving changed-connection `probes` empty behind a temporary internal test seam that cannot contact providers; this is not the final wire behavior and must not be consumed by the UI until group 3 completes automatic probing
- [ ] 2.5 Test credential service/account naming, tri-state actions, redaction, required deletion, unavailable-keyring GET degradation, required-keyring PUT failure, mutation order, retries, old/new provider identity, server-owned-field rejection, stale catalog/fingerprint handling after URL or credential changes, concurrent saves, first-JSON-commit failure without credential rollback, and each pre/post-JSON partial state
- [ ] 2.6 Run `pnpm --filter studio test -- api/_model_config.test.ts src/apiEndpoints.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop once durable edits and credentials are independently recoverable and fully tested; do not claim transactional rollback and do not wire a researcher-facing Save before post-commit probing exists.

## 3. Advisory discovery across all seven provider contracts

**Blocking task groups:** 2.

**Expected outcome:** Changed saves commit then probe, explicit saved-connection probes are available, catalogs and bounded observations survive offline failures, and stale results cannot overwrite newer connection state.

**Explicit non-goals:** Paid/test generation, model suitability inference, execution-time catalog gating, UI workflows, and operation routing.

- [ ] 3.1 Complete the single typed provider table with auth metadata, capability declarations, default roots, path-prefix-preserving resource joins, discovery adapters, CLI installation/auth checks, and credential-aware probe inputs for Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and OpenAI-compatible
- [ ] 3.2 Implement provider-specific model-list parsing, Claude Code’s exact static aliases, 15-second wall-clock deadlines, 1 MiB response and 10,000-model limits, 512-code-point field/observation bounds, exact probe statuses, 8 KiB immediate upstream detail, and explicit proof that discovery never generates content
- [ ] 3.3 Add server-owned per-connection catalog/probe fingerprints with credential revisions and monotonically allocated probe generations; apply completion only when the captured fingerprint/revision/generation remains current and report `applied`, `superseded`, `connection_changed`, or `connection_deleted`
- [ ] 3.4 Finish PUT’s post-commit concurrent probing of changed connections in submitted order, preserving failed connections’ last successful catalogs and returning advisory failures as HTTP 200; report an observation-write failure with `configCommitted: true`
- [ ] 3.5 Add strict `POST /api/model_probe` for saved connections only, persist applied success/failure observations, and map connectivity/auth/CLI/timeout/shape/discovery failures to `502 provider_failure` with the exact safe `ProbeResult`
- [ ] 3.6 Table-test all seven providers, exact native/versioned discovery URLs, retained URL prefixes, auth headers without leakage, OpenAI versus OpenAI-compatible discovery boundaries, static aliases, catalog retention and fingerprint gating after URL/credential changes, size/count/time limits, stale overlap cases, changed-save probe ordering, and no-generation behavior
- [ ] 3.7 Run `pnpm --filter studio test -- api/_model_config.test.ts api/_provider.test.ts api/model_config.test.ts api/model_probe.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop with GET/PUT/probe wire contracts complete and deterministic through fake HTTP/CLI/keyring/config seams; no test may touch the researcher’s real config directory, keyring, provider network, or CLI process.

## 4. Backend-owned Model Connection and Capability Route workflow

**Blocking task groups:** 3.

**Expected outcome:** The existing Model Connection page preserves Single model and Capability Routes views while loading, editing, saving, probing, and rendering only backend-owned configuration, credential state, catalogs, observations, and readiness.

**Explicit non-goals:** A visual redesign, frontend provider registry, free-form undiscovered model selection, runtime model-operation cutover, remote-egress warnings, and browser access to real credentials/providers/config files.

- [ ] 4.1 Replace `providerConfig.data.ts`’s fabricated catalogs/connections/routes with exact API types, strict response/error decoding, and small view helpers; add frontend clients for GET, whole-document PUT, and saved-connection POST probe
- [ ] 4.2 Refactor `ProviderConfigPage` to load backend state, preserve the current page structure, create stable UUIDs, show all provider descriptors and configured service roots, and render loading, corrupt-config, keyring-unavailable, offline, and unavailable-selected-model states without substitution
- [ ] 4.3 Implement explicit Save for connection edits and credential preserve/replace/delete actions, consume post-commit probe results, support manual refresh, retain offline connections/catalogs, and never repopulate or display a credential value
- [ ] 4.4 Implement Single model mode as one discovered general target assigned to both routes and Capability Routes mode as independent Extraction/Interaction targets, including Ollama-only `nuextract-raw`, catalog-gated new selections, preserved unavailable selections, and server-returned readiness
- [ ] 4.5 Add React tests with mocked fetch for load, Save/reload, post-commit and manual probe results, credential tri-state, keyring failure, corrupt configuration, offline save, route/profile gating, dangling-route deletion errors, mixed routes, stable errors, and unavailable-model display
- [ ] 4.6 Add Playwright setup and mocked-HTTP workflows for Single model and mixed routes, Save/reload, refresh, offline save, route gating, credential-state display, and errors, proving no browser test reaches real config, keyring, provider, CLI boundaries, or model-operation endpoints
- [ ] 4.7 Run `pnpm --filter studio test -- src/providerConfig/ProviderConfigPage.test.tsx src/api.test.ts` plus the targeted mocked Playwright project and `pnpm --filter studio build`

**Stopping boundary:** Stop with configuration UX fully verifiable but model operations still on their pre-cutover path; do not partially route only some operations through saved state.

## 5. One saved-route resolver and provider execution target

**Blocking task groups:** 3 and 4.

**Expected outcome:** One resolver maps each operation exactly once to the saved route’s immutable connection/model/profile/credential and constructs either a direct AI SDK v7 model or explicit raw NuExtract target with no fallback.

**Explicit non-goals:** Changing handler success payloads, changing raw NuExtract prompt/transport, adding a universal generation wrapper, caching models, per-project routes, fallback targets, or public Model Attribution.

- [ ] 5.1 Complete credential-aware general model factories in the provider table for all seven kinds, retaining isolated tool-disabled Codex and Claude Code settings and asserting native OpenAI Responses versus OpenAI-compatible Chat Completions construction and exact resource roots
- [ ] 5.2 Implement `resolveCapabilityRoute()` over one validated immutable snapshot with the fixed extraction/schema-suggestion and interaction/chat/schema-edit mappings, exact selected IDs, only the selected credential, profile validation, advisory-only catalogs/probes, and no provider/model/default/environment substitution
- [ ] 5.3 Return direct `LanguageModel` capability metadata for general targets and the exact Ollama root/model/authorization/temperature support for `nuextract-raw`; reject explicit temperature before invocation for Codex CLI and Claude Code with `400 unsupported_temperature`
- [ ] 5.4 Add table tests for all operation mappings, seven factories, missing/null/dangling routes, disappeared selected models still attempted, invalid profiles, managed/optional/external credentials, resolution during an in-progress Save without waiting, mixed local/remote routes, unsupported/supported temperature, exact IDs/URLs, one resolver call, ignored `AI_*`, and no fallback
- [ ] 5.5 Run `pnpm --filter studio test -- api/_provider.test.ts api/_model_config.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop at a tested resolver/factory seam; do not alter the four public operation handlers until all can cut over together while preserving their success contracts.

## 6. Atomic cutover of all four model operations and error protocols

**Blocking task groups:** 5.

**Expected outcome:** Extraction, Schema Suggestion, document chat, and conversational Extraction Schema editing all use saved routes; buffered/pre-stream failures share one safe envelope, committed chat failures use the AI SDK error part, and successful payloads remain unchanged.

**Explicit non-goals:** Retrying or repairing client JSON, fallback routing, changing extraction/schema/edit success shapes, streaming buffered operations, changing model-output tolerance, adding cancellation propagation, or introducing `ParsedDocument.v2` Source Context.

- [ ] 6.1 Refactor `_model.ts` so each operation receives its one resolved execution target, general operations use AI SDK v7 directly according to `jsonOutput`, and only the explicit Ollama Extraction `nuextract-raw` profile uses the specialized raw transport
- [ ] 6.2 Preserve golden raw NuExtract prompts for structured/content/template-generation/markdown modes and exact `/api/generate` fields (`raw: true`, `stream: false`, images, selected model/root/auth, and default 0.2 temperature) without model-name inference or `chat_template_kwargs`
- [ ] 6.3 Pass canonical Source Document Markdown to document chat; extend schema-edit request/context so nullable Markdown is included when present and omitted without a synthetic placeholder when null
- [ ] 6.4 Make extract/generate-schema/edit-schema and pre-stream chat parsing strict, replace route-specific `{ error }`, `{ detail }`, `RequestError`, and client-input repair with the stable bounded `ApiErrorBody`, and preserve existing single-JSON 200 success contracts
- [ ] 6.5 Use AI SDK v7 `toUIMessageStream` with `createUIMessageStreamResponse`; sanitize committed provider failures into standard `{ type: 'error', errorText }` parts while preserving status, and update Studio consumption to terminate and fail on in-stream errors
- [ ] 6.6 Add handler/orchestrator/frontend regressions for strict malformed inputs, every status class, bounded immediate raw upstream detail, sanitized 512-code-point committed-stream errors, pre-stream versus committed-stream failure, all operation-route mappings, both Interaction context cases, explicit temperature, generated-output failures, deferred output-tolerance behavior, buffered success payloads, and absence of fallback or `AI_*` reads
- [ ] 6.7 Run `pnpm --filter studio test -- api/_model.test.ts api/_provider.test.ts src/apiEndpoints.test.ts src/api.test.ts` and `pnpm --filter studio build`

**Stopping boundary:** Stop only when all four operations have crossed the saved-configuration boundary together and raw NuExtract golden behavior plus public success contracts remain green.

## 7. Remove obsolete configuration paths and document the supported local workflow

**Blocking task groups:** 6.

**Expected outcome:** Saved model configuration is the sole surviving runtime source, obsolete catalogs and browser plaintext credentials are gone, environment routing is not duplicated, and current documentation describes only the supported local Vite/Studio configuration workflow.

**Explicit non-goals:** Migrating legacy environment values, deleting inert user config/keyring entries on rollback, enforcing loopback at the socket/Host/Origin layer, supporting hosted/Vercel deployment, or adding authenticated remote hosting.

- [ ] 7.1 Delete obsolete static provider/model catalogs, fabricated initial connections/statuses, plaintext browser `apiKey` state/fields/placeholders, and any compatibility adapters retained only for the prototype configuration path
- [ ] 7.2 Delete duplicated environment/provider/model/base-URL/API-key routing and its tests from `_model.ts`, `_provider.ts`, Vite environment loading where no longer needed, and all model-operation code; add a repository assertion that production Studio code contains no reads of `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, or `AI_API_KEY`
- [ ] 7.3 Remove stale `AI_*` setup documentation and update the Studio README plus relevant runtime-model ADR/documentation to describe fresh unconfigured startup, saved Model Connections/Capability Routes, OS-keyring behavior and safe retry, advisory discovery, implicit-localhost-only support, and no hosted/remote guarantee
- [ ] 7.4 Run focused Studio tests, the mocked browser workflows, `pnpm --filter studio lint`, `pnpm --filter studio test`, `pnpm --filter studio build`, `git diff --check`, and diagnostics for every edited source file
- [ ] 7.5 Confirm repository searches find no obsolete static catalogs, plaintext browser credential state, duplicated environment routing, or stale instructional `AI_*` documentation outside historical interview/change artifacts

**Stopping boundary:** Stop with cleanup and verification complete; do not archive the change or broaden scope into unrelated deployment, parsing, Evidence, schema vocabulary, cancellation, or output-tolerance work.
