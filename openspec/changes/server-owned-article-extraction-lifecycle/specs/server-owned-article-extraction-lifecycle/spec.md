## ADDED Requirements

### Requirement: Server owns an Article attempt from pins through persistence

The Studio server SHALL accept an Article operation UUID, Source Representation Revision ID, Schema Revision ID, and `ARTICLE` strategy; load and validate those pinned resources; run one whole-source value extraction; ground content-derived values against the pinned canonical package; and persist one terminal Extraction before returning it. The browser MUST NOT supply a PDF, schema body, model output, Evidence links, attribution, diagnostics, or outcome to this operation.

#### Scenario: Article extraction completes

- **WHEN** valid pins and a fresh UUID are posted for `ARTICLE`
- **THEN** the server persists a terminal completed Extraction before returning its server-computed DTO
- **AND** the result is a hidden-root `{ "records": [...] }` object produced by one whole-source value call

#### Scenario: Article returns zero or multiple records

- **WHEN** the one whole-source value call returns a valid hidden `records` array containing zero or multiple objects
- **THEN** the server retains that array as the succeeded result instead of imposing an Article cardinality
- **AND** normal grounding and completeness rules apply to the retained records

#### Scenario: Pins do not share one Project Context

- **WHEN** the Source Representation Revision and Schema Revision belong to different Project Contexts
- **THEN** the server rejects the request without invoking a model or writing an Extraction

### Requirement: Article UUID reuse is idempotent and identity-bound

An Extraction UUID SHALL identify exactly one tuple of Source Representation Revision, Schema Revision, and strategy. Concurrent identical requests SHALL share one in-flight operation; later identical requests SHALL replay its stored terminal attempt; and any reuse with a different tuple SHALL return `409` without model work or mutation.

#### Scenario: Identical requests overlap

- **WHEN** two identical requests with one UUID arrive before the first completes
- **THEN** both receive the result of one model-and-grounding execution and one terminal row

#### Scenario: UUID is reused with different pins

- **WHEN** an in-flight or stored UUID is posted with a different Source Representation Revision, Schema Revision, or strategy
- **THEN** the server returns `409`
- **AND** it does not invoke a model or change the stored attempt

#### Scenario: Failed or cancelled attempt is replayed

- **WHEN** an identical request reuses the UUID of a stored failed or cancelled attempt
- **THEN** the server returns that terminal attempt without rerunning it

### Requirement: Cancellation terminates only active Article work

The server SHALL allow an active Article operation to be cancelled by UUID. Cancellation SHALL stop work at phase boundaries and persist `CANCELLED` before the original POST returns. Cancellation SHALL NOT delete or mutate a terminal attempt, create a running row, or interrupt a terminal persistence transaction.

#### Scenario: Active operation is cancelled

- **WHEN** cancellation reaches an active operation before terminal persistence begins
- **THEN** the operation persists and returns a cancelled terminal attempt with no result or Evidence links

#### Scenario: Unknown or terminal operation is cancelled

- **WHEN** cancellation names an operation that is not active
- **THEN** the server returns `404`
- **AND** PostgreSQL remains unchanged

### Requirement: Terminal attempt shapes are enforced durably

PostgreSQL SHALL store only `SUCCEEDED`, `FAILED`, or `CANCELLED` Extraction outcomes. A succeeded attempt MUST have a JSON-object result, a JSON-array Evidence-link set, boolean completeness, and route attribution. Failed and cancelled attempts MUST have no result or Evidence links. Extraction rows and review decisions SHALL be insert-only except for the one write from null `reviewedAt` to its final timestamp.

#### Scenario: Invalid completed shape is inserted directly

- **WHEN** a transaction attempts to insert a completed Extraction without its required result, Evidence links, completeness, or attribution
- **THEN** PostgreSQL rejects the row

#### Scenario: Terminal transaction fails

- **WHEN** any write in terminal persistence fails
- **THEN** no partial Extraction or related state is committed

#### Scenario: Retry crosses Source Documents

