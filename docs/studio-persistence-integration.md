# Studio Persistence Integration — Final Plan

## Summary

Integrate PostgreSQL through the existing `ProjectStore` seam in five independently testable increments. Browser code uses same-origin `/api`; thin handlers call server-only use-case functions, which use `ProjectStore` directly.

Every Extraction Result is interpreted using the exact immutable Source Representation Revision and Schema Revision that produced it. Current heads are conveniences for new work, never substitutes for historical inputs.

## Identity, Heads, and Selection

- `SourceDocumentId` identifies a Project Context-owned Source Document.
- `SourceRepresentationRevisionId` identifies one immutable preprocessing result.
- PDF SHA-256 is integrity and deduplication metadata only.
- Each Source Representation Revision stores an opaque immutable artifact-bundle reference resolving its exact PDF, Markdown, parsed metadata, and hashes.
- The active Source Representation Revision is the persisted `ProjectStore` head: the greatest owner-scoped representation revision number. One server use case resolves it; handlers and React never infer it independently.
- Current Annotations are the greatest Annotation Set revision number pinned to the active representation.
- Current Schema is the greatest revision number of the selected Extraction Schema.
- The current Research Prompt, if created by the workflow, is the greatest Prompt Revision number of that Extraction Schema. Initial suggestions may omit it.
- Project, Source Document, Extraction Schema, and Extraction selections live in URL state, not the database.
- The Studio URL and `GET /api/reopen` use the same optional query parameters:
  `projectContextId`, `sourceDocumentId`, `extractionSchemaId`, and
  `extractionId`. Each supplied identity is a canonical lowercase UUID.
- Missing selections default to newest `createdAt`, then greatest ID, and the resolved IDs replace the URL.
- Explicit selections never silently fall back:
  - Malformed ID: `400 invalid_identity`.
  - Unknown ID: `404 selection_not_found`.
  - Wrong ownership or containment: `409 selection_mismatch`.
- Validate all identity syntax first, then Project Context existence, Source
  Document existence and ownership, Extraction Schema existence and ownership,
  and finally Extraction existence plus its pinned Schema Revision and Source
  Representation Revision containment.
- Default Extraction selection includes only Extractions pinned to both the active representation and selected Schema head.
- Explicitly selected historical Extractions load their pinned representation and Schema Revision and are marked historical whenever either differs from the current heads.
- Historical Extraction reopening composes `getExtraction`, `getSourceRepresentation`, and `getSchemaRevision`; do not add a parallel aggregate store read.

## Increment 1 — Persisted Navigation and Reopening

- Add `@free/db` as a server-only Studio dependency.
- Cache the `ProjectStoreHandle` initialization promise using a development-global singleton. Reset a rejected promise so Studio can recover when PostgreSQL becomes available.
- Add shared HTTP DTOs containing opaque IDs, revision numbers, timestamps, payloads, and stable error codes. Browser loading and autosave state remain client-only.
- Replace hardcoded navigation with persisted Project Context and Source Document summaries.
- Add URL-driven selection and a bounded reopen DTO containing:
  - A `selection` object with nullable Project Context, Source Document,
    Extraction Schema, and Extraction identities.
  - Every Project Context summary, containing only identity, name, and creation
    timestamp.
  - Source Document and Extraction Schema summaries only for the selected
    Project Context.
  - Active representation.
  - Its current Annotation snapshot.
  - Selected Schema and optional Prompt heads.
  - Compatible Extraction summaries only for the active representation and
    selected Schema head.
  - Selected Extraction with its pinned representation and Schema Revision.
- Empty and partially populated states return `200`, empty lists, and explicit
  `null` selections and optional fields. Serialize timestamps as RFC 3339 UTC.
- After a successful reopen, use `history.replaceState` once with every resolved
  identity; include `extractionId` only when one exists. Do not rewrite a URL
  whose explicit selection failed validation.
