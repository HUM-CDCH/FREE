## ADDED Requirements

### Requirement: One general Catalog method
New single and batch Catalog Extractions SHALL use one versioned method. Its
execution SHALL NOT require a recipe, language, decimal entry numbering,
domain-specific field names or a particular model provider. The pinned schema
SHALL define the record and fields; the existing field and reasoning roles SHALL
select the models. Historical method descriptors SHALL retain their meaning.

#### Scenario: Arbitrary catalogue identity and schema
- **WHEN** a Catalog Extraction uses unnumbered entries or alphanumeric labels
  and researcher-defined field names
- **THEN** it uses the same method as a numbered catalogue
- **AND** printed labels are source data, not required internal record identities

#### Scenario: Single and batch consistency
- **WHEN** the same source, schema and Catalog settings are admitted singly or
  as a batch member
- **THEN** both use the unified Catalog method and the same coverage guarantees

### Requirement: Complete canonical source accounting
Catalog SHALL account for every admitted nonblank canonical source range,
including withheld or unresolved ranges. Primary entry ownership SHALL be
disjoint; context reuse SHALL be separately identified. Assigning a disposition
SHALL NOT assert that a model correctly identified all records. Failed discovery
windows SHALL NOT silently extend the preceding entry through unsearched text.

#### Scenario: A discovery window fails
- **WHEN** one discovery call exhausts its bounded recovery attempts
- **THEN** its ranges and affected record boundaries remain explicitly unresolved
- **AND** independently processable records remain available with incomplete status

#### Scenario: A model identifies non-record text
- **WHEN** discovery classifies a source range as non-record text
- **THEN** its range and decision remain inspectable
- **AND** full accounting is not described as measured record recall

### Requirement: Discovery supports canonical boundaries inside segments
Discovery SHALL process the complete admitted source through counted windows and
return validated canonical boundaries, including multiple records within one
parser segment. It SHALL reconcile overlapping observations by source location,
preserve ambiguity, and retain cross-window continuations. Schema-dependent
discovery artifacts SHALL be identified by the source, schema, method, model
and relevant protocol versions that produced them.

Continuation SHALL require compatible explicit observations at both sides of a
window boundary, including when overlap is zero. Missing or disagreeing
observations SHALL leave the affected ranges unresolved.

#### Scenario: Two entries share a parser segment
- **WHEN** two entries occur inside one canonical segment or line
- **THEN** discovery can identify distinct validated ranges for them
- **AND** neither a page nor a parser-segment boundary is required between records

#### Scenario: A schema changes the meaning of a record
- **WHEN** the same source is extracted under a different record definition
- **THEN** discovery does not reuse an artifact identified only by source or recipe

### Requirement: Every extraction stage respects counted budgets without clipping
Discovery, record extraction, document-field extraction, verification and
reconciliation SHALL count the actual request for its serving model and reserve
output space. Oversized primary input SHALL be divided into source-preserving
windows, or explicitly refused when a valid minimum request cannot fit. No
stage SHALL silently truncate input or treat an output-truncated reply as
complete. Exhausted attempts SHALL identify unresolved work.

#### Scenario: A record exceeds the former character limit
- **WHEN** a record contains more than 24,000 characters and a field is supported
  only near its end
- **THEN** the entire primary record text is scheduled across fitting requests
- **AND** the final section is not omitted because of record length

#### Scenario: A document field appears late in the source
- **WHEN** a document-level field is supported beyond the first fitting window
- **THEN** that region participates in document-field extraction
- **AND** the result preserves disagreements and its document-field evidence status

#### Scenario: Document metadata lies outside catalogue entries
- **WHEN** a document field is supported in front matter or text classified as
  non-record or unresolved by entry discovery
- **THEN** the independent document-field partition still processes that text
- **AND** its processing status is tracked separately from entry extraction

#### Scenario: A single source unit is oversized
- **WHEN** one page, segment, line or table cell exceeds the available input budget
- **THEN** source-preserving subdivision retains its canonical identity and context
  or reports the exact unprocessed range
- **AND** no minimum unit is dropped to make a request appear to fit

#### Scenario: Reply capacity is exhausted
- **WHEN** a model response is truncated by its output limit
- **THEN** bounded recovery subdivides the work where valid or records an
  incomplete outcome
- **AND** a decoded prefix is not accepted as a complete answer

### Requirement: Evidence acceptance is independent of recipes
Candidate acceptance SHALL validate types, allowed values, canonical source
ownership and support for the schema field. Exact occurrence SHALL NOT alone be
described as semantic verification. No acceptance rule SHALL require a fixed
field name or recipe keyword. Verification-disabled or unsupported candidates
SHALL remain proposals. Evidence SHALL retain actual geometry precision and the
pinned Source Representation identity.

Literal-value ranges and supporting ranges for nonliteral values SHALL remain
distinct. A boolean or normalized value SHALL NOT receive a fabricated literal
span. Heading context SHALL NOT silently become a field binding.