- **WHEN** a retry parent belongs to a different Source Document than the new attempt's pinned Source Representation Revision
- **THEN** PostgreSQL rejects the relationship

#### Scenario: Retry changes a pin or points to itself

- **WHEN** a retry parent is the child itself or has a different Source Representation Revision, Schema Revision, or strategy
- **THEN** PostgreSQL rejects the relationship

### Requirement: Article grounding uses canonical anchors

Every populated scalar path SHALL be reviewable only when it has an Evidence link to an exact published `parsed_document.v2` Evidence Anchor. The server MUST NOT create Evidence through PDF text matching or accept a foreign citation label.

#### Scenario: Grounding returns a foreign anchor

- **WHEN** a model citation does not exactly identify an anchor in the pinned canonical package
- **THEN** the populated content-derived path remains ungrounded
- **AND** the attempt is not reviewable

#### Scenario: All populated content paths are grounded

- **WHEN** every populated scalar path has a canonical Evidence link
- **THEN** the server marks the completed attempt reviewable

### Requirement: Review finalization trusts only stored attempt material

Review finalization SHALL accept an Extraction ID and one normalized decision per Evidence Anchor cited by that stored attempt. It SHALL validate exact anchor coverage and every reviewed occurrence against the pinned canonical package, set `reviewedAt`, and insert all decisions in one transaction. It MUST reject an unreviewable or non-completed attempt, missing or extra anchor decisions, unknown or foreign occurrences, and different decisions after finalization.

Before finalization, the server SHALL re-derive every populated scalar path from the immutable stored result and require one unique stored Evidence Link for each path.

#### Scenario: Review is finalized

- **WHEN** a reviewable completed attempt receives exact valid decisions
- **THEN** `reviewedAt` and all decisions commit atomically
- **AND** an identical later request replays the same reviewed DTO

#### Scenario: Concurrent reviews differ

- **WHEN** two concurrent finalizations submit different decisions for one unreviewed attempt
- **THEN** exactly one decision set commits and the other receives `409`

#### Scenario: Review references a foreign occurrence

- **WHEN** a decision names an occurrence not owned by its cited anchor in the attempt's pinned generation
- **THEN** the whole finalization is rejected without partial decisions or `reviewedAt`

### Requirement: Reopen keeps latest attempt and latest reviewed pins independent

A Source Document reopen SHALL return the deterministic latest terminal attempt and deterministic latest reviewed Extraction independently across that Source Document's representation history. Each returned attempt SHALL carry its own Source Representation Revision, Schema Revision, canonical resource descriptor, result, Evidence, outcome, diagnostics, and review state.

#### Scenario: Newer unreviewed attempt has different pins

- **WHEN** a newer unreviewed attempt uses different representation and schema pins than the latest reviewed Extraction
- **THEN** reopen returns it as `latestAttempt` and returns the older reviewed Extraction as `latestReviewed`
- **AND** neither DTO borrows the other's pins or resource descriptor

#### Scenario: One attempt is both latest and reviewed

- **WHEN** the deterministic latest attempt is also the latest reviewed Extraction
- **THEN** both reopen fields describe that same durable Extraction

### Requirement: Server diagnostics are bounded and safe

Terminal attempts SHALL retain phase, elapsed time, provider finish reason, token counts when available, and model-call counts sufficient to explain the run. Diagnostics MUST NOT store prompts, raw model output, credentials, headers, stack traces, or unbounded provider bodies.

Succeeded attempts SHALL also retain grounded and ungrounded paths, grounding issue codes, and bounded per-batch candidate, finish, token, and latency facts. The separate model attribution SHALL contain only the one resolved route pin.

#### Scenario: Provider response is truncated

- **WHEN** the provider reports a length finish reason and the tolerant parser recovers a usable object
- **THEN** the server persists the completed result with `complete: false` and `finishReason: "length"`

#### Scenario: Generated output is unusable

- **WHEN** the tolerant parser cannot recover an object
- **THEN** the server persists a failed terminal attempt with a sanitized failure and safe diagnostics
