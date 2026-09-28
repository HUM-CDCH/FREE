# Span grounding

## Purpose

Reduce repeated verification work while preserving exact canonical source locations,
explicit evidence eligibility and auditable support decisions for extracted values.

## ADDED Requirements

### Requirement: Selected source text is reconstructed exactly
Span verification SHALL resolve only offered generation-scoped source choices. Quotes,
parent IDs, code-point offsets, cell identities and available geometry SHALL derive
from canonical inputs rather than model-generated text. Coarse geometry SHALL remain
coarse; table cells and their row/header context SHALL remain intact.

#### Scenario: A source quote contains tabs and repeated text
- **WHEN** the model selects one offered occurrence
- **THEN** the result retains that occurrence's exact offsets and literal characters
- **AND** it does not relocate the quote to an identical string elsewhere

#### Scenario: A table cell has no measured geometry
- **WHEN** that cell is selected as source support
- **THEN** its identity and text remain exact while geometry uses the explicit coarse parent precision

### Requirement: Location and semantic support remain distinct
Selecting a valid ID SHALL require model attestation that the source supports the
field and its subject. Missing, unknown, negatively attributed or truncated decisions
SHALL NOT acquire support. Accepted decisions SHALL remain labelled model-attested.

#### Scenario: Correct value belongs to another table row
- **WHEN** attribution is rejected despite a valid selected cell ID
- **THEN** the value remains unsupported and retains a diagnostic

### Requirement: Claim scheduling is independently measurable
An unresolved-only policy SHALL carry supported full record paths across source units
and omit only those paths from later verification. Remaining claims SHALL retain
complete response accounting and budget refusals. Scheduling SHALL be fingerprinted
separately from source-span representation.

#### Scenario: One claim is supported and another unanswered
- **WHEN** verification advances to the next unit under unresolved-only scheduling
- **THEN** only the supported path is omitted and the unanswered claim remains eligible

### Requirement: Evidence eligibility is explicit schema policy
Quoted, derived and deliberately unverified schema policies SHALL survive validated
schema transport and revisions. Skipped leaves SHALL retain their full paths and
reasons; they SHALL NOT become verified or disappear from all-leaf reporting.
Field names alone SHALL NOT determine eligibility.

#### Scenario: A diagnostic subtree is renamed
- **WHEN** its explicit derived policy remains unchanged
- **THEN** its descendants retain the same eligibility unless a child overrides it

### Requirement: Retrieval does not silently limit strict coverage
Strict routed verification SHALL try remaining source units for unresolved claims
after preferred candidates. It SHALL record attempted, refused and remaining units,
and SHALL NOT label skipped work exhaustive contradiction search.

#### Scenario: Support occurs outside the retrieved shortlist
- **WHEN** the shortlist yields no support in strict mode
- **THEN** later source units remain eligible and support can be found there

### Requirement: New comparisons preserve existing experimental evidence
New grounding comparisons SHALL pin upstream records and independent factors before
generation. Existing frozen experiments SHALL remain unchanged. Reporting SHALL
separate costs, literal source validity, model support and independently reviewed
semantic evidence, including failures and omitted decisions in their denominators.

#### Scenario: Span selection returns only syntactically valid IDs
- **WHEN** no independently reviewed claim/source labels exist
- **THEN** reporting establishes literal validity without claiming semantic precision or recall