- The selected Extraction excludes raw model output and includes its identity,
  timestamp, outcome, sanitized failure or Extraction Result, Model Attribution,
  pinned inputs, one server-computed `historical` boolean, and a deduplicated
  `evidenceAnchors` projection containing only anchors referenced by the result.
  Each projected anchor contains its identity, exact text or table-cell content,
  page, and available geometry, ordered by its canonical source position. It is
  historical when either pinned input differs from its current head. An
  explicitly selected historical Extraction remains outside the compatible
  summary list.
- Narrowly extend `ProjectStore` to:
  - Read a representation by identity, returning its Source Document identity, revision number, creation timestamp, and server-only artifact descriptor; omit sibling history and derived current-state flags.
  - Read a Schema Revision by identity, returning its Extraction Schema identity, revision number, creation timestamp, origin, Schema tree, and optional Model Attribution.
  - List every Extraction pinned to an exact Source Representation Revision and Schema Revision pair, ordered by `createdAt DESC, id DESC`, returning only Extraction identity, creation timestamp, and attempt outcome.
  - Include `createdAt` in Project Context, Source Document, Extraction Schema, and Extraction summaries, ordered by `createdAt DESC, id DESC`.
  - Read the Annotation head by Source Document and Source Representation Revision identity; `getSourceDocument` does not return a representation-agnostic Annotation head.
- Do not load complete immutable histories until Studio exposes history browsing.

## Increment 2 — Ingestion and Artifact Retrieval

- The upload flow selects an existing Project Context or enters a new Project Context name.
- Execute ingestion without holding a database transaction across Parsing Service work:
  1. Validate the upload and target.
  2. Submit the PDF to the Parsing Service.
  3. Await immutable artifact-bundle metadata.
  4. In one transaction, either:
     - Create a new Project Context with its first Source Document and initial representation; or
     - Create a new Source Document with its initial representation in the selected Project Context.
  5. Return the persisted DTO.
- Parsing failure creates no database records. Database failure may leave an unreferenced content-addressed bundle; cleanup is deferred.
- The Parsing Service publishes one immutable artifact bundle per successful
  preprocessing generation. A cache hit reuses the existing bundle; another
  generation receives another reference even when the PDF bytes are identical.
- Bundle references are opaque UUIDs. The completed task state contains one fixed
  descriptor with `bundleReference` and `pdf`, `markdown`, and `metadata`
  entries. Each entry contains `sha256`, `byteLength`, and `mediaType`.
- `POST /tasks` continues to return `202` with the task identity. Studio waits on
  `GET /tasks/{taskId}/events` (`text/event-stream`) rather than polling:
  - A connection immediately emits the current `pending`, `running`, `completed`,
    or `failed` state, then emits only state changes.
  - `completed` includes the bundle descriptor; `failed` includes only the
    existing sanitized task error code.
  - The stream sends an SSE comment heartbeat every 15 seconds and closes after
    a terminal event.
  - Reconnection is snapshot-based. There is no event log or `Last-Event-ID`
    replay contract.
  - `GET /tasks/{taskId}` remains available for diagnostics and the Parsing
    Service control page, but Studio does not poll it.
- The Parsing Service resolves bundle artifacts through
  `GET|HEAD /artifact-bundles/{bundleReference}/{artifact}`, where `artifact` is
  exactly `pdf`, `markdown`, or `metadata`. Malformed and unknown references both
  return `404 artifact_bundle_not_found`; a known bundle whose selected artifact
  is missing, unreadable, the wrong recorded length, or otherwise unavailable
  returns `503 artifact_unavailable`.
- Publication verifies each artifact digest and records its byte length.
  Resolution verifies existence and byte length but does not re-hash the complete
  artifact on every request. Each strong `ETag` is the quoted recorded SHA-256.
- Browser routes use representation identity:
  - `/api/source-representations/{id}/pdf`
  - `/api/source-representations/{id}/markdown`
  - `/api/source-representations/{id}/metadata`
- Studio resolves artifact references server-side. The browser never supplies hashes or paths.
- Parsing Service and Studio artifact routes support `GET` and `HEAD`; `HEAD`
  returns the same headers as `GET` without a body. Only PDF supports byte ranges.
  PDF returns `200`, `206`, `304`, or `416`; Markdown and metadata return `200`
  or `304`.
