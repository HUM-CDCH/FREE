# advanced-extraction-configuration Specification

## Purpose
Let Humanities Researchers explore the supported extraction methods through
understandable configuration controls while preserving valid requests, immutable
run attribution, and honest explanations of evidence and experimental findings.

## Requirements

### Requirement: All supported method controls are reachable
The Advanced tab SHALL expose the Article controls and Catalog controls listed
in the design's control inventory, including explicit identity fields and
numeric limits. It SHALL permit every combination accepted by the method
contract, subject to schema and served-model constraints at admission/execution.
It SHALL distinguish Article, generic Catalog and recipe Catalog applicability.
Selecting the strategy to configure SHALL NOT change any Extraction's strategy.
It SHALL reuse the Models tab's field/reasoning choices without a second editor.

#### Scenario: Article factors can be varied independently
- **WHEN** a researcher customizes an Article method
- **THEN** context, identity, prompt, rendering, grouping, overlap, selection,
  verification, eligibility, scheduling and routing are individually reachable
- **AND** compatibility rules, rather than a fixed preset list, constrain choices

#### Scenario: Recipe and generic settings are kept distinct
- **WHEN** Catalog settings are saved and a generic Catalog Extraction starts
- **THEN** only the generic limits affect that Extraction
- **AND** recipe factors and budgets remain saved for future recipe Extractions

#### Scenario: Unrelated strategy changes do not change the method
- **WHEN** only Article preferences change before starting a Catalog Extraction
- **THEN** its requested Catalog method and equal-selection batch identity stay unchanged

### Requirement: Defaults and custom choices have explicit meaning
An unset strategy override SHALL preserve the service's existing omitted-option
behavior. Opening the tab or its explanations SHALL NOT create an override.
Customize SHALL create an explicit reference draft. Use service defaults SHALL
remove only that strategy's draft override and SHALL require Apply to persist.
Optional disabled factors SHALL serialize by omission. Requested overrides and
effective service-returned settings SHALL remain distinguishable.

#### Scenario: Opening the tab keeps the reference path
- **WHEN** a researcher with no advanced choices opens and closes Advanced
- **THEN** the configuration remains unchanged and no explicit Article options are introduced

#### Scenario: A strategy returns to defaults
- **WHEN** the researcher chooses Use service defaults for Article and applies
- **THEN** the next Article request omits Article overrides
- **AND** Catalog preferences, model choices and connections remain unchanged

#### Scenario: Example settings are only a draft
- **WHEN** a researcher uses an explanatory starting point
- **THEN** the exact settings are shown and only the relevant strategy's draft changes
- **AND** no Extraction or save is triggered until the ordinary explicit action

### Requirement: Incompatible combinations are rejected visibly
The page and server SHALL enforce the same method constraints: bounded context
for overlap, structural grouping and supported selection; quoted or span
verification for schema eligibility; enabled verification for unresolved
scheduling; and quoted/span verification plus unresolved scheduling for
origin/lexical routing. Conservative identity SHALL require unique nonempty
declared keys. Integer bounds SHALL match the service contract. An invalid parent
change SHALL preserve and reveal the conflicting child choices and block Apply.
The server SHALL refuse invalid submitted combinations without partial saving,
silent coercion of method choices, or fallback to another method.

#### Scenario: Context change invalidates overlap
- **WHEN** a draft with bounded context and overlap 1 changes to full source
- **THEN** overlap 1 remains visible with a bounded-context error and Apply is unavailable
- **AND** changing back to bounded restores validity without losing the choice

#### Scenario: Routing is sent with an incompatible verifier
- **WHEN** a direct request selects semantic grounding and origin/lexical routing
- **THEN** it is refused with a field-addressed validation issue before model work

#### Scenario: An identity key is absent from the pinned schema
- **WHEN** a new Extraction's declared identity key is missing, nested, non-scalar
  or document-sourced in the selected Schema Revision
- **THEN** admission is refused with the offending field names
- **AND** no fallback identity or provider call is made

### Requirement: Explanations are optional, accessible and scientifically scoped
The primary surface SHALL use short labels and one-line summaries. Each section
SHALL offer on-demand explanations containing an example, an accessible
visualization and the limits of applicable study evidence. Examples SHALL be
clearly illustrative and SHALL NOT call a model or alter settings unless a
separate Use these settings action is chosen. Study findings SHALL identify
their date, corpus, revision and evidence type. Untested combinations and
unmeasured effects SHALL be identified without fabricated accuracy or cost
estimates. The page SHALL support keyboard operation, focus restoration from
help, associated validation errors, and reflow at narrow widths and zoom.

#### Scenario: A researcher explores a span example
- **WHEN** the researcher opens Explain for source spans and changes the example
- **THEN** the example shows exact source ranges and attribution limits
- **AND** the draft is unchanged, no model call occurs and closing returns focus

