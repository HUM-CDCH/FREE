# Model configuration changes

## MODIFIED Requirements

### Requirement: Each Researcher Account has one durable configuration
FREE SHALL store one configuration per Researcher Account in PostgreSQL:
connections, the Interaction and Schema Suggestion Routes, the Extraction Model
Choice, the Ingestion Model Choice, and advanced extraction preferences. It
SHALL NOT store any key there. An account that never applied reads the empty
configuration, with no advanced overrides. `GET` and `PUT /api/model_config`
SHALL read and replace only the signed-in account's configuration; applies for
one account serialize on its row. FREE MUST NOT import or fall back to `AI_*`
settings. Advanced preference writes SHALL preserve the existing configuration
validation and browser-only key boundaries.

#### Scenario: A fresh account reads an empty configuration
- **WHEN** a new Researcher Account calls `GET /api/model_config`
- **THEN** it receives an empty valid configuration with no keys or advanced overrides
- **AND** no value is imported from `AI_*` settings

#### Scenario: A second account reads none of the first's configuration
- **WHEN** one account applies a configuration and a second account reads its own
- **THEN** the second account sees only its own configuration, including advanced choices

#### Scenario: Two applies from one account serialize
- **WHEN** two complete configuration writes for one account overlap
- **THEN** they serialize on that account's row and the last committed whole draft is authoritative

#### Scenario: A stored document that fails validation is a 500 that echoes nothing
- **WHEN** a stored configuration fails validation on read
- **THEN** the endpoint returns HTTP 500 without echoing its contents
- **AND** no reset is offered or performed

#### Scenario: Existing valid configuration survives migration
- **WHEN** the advanced-configuration forward migration runs on an existing account
- **THEN** model connections and choices remain intact and advanced overrides are empty
- **AND** no historical Extraction is assigned guessed settings

### Requirement: The Model Configuration page follows the researcher's work
The page SHALL have Models, Connections and Advanced tabs sharing one draft,
one Apply and one Discard. Models SHALL have three steps: *Reading documents*
(the Ingestion Model Choice), *Schema & chat* (the *Assistant model*, which is
the Interaction Route; Schema Suggestion follows it until given its own route,
and an explicit Schema Suggestion route stays explicit even when equal to it),
and *Extracting data* (the Extraction Model Choice). "Use defaults" SHALL remove
a step's stored choice. There SHALL be no Single/Routes mode. Advanced SHALL
configure future extraction methods without running an Extraction or changing
the model/provider choices in other tabs. Invalid advanced settings SHALL block
the whole Apply with visible field errors; switching tabs SHALL retain the draft.

#### Scenario: An unset Schema Suggestion route follows the Assistant model
- **WHEN** the Assistant model is chosen and the Schema Suggestion route is unset
- **THEN** the page shows Schema Suggestion following the Assistant model

#### Scenario: An explicit route stays explicit across a reload
- **WHEN** the Schema Suggestion route is explicitly saved equal to the Assistant model
- **THEN** reloading the page retains that explicit choice

#### Scenario: Use defaults removes the stored choice
- **WHEN** a researcher chooses Use defaults for a model step and applies
- **THEN** that step's explicit route or model choice is removed from the saved configuration

#### Scenario: A manual model ID is displayed
- **WHEN** GET returns a route with a manually entered model ID
- **THEN** the page displays that exact ID even when discovery omits it

#### Scenario: Changes survive tab switching and discard together
- **WHEN** a researcher changes Models and Advanced, switches tabs, then discards
- **THEN** the edits remain visible until Discard restores the saved whole draft
- **AND** no extraction model call or configuration write occurs on tab switching

#### Scenario: Apply fails
- **WHEN** saving a valid changed draft fails
- **THEN** edits remain in the draft, saved state remains unchanged and a visible error explains the failure