- Successful artifact responses use
  `Cache-Control: private, max-age=31536000, immutable`. Studio forwards only
  `Range`, `If-Range`, and `If-None-Match` upstream, and only `Content-Type`,
  `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`, and
  `Cache-Control` downstream.
- Studio maps a persisted representation whose bundle or selected artifact
  cannot be resolved to `503 source_artifact_unavailable`, without exposing the
  upstream distinction or reference. The metadata artifact remains the complete
  internal canonical parsed representation; the browser route maps it to an
  explicit allow-listed DTO that excludes artifact references, storage paths,
  hashes, and parser diagnostics.
- Reprocessing an existing Source Document is not exposed in this UI slice. Store-level fixtures verify multiple representations; the upload UI may create two different Source Documents from identical PDF bytes.

## Increment 3 — Annotation Autosave

- Maintain coordinator state per record key:
  - Loaded head.
  - Last acknowledged canonical value.
  - Current draft.
  - In-flight request.
  - Latest queued draft.
  - Save/error/conflict state.
- Canonicalize before comparison; identical snapshots create no revisions.
- Use a 1.5-second idle debounce. Immediate flush occurs when focus leaves the overall Annotation editor, before navigation, and before Schema Suggestion.
- Share this coordinator protocol with direct researcher edits to Schema Revisions.
- Allow one mutation in flight per record. Edits during saving replace the queued draft with the latest value. A successful response acknowledges only its submitted snapshot, then immediately starts a write for a different latest draft.
- Route responses to their original record key. They may advance that record’s acknowledged head and queued draft, but never another active record.
- A navigation or model operation records its pending intent, flushes the affected record, and proceeds only after that record reaches `saved`. A failed flush blocks it until retry succeeds or the researcher explicitly discards the draft; discard restores the acknowledged value and permits the pending intent.
- Conflict responses include the current head and support:
  - Reload latest and discard the draft.
  - Review the retained draft without writing; any consuming transition remains blocked.
  - Explicitly rebase against the returned head and append as a new request.
- Warn on unload while any active or inactive record is dirty, saving, failed, or conflicted; shutdown persistence is not guaranteed.
- Researcher-created Annotations receive client-generated UUIDs. The server validates format, uniqueness, and Source Document scope. Deleted identities cannot be reintroduced.
- Enforce Annotation identity non-reuse inside `appendAnnotationSetRevision`: under the existing Source Document lock, compare the submitted snapshot with the current head and identities in prior revisions. Do not add an identity ledger unless measured history-scan cost requires one.

## Increment 4 — Schema Suggestions and Editing

### Initial Schema Suggestion

- Initial Schema Suggestion is available only for an Extraction Schema with no Schema Revision.
- Each suggestion in this Studio slice uses only the selected Source Document; the broader multi-source store capability remains unchanged.
- Keep `POST /api/generate_schema`, but replace its multipart document payload
  with JSON containing `extractionSchemaId`, `sourceDocumentId`, `promptText`,
  `expectedPromptRevisionNumber`, `annotationMode`, and the optional supported
  temperature override. The browser does not submit representation, Annotation
  Set, or Prompt Revision identities.
- `expectedPromptRevisionNumber` is a non-negative integer; `0` means that no
  Prompt Revision existed in the loaded state.
- Canonicalize Research Prompt text by normalizing line endings to `\n` and
  trimming only outer whitespace. Before the provider call:
  - Reuse the current Prompt Revision when its canonical text is unchanged.
  - Append changed non-empty text against `expectedPromptRevisionNumber`.
  - When empty text clears an existing prompt, append an explicit empty Prompt
    Revision but omit it from the model inputs.
  - When no Prompt Revision exists and text is empty, append nothing and omit
    the prompt.
- Resolve before the provider call:
  - Active Source Representation Revision.
  - Optional current Annotation Set Revision.
  - Optional current non-empty Prompt Revision.
  - Effective provider parameters.