#### Scenario: Study evidence is shown for span grounding
- **WHEN** the researcher opens Study evidence
- **THEN** the selected-document pilot and Harvey diagnostic remain separate
- **AND** link counts are not labelled semantic accuracy or generalized savings

### Requirement: Schema policies retain schema ownership and truthful status
The account choice SHALL select whether eligible Article verification follows
the pinned schema's inherited `quoted`, `derived` and `unverified` policies.
Changing the account choice SHALL NOT edit schema metadata or create revisions.
Omitted node policy SHALL inherit, defaulting to quoted; explicit children SHALL
override their parent. Derived and unverified leaves SHALL retain their values,
ungrounded status and policy reason. All-leaf and eligible-leaf counts SHALL
remain separate; zero eligible leaves SHALL be not applicable, not fully grounded.
Article document fields SHALL NOT be described as verified by these controls.

#### Scenario: A child overrides a derived parent
- **WHEN** schema-policy verification encounters a derived object containing an
  explicitly quoted temperature child
- **THEN** that child remains eligible while inheriting derived siblings are skipped
- **AND** no skipped value is presented as grounded or as a validated calculation

#### Scenario: Every record field is ineligible
- **WHEN** all populated leaves are derived or unverified under schema policies
- **THEN** eligible grounding is not applicable and skipped values remain visibly ungrounded

### Requirement: A newly admitted Extraction freezes its active method
Before new single or batch admission, FREE SHALL validate the saved-setting
intent shown at start against the account's current settings and selected schema.
A stale intent SHALL be refused with a refreshable conflict. Successful admission
SHALL atomically persist the applicable method with source/schema/model pins.
Queued, running and recovered work SHALL use those immutable settings. All batch
members SHALL receive one batch-level method snapshot. Changing account settings
SHALL affect only future admissions.

#### Scenario: Configuration changes after the start summary
- **WHEN** saved active settings change after the researcher sees the start summary
  but before a new request is admitted
- **THEN** FREE asks the researcher to refresh the summary instead of silently using
  the changed settings, and no Extraction is admitted

#### Scenario: Settings change while a batch is queued
- **WHEN** a batch admitted with source spans has pending members and the account
  subsequently saves generated quotes
- **THEN** every existing member retains source spans, including after restart
- **AND** a newly admitted batch uses the new saved choice

### Requirement: Replay and batch reuse include the active method
An identical repeated single request SHALL resolve its existing admission before
consulting today's defaults. The same Extraction ID with a different active
descriptor SHALL be a conflict. Batch equal-selection reuse SHALL include all
applicable method settings and preserve the explicit-versus-omitted distinction
when it changes service behavior or artifacts. Inactive strategy preferences
SHALL NOT create a different batch. Explicit Run again SHALL retain its existing
fresh-run behavior.

#### Scenario: Response is lost before account settings change
- **WHEN** a single request committed, its response was lost, account settings
  changed and the original request is retried with its original descriptor
- **THEN** the already admitted Extraction is replayed using its stored method
- **AND** no second run is scheduled

#### Scenario: One factor changes between batch trials
- **WHEN** the same sources, schema and models are selected with a different
  active grounding or context factor
- **THEN** equal-selection reuse does not return the previous batch

### Requirement: Method attribution never comes from current configuration
Extraction details SHALL show recorded requested and effective options, model
choices and available protocol versions. Requested settings SHALL remain
available when execution fails before an effective method is returned. Historical
missing metadata SHALL be labelled not recorded. FREE SHALL never infer past
settings from current account defaults or label configuration equality as exact
historical model reproduction.

#### Scenario: An older result has no method snapshot
- **WHEN** the researcher opens that result after changing configuration
- **THEN** missing settings are labelled Not recorded, without borrowing current choices

#### Scenario: Budget admission fails
- **WHEN** the chosen method cannot fit a source unit and its output reserve
- **THEN** the failure and requested method remain visible
- **AND** no truncation, different verifier or silent full-source fallback is introduced

### Requirement: Verification controls preserve evidence semantics
Source spans SHALL use offered canonical ranges and preserve their actual geometry
precision; exact text SHALL NOT be described as independent proof of entailment.
NONE, missing, malformed and refused decisions SHALL remain unresolved for later
eligible units. Stopping after support SHALL NOT imply absence of contradictions.
Catalog verification Off SHALL retain typed values as proposals without accepted
grounding; structural ownership SHALL remain enabled.

#### Scenario: Preferred evidence fails to support a claim
- **WHEN** routed quoted/span verification returns NONE in its preferred unit
- **THEN** later eligible units remain available under the existing exhaustive
  unresolved fallback and the failed preference does not create a link

#### Scenario: Catalog verification is disabled
- **WHEN** a recipe Catalog Extraction runs with verification Off
- **THEN** returned typed candidates are proposals, not accepted grounded values
- **AND** canonical ownership and spans remain intact