#### Scenario: A field is renamed
- **WHEN** a researcher renames a field while preserving its meaning and description
- **THEN** evidence eligibility does not depend on the old field name

#### Scenario: A value belongs to a neighboring entry
- **WHEN** the same value occurs in neighboring context but not as support for the
  current record and field
- **THEN** proximity alone does not make it an accepted grounded value

### Requirement: Candidate merging preserves structure and uncertainty
Reconciliation SHALL deduplicate equivalent supported observations and preserve
conflicting candidates. It SHALL NOT combine array objects by window-local
position or repeated text alone. Any arbitration SHALL select among supplied
candidates or leave the conflict unresolved; it SHALL obey counted budgets and
retain the alternatives and decision. Unsupported partial item identity SHALL
remain explicit rather than creating a fabricated combined record.

The first release SHALL deduplicate array objects only on an unambiguous
matching item occurrence with equal structure, values and per-leaf support.
Complementary partial objects SHALL NOT be auto-joined. Context, inherited
headings and nonliteral supporting spans SHALL NOT establish item identity.
Results SHALL distinguish observed, resolved and partial item counts.

#### Scenario: Arrays cross a window boundary
- **WHEN** two windows return array items with the same local index
- **THEN** the merger uses supported item identity and canonical location
- **AND** it does not zip unrelated item fields into one object

#### Scenario: Competing values cannot be resolved within budget
- **WHEN** all competing candidates cannot be safely reconciled
- **THEN** the alternatives remain visible as unresolved
- **AND** no first-value, last-value or first-N truncation rule silently wins

#### Scenario: Two items share evidence
- **WHEN** distinct items share an inherited heading or scalar evidence span
- **THEN** the shared span alone neither merges them nor removes one
- **AND** unresolved identity or cardinality remains visible

### Requirement: Coverage, processing and evidence are distinct
Results SHALL expose source accounting, processing failures and evidence status
separately, with semantic recall labelled unmeasured unless independently
evaluated. Missing primary processing or unresolved discovery SHALL prevent a
complete result. Document fields SHALL retain their explicit verification status.
Coverage SHALL refer to the admitted source scope, not an implied larger source.

#### Scenario: Source accounting is exhaustive but a call failed
- **WHEN** every range has a disposition but one required extraction window failed
- **THEN** accounting can be exhaustive while processing remains incomplete
- **AND** the researcher can identify the affected source ranges

### Requirement: Versioned admission and historical compatibility
Unified Catalog SHALL use a distinguishable method and result version. New
admission, batch reuse, handoff, fingerprints and result acceptance SHALL check
that version and its pinned settings. Existing results and Review Decisions
SHALL remain readable. Retrying an existing admitted ID SHALL resolve its
original descriptor before consulting current settings. Legacy execution SHALL
not be silently redirected to the unified implementation.

#### Scenario: A legacy response was lost
- **WHEN** a previously admitted request is retried after cutover
- **THEN** FREE resolves the original admission using its original descriptor
- **AND** it does not create or execute a new unified method under that ID

#### Scenario: A result has the wrong method
- **WHEN** the worker returns a legacy result for a unified request or mismatched
  unified settings
- **THEN** Studio rejects the result before publication to the researcher's review

### Requirement: Recovery preserves published execution and discovery records
Before model work, Catalog SHALL atomically publish an extraction-local write-once
execution record with resolved budgets and dependency identity. It SHALL publish
a write-once discovery record referencing that execution record before entry
processing. Identical repeated publication SHALL be idempotent; conflicting
publication SHALL fail explicitly. Recovery SHALL validate and reuse existing
records or fail for incompatible identity or capacity, never silently replace
them. The v3 result SHALL embed both records and their verifiable digests. Existing
source lifecycle cleanup SHALL include these artifacts.

#### Scenario: The worker crashes after discovery
- **WHEN** the durable extraction step restarts after publishing discovery but
  before publishing its final result
- **THEN** it reuses the validated discovery and budget records
- **AND** it does not silently discover a different set of entries for that ID

#### Scenario: Two recoveries publish different discovery
- **WHEN** competing attempts for one Extraction ID produce different completed
  discovery records
- **THEN** only one can be published and the conflicting write fails explicitly
- **AND** no completed record is overwritten

#### Scenario: The serving environment no longer fits pinned budgets
- **WHEN** recovery finds a valid execution record the current environment cannot honor
- **THEN** it reports a budget refusal and does not silently change the stored method

### Requirement: Generalization evidence precedes default cutover
Default cutover SHALL require a frozen evaluation protocol with independent
document-family holdouts, varied numbering, languages, schemas and layout,
plus role-correct model variation. It SHALL report human-assessed boundary and
field quality, evidence precision and processing coverage separately from calls,
tokens and latency. Missing datasets or models SHALL be explicit unmet gates,
not passing results. Exact quality thresholds SHALL be registered before the
held-out run is inspected.

#### Scenario: One numbered catalogue performs well
- **WHEN** the unified method passes only the existing German numbered fixture
- **THEN** that result counts as a regression check
- **AND** it is insufficient evidence to replace the default for all Catalog runs