- Return `409 initial_schema_already_exists`, including the current Schema
  Revision identity and number, when a Schema head exists before invocation.
- Call the provider outside PostgreSQL.
- Record every completed success, failure, or cancellation in one transaction.
  Success also creates the initial Schema Revision when the head remains empty.
- If another request creates the first Schema Revision during provider work,
  retain the successful suggestion and proposed tree without seeding a revision,
  then return `409 revision_conflict` with the current head.
- Record cancellation only when the provider or active handler produces a definite cancellation and can still complete the transaction. Disconnects, termination, and timeouts are not guaranteed to persist cancellation.

### Researcher Editing

- Direct browser edits append only `researcher-edit` revisions through autosave.
- Save them through `POST /api/schema-revisions` with
  `extractionSchemaId`, `expectedRevisionNumber`, and `schemaTree`. The server
  assigns the origin and returns the created Schema Revision; the browser cannot
  submit origin or Model Attribution.
- Use the same state machine with a 1.5-second debounce and flush when focus leaves the overall Schema editor, before navigation, conversational editing, or Extraction.
- Studio assigns UUIDs to researcher-created Schema Elements before autosave,
  including elements introduced through JSON editing. The server validates
  format, uniqueness, ownership, and prior use and rejects missing identities.
- Existing IDs must occur in the loaded head. Deleted IDs cannot be reused.
- Enforce Schema Element identity non-reuse inside `appendSchemaRevision`: under the existing Extraction Schema lock, compare the submitted tree with the current head and identities in prior revisions. Do not add an identity ledger unless measured history-scan cost requires one.

### Conversational Model Editing

- Keep `POST /api/edit_schema`, but replace its multipart template/document
  payload with JSON containing `extractionSchemaId`, `sourceDocumentId`,
  `baseSchemaRevisionId`, a non-empty `instruction`, and the optional supported
  temperature override. The browser does not submit the current tree, source
  content, origin, Model Attribution, or request provenance.
- Resolve the active representation, optional Annotation and Prompt revisions, base Schema Revision, instruction, and effective parameters before calling the provider.
- Verify the base belongs to the selected Extraction Schema and is its current
  head. An already-stale base returns `409 revision_conflict` with the current
  head and creates no attempt.
- Disable editing in the same Studio instance while the call is active.
- Send existing Schema Element IDs in structured model input.
- Preserve the existing atomic operation-list interaction, narrowed to:
  - `add` with `parentId`, name, and type. A root add uses `parentId: null`.
  - `remove` with `targetId`.
  - `patch` with `targetId` and at least one supported change.
- Conversational movement remains unsupported; never approximate it as removal
  plus addition. Model operations targeting existing elements reference valid
  IDs. New model elements omit IDs and receive server-generated UUIDs.
- Do not infer identity from names, paths, or positions. Reject the complete
  proposal for any missing target or parent, provider-supplied new identity,
  duplicate or previously used identity, illegal structure or nesting, or
  duplicate sibling name. Never partially apply an operation list or silently
  add an element at the root.
- Persist every completed provider invocation as an immutable
  `ConversationalSchemaEdit` attempt containing its Extraction Schema, pinned
  base Schema Revision, Source Representation, optional Annotation Set and
  non-empty Prompt Revision, instruction, Model Attribution, request provenance,
  outcome, sanitized failure, optional raw output, and validated proposed tree
  on success. A provider failure or invalid model output creates no Schema
  Revision; invalid output uses sanitized code `invalid_model_output`.
- Record through a dedicated server-only `recordConversationalSchemaEdit` command:
  - Failed or cancelled provider work records the completed attempt without a Schema Revision.
  - If a successful proposal's base is still current, record the attempt and append its model-authored revision atomically.
  - If a successful proposal's head advanced, record the succeeded attempt and retained proposal without advancing the Schema head, then return a discriminated `conflicted` result with the attempt identity and current Schema Revision identity and revision number. Conflict is an application result, not a fourth provider-attempt outcome. Do not throw inside the transaction because that would roll back the retained conflict.
  - The server use case maps the store's `conflicted` result to HTTP `409 revision_conflict`.
