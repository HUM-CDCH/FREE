## MODIFIED Requirements

### Requirement: All supported method controls are reachable
The Advanced tab SHALL expose the Article controls and one unified Catalog
control group, including explicit identity fields where applicable and numeric
limits. It SHALL permit every combination accepted by the method contract,
subject to schema and served-model constraints at admission/execution. It SHALL
distinguish Article and Catalog applicability without generic/recipe choices for
new Extractions. Selecting the strategy to configure SHALL NOT change any
Extraction's strategy. It SHALL reuse the Models tab's field/reasoning choices
without a second editor. The schema editor SHALL retain ownership of the record
definition and field meanings.

#### Scenario: Article factors can be varied independently
- **WHEN** a researcher customizes an Article method
- **THEN** context, identity, prompt, rendering, grouping, overlap, selection,
  verification, eligibility, scheduling and routing are individually reachable
- **AND** compatibility rules, rather than a fixed preset list, constrain choices

#### Scenario: Catalog has one configuration
- **WHEN** a researcher configures or starts a new Catalog Extraction
- **THEN** one Catalog settings group applies to both single and batch work
- **AND** no recipe or model-discovery implementation selector is required

#### Scenario: Unrelated strategy changes do not change the method
- **WHEN** only Article preferences change before starting a Catalog Extraction
- **THEN** its requested Catalog method and equal-selection batch identity stay unchanged

### Requirement: Defaults and custom choices have explicit meaning
An unset strategy override SHALL use the applicable service defaults under the
method version shown at admission. Opening the tab or its explanations SHALL
NOT create an override. Customize SHALL create an explicit reference draft.
Use service defaults SHALL remove only that strategy's draft override and SHALL
require Apply to persist. Optional disabled factors SHALL serialize according
to their versioned contract. Requested overrides and effective service-returned
settings SHALL remain distinguishable. Catalog budget controls SHALL affect
request size and partitioning, never authorize dropping primary source text.

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

#### Scenario: A Catalog budget is reduced
- **WHEN** a researcher chooses a smaller supported input budget
- **THEN** Catalog partitions primary work into more requests where possible
- **AND** a request that cannot fit is explicitly refused rather than clipped

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
- **WHEN** a unified Catalog Extraction runs with verification Off
- **THEN** returned typed candidates are proposals, not accepted grounded values
- **AND** canonical ownership and spans remain intact

## ADDED Requirements

### Requirement: Legacy Catalog preferences migrate explicitly
FREE SHALL preserve legacy Catalog settings until their migration is explicitly
applied. Character limits SHALL NOT be silently converted into token limits.
Conflicting old generic/recipe overrides SHALL NOT be silently selected or
merged. The page SHALL show what is retained, changed or retired, using the
existing draft/Apply interaction. Historical method display SHALL distinguish
legacy settings from current controls. Unrelated Article configuration and
already admitted work SHALL remain usable during preference migration.

Until required migration is applied, new single and batch Catalog admission SHALL
return a refreshable migration-required conflict. Account decoding SHALL retain
retired Catalog keys unchanged; Apply SHALL atomically replace only the Catalog
preference branch. Admission SHALL validate setting shape, while actual budget
fit SHALL be checked where serving tokenizer/context metadata is available and
reported for the affected Extraction.

#### Scenario: An account has customized both legacy branches
- **WHEN** that account next configures or attempts a new Catalog Extraction
- **THEN** FREE presents the unified settings draft and explains the incompatible
  legacy controls before admitting new Catalog work
- **AND** the old preferences remain unchanged until Apply

#### Scenario: An account never customized Catalog
- **WHEN** it starts a new Catalog Extraction after cutover
- **THEN** the start summary identifies the new default method and settings
- **AND** no legacy character-limit conversion is invented

#### Scenario: Configuration changes after admission
- **WHEN** the account changes its Catalog preferences while a batch is queued
- **THEN** all members continue using their admitted versioned method
- **AND** the new preferences affect only subsequent admissions
