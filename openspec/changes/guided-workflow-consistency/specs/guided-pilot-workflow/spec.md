## ADDED Requirements

### Requirement: One pilot-selection limit names a pilot everywhere

FREE SHALL treat one Batch Extraction at or under a single pilot-selection
limit as a pilot round, and any larger Batch Extraction as a collection-scale
batch, in every surface that names or gates the run.

#### Scenario: A limit-sized unstabilised run is a pilot

- **WHEN** a researcher runs a Batch Extraction whose member count is at or
  under the pilot-selection limit against a Schema Revision with no
  stabilisation
- **THEN** the run is admitted, is named a pilot in the history list and the
  completion dialog, and offers the review-then-approve guidance

#### Scenario: A larger run is a collection batch

- **WHEN** a researcher runs a Batch Extraction whose member count is over
  the pilot-selection limit
- **THEN** the run is named a collection batch in the history list and the
  completion dialog, and its next-step copy names the collection run or export
  rather than pilot approval

### Requirement: Every Batch Extraction entry path enforces the pilot gate

FREE SHALL refuse to create a collection-scale Batch Extraction against a
Schema Revision with no stabilisation on every entry path, including the Batch
Schema Suggestion confirmation, and SHALL create no Batch Extraction, member or
Schema Revision mutation for a refused request.

#### Scenario: Schema suggestion confirmation over the pilot limit is refused

- **WHEN** a researcher confirms a Batch Schema Suggestion whose admitted
  sources are over the pilot-selection limit and whose Schema Revision has no
  stabilisation
- **THEN** the request is refused with the same "stabilise first" refusal the
  ordinary batch path uses, no Batch Extraction is created, and the client
  states that the suggested fields must be piloted on at most the limit first

#### Scenario: Schema suggestion confirmation at or under the limit is admitted

- **WHEN** a researcher confirms a Batch Schema Suggestion whose admitted
  sources are at or under the pilot-selection limit
- **THEN** the suggested Revision is created and the pilot Batch Extraction is
  admitted

### Requirement: Project workflow position reflects current durable facts

FREE SHALL derive a Project Context's workflow position and its Pilot
Extraction, Batch Extraction and Validate steps from the current Schema
Revision's stabilisation, the latest Extraction per Source Document and its
review, and Source Document staleness, not from "any Extraction was ever
reviewed".

#### Scenario: Editing an approved schema restarts piloting

- **WHEN** a researcher has reviewed a pilot against one Schema Revision and
  then saves a new Schema Revision with no stabilisation
- **THEN** the Project Context still shows Pilot Extraction as current, states
  that the new Revision needs its own reviewed pilot, and does not offer the
  collection run as the next step

#### Scenario: A newer unreviewed run is not fully validated

- **WHEN** a Source Document's latest Extraction is unreviewed, or its latest
  Extraction is pinned to a Source Representation Revision older than the
  current one
- **THEN** the Project Context is not shown as fully validated, its workflow
  position does not mark Validate done, and its next step names the pending
  pilot or review

#### Scenario: A reviewed current pilot advances to batch

- **WHEN** every member of a pilot Batch Extraction against the current Schema
  Revision has been reviewed and no newer unreviewed or stale work exists
- **THEN** the Project Context shows Pilot Extraction done and Batch Extraction
  as the current step

#### Scenario: The stepper shows one current position

- **WHEN** a Project Context page renders the workflow steps
- **THEN** exactly one displayed step is current, and the "Next" control names
  and opens the step that is actually next

### Requirement: Pilot guidance and the offered action agree

FREE SHALL NOT offer a pilot-workflow action whose target state contradicts
the gate that governs it, and SHALL keep approval and reuse claims tied to the
revision and selection the server will actually admit.

#### Scenario: Skipping the pilot is not offered when the gate needs it

- **WHEN** the chosen Schema Revision has no stabilisation and the selection is
  collection-scale
- **THEN** the prepare screen offers the pilot or the approval flow, not a
  "run the full collection" action that the gate immediately refuses

#### Scenario: An in-place schema edit updates the approval state

- **WHEN** a researcher edits a schema in the batch prepare screen and that
  save appends a new Revision with no stabilisation
- **THEN** any "approved for batch extraction" banner is cleared, Run is gated
  against the new Revision, and the collection gate evaluates that Revision

#### Scenario: A reuse claim matches server behaviour

- **WHEN** the client marks a Source Document as reusing an already reviewed
  result
- **THEN** the server admits that run without producing a new Extraction for
  that Source Document, or the client does not make the claim

### Requirement: Review progress counts reviewable members consistently

FREE SHALL count pilot review progress against the members that can be
reviewed on every surface, so a failed or unreviewable member never leaves the
progress indicator permanently short of its own completion criterion.

#### Scenario: A pilot with a failed member reports reviewable progress

- **WHEN** a pilot Batch Extraction contains a failed or unreviewable member
  and every reviewable member is reviewed
- **THEN** the document tab bar reports that the reviewable members are
  complete, matching the review grid's fully-reviewed state

### Requirement: Project activity summary reflects durable native reviews

FREE SHALL count a finalized durable interactive review in the Project
Context's activity summary, so the project workflow position advances after a
native pilot review exactly as it does after a stored review.

#### Scenario: A finalized native review advances the project

- **WHEN** a researcher finalizes the review of every member of a native pilot
  Batch Extraction against the current Schema Revision
- **THEN** the Project Context's reviewed count and workflow position reflect
  that finalization after the project summaries refresh