- A conflict DTO also includes the proposed tree for review. Reapply through
  `POST /api/edit_schema/reapply` with the retained attempt identity and current
  expected head. Revalidate and atomically apply the retained operations without
  another provider call; success creates a model-edit Schema Revision linked to
  the original attempt, while another head change returns `409
  revision_conflict`.

### Request Provenance

- Store request-verifiable provenance:
  - Immutable input revision IDs.
  - Content-addressed prompt compiler version.
  - Effective provider parameters.
  - Structured-output schema and tool-definition versions.
  - Researcher instruction where applicable.
  - SHA-256 of the canonical rendered request.
- Rendering excludes timestamps and other nondeterministic values.
- Do not persist another complete rendered request. The provenance proves request
  equality when retained compiler content and immutable inputs are available; it
  does not claim the hash alone reconstructs the request.

### HTTP Outcomes and Failure Boundary

- Schema Suggestion, conversational-edit, and Extraction requests are
  non-idempotent. Do not accept an idempotency key or automatically retry them;
  Studio disables duplicate submission while one is active.
- A durably recorded provider outcome returns `201`, including failed and
  cancelled attempts. Success returns the attempt identity and created Schema
  Revision DTO. Failure or cancellation returns the attempt identity and
  sanitized failure. Browser DTOs exclude raw model output and request
  provenance.
- Use non-2xx responses for request, ownership, precondition, provider-preflight,
  or persistence failures. No attempt exists for invalid input, stale heads,
  unavailable Capability Routes, or unavailable pinned artifacts before
  invocation.
- Once provider invocation begins, persist every definite completed outcome.
  Process termination, disconnect, or an indeterminate timeout may leave no
  attempt; restart recovery never invents one.

## Increment 5 — Extractions and Recovery

- Keep one `POST /api/extract` route with two identity-based commands:

  ```ts
  type ExtractCommand =
    | {
        mode: "current"
        sourceDocumentId: string
        extractionSchemaId: string
        expectedSourceRepresentationRevisionId: string
        expectedSchemaRevisionId: string
      }
    | { mode: "rerun"; extractionId: string }
  ```

- `current` flushes the visible Schema draft first. The server verifies the two
  expected revision identities are still the active representation and Schema
  head; otherwise it returns `409 revision_conflict` before provider invocation.
  The expected identities are concurrency tokens, not arbitrary historical
  selections.
- `rerun` loads the selected Extraction and reuses its exact pinned Source
  Representation and Schema Revision. It does not flush or substitute current
  heads. Running current heads is a separate `current` command.
- The server loads the pinned artifacts, Extraction Route, Model Attribution,
  and request-verifiable provenance before provider invocation. Requests contain
  no browser-supplied Source Context, Schema tree, Model Attribution, or
  provenance. Unavailable pinned artifacts or Capability Routes are preflight
  failures and create no Extraction.
- Grounded Extracted Values require `parsed_document.v2`. Supply its canonical
  Source Context with stable Evidence Anchor IDs to the provider and accept only
  returned IDs that belong to the pinned Source Representation Revision. Until
  v2 exists, every provider-produced value is an Ungrounded Candidate; do not
  manufacture Evidence from snippets, pages, fuzzy matches, or text offsets.
- Validate Evidence mechanically: exact identity, pinned-representation
  ownership, and allowed anchor kind. Semantic support remains a Result Decision
  concern. Unknown, duplicate, or invalid returned anchors do not fail an
  otherwise valid result: convert that leaf to an Ungrounded Candidate.
- An Extracted Value may use multiple Evidence Anchors. Deduplicate them and
  order them by canonical source position, independent of provider output order.
- Normalize an otherwise structurally valid provider result against the pinned
  Schema Revision:
  - The server derives Schema Element identities and assigns a fresh UUID to
    every Extracted Value, Missing Value, and Ungrounded Candidate; providers
    supply neither identity.
  - An omitted Field in an existing object occurrence becomes a Missing Value.
    An omitted collection becomes an empty collection.
  - Unknown keys, structural mismatches, and scalar type mismatches make the
    completed provider attempt fail. Do not coerce scalar types.
- Call the provider outside PostgreSQL, then record each definite completed
  success, failure, or cancellation as one immutable Extraction in one
  transaction. A structurally valid result may mix Extracted Values, Missing
  Values, and Ungrounded Candidates. A head changed after invocation does not
  invalidate the attempt: record the pinned result and mark it historical.
- Apply the same limited cancellation boundary as Schema Suggestion. Process
  termination, disconnect, or an indeterminate timeout may leave no Extraction;
  restart recovery never creates an in-progress or synthetic attempt.
- Every recorded outcome returns `201` with the bounded selected-Extraction DTO,
  becomes the active selection, and adds its `extractionId` to the canonical
  URL. Non-2xx responses mean no Extraction was recorded.
- Reruns always create new immutable Extractions. Compatible history includes
  every outcome pinned to the active representation and current Schema head,
  ordered by `createdAt DESC, id DESC`; default selection restores its newest
  success, failure, or cancellation.
- Historical inspection renders the pinned Source Representation and Schema
  Revision read-only. Editing or `current` returns to current heads; `rerun`
  remains available against the historical pins.
- Restart recovery uses `GET /api/reopen` to restore URL selection, active
  heads, compatible summaries, and the selected Extraction's exact pinned
  inputs, outcome, and referenced Evidence projection. Persisted artifact
  failures return `503 source_artifact_unavailable` without deleting or changing
  the Extraction.
- Result Decisions remain deferred.

## Store and Modularity Rules

- `ProjectStore` remains the only persistence seam.
- Add no generic CRUD repositories, factories, event buses, or parallel storage interfaces.
- Add narrowly named commands only where existing operations cannot preserve an atomic invariant, including conflicted conversational edit attempt retention.
- Never hold PostgreSQL transactions across Parsing Service or provider calls.
- Never automatically retry non-idempotent ingestion or model operations.
- Prisma types, database configuration, hashes, and artifact references never cross into browser code.

## Test Plan

- Each increment leaves Studio functional and passes its relevant tests before the next begins.
- Verify no browser bundle imports `@free/db`, Prisma, or server composition code.
- Test singleton initialization concurrency and recovery after PostgreSQL failure.
- Test missing, malformed, unknown, and cross-parent URL identities.
- Test URL canonicalization after default selection.
- Test historical Extraction rendering against pinned inputs.
- Test two Source Documents with identical bytes and store-level multiple representations of one Source Document.
- Test task SSE snapshots, state changes, heartbeats, reconnects, and terminal
  events. Test PDF full reads, ranges, cache validators, `GET`/`HEAD` parity,
  header filtering, missing bundles, unavailable artifacts, and upstream failures.
- Test canonical no-op autosaves, queued edits during an in-flight request, inactive-record response routing, transition blocking, and conflict actions.
- Test that Schema Suggestion and Extraction consume flushed revision heads.
- Test current-head concurrency tokens, historical reruns, head races during
  provider calls, and restart-abandoned calls.
- Test Evidence Anchor ownership and ordering, invalid-anchor degradation,
  Missing Value normalization, and structural/type failures.
- Test client UUID validation, deletion non-reuse, and model-generated server IDs.
- Test model identity rejection when existing IDs are omitted or forged.
- Test model-attribution forgery rejection and conversational conflicts with retained proposals.
- End-to-end: ingest, annotate, generate/edit schema, extract/rerun, restart services, reopen the canonical URL, and recover the exact artifacts, heads, and selected Extraction.

## Assumptions

- Trusted, single-researcher localhost deployment.
- PostgreSQL and the Parsing Service are required.
- Authentication, artifact cleanup, lifecycle, pagination, reprocessing UI, Batches, Schema Decisions, Result Decisions, and persisted UI preferences remain deferred.
