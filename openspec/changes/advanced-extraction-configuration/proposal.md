# Advanced extraction configuration

Status: pre-implementation specification, 2026-09-28. Based on checkout
`4e2a5820`. No product implementation is authorized by this artifact.

## Why

The Parsing Service exposes independently configurable extraction and grounding
methods, but Studio only forwards strategy, recipe and model choices. Humanities
Researchers need to try supported combinations through a small, understandable
configuration surface, with explanations that distinguish evidence mechanics
from measured quality.

## What Changes

- Add an **Advanced** tab beside Models and Connections, sharing the existing
  draft, Apply and Discard. Account-owned choices affect future Extractions.
- Expose Article context, identity, prompt, rendering, selection, grounding,
  scheduling, routing and schema-policy controls; expose recipe Catalog factors
  and budgets, and generic Catalog character limits in a collapsed section.
- Show short explanations beside controls and an on-demand guide with worked
  examples, source-range/table diagrams and carefully scoped study findings.
- Make every supported combination reachable, reject incompatible combinations
  explicitly, and distinguish settings saved for a strategy from the strategy
  selected when starting an Extraction. This is manual experimentation, not an
  automatic Cartesian-product runner.
- Freeze the active method at single/batch admission; include it in equality,
  replay and result metadata. Show requested and effective settings without
  reconstructing historical runs from today's account configuration.
- Retain schema ownership of per-field evidence policies. The configuration
  chooses whether Article verification honors those policies; it never rewrites
  an Extraction Schema.

## Capabilities

### New Capabilities

- `advanced-extraction-configuration`: supported controls, explanatory UI,
  validation, immutable method admission and honest result attribution.

### Modified Capabilities

- `model-connection-configuration`: extend the account-owned configuration and
  existing shared-draft page with the Advanced tab.

## Impact

Future implementation crosses Studio's configuration contract/editor and
extraction HTTP handlers, the extraction package's method/admission mapping,
and PostgreSQL's existing configuration and Extraction/Batch Extraction records.
The Parsing Service remains the owner of extraction policy and final request
validation. Existing experiment code is evidence and test input, never a serving
dependency. No new service, provider framework or runtime dependency is proposed.

Non-goals: implementing now, changing extraction defaults or algorithms, resuming
deferred studies, configuring historical protocol versions, automated sweeps,
claiming causal accuracy gains from link counts, or rebuilding schema editing,
provider configuration, source ingestion or review.

Read [design.md](design.md) for the detailed UI specification and ownership
decisions; [verification.md](verification.md) defines acceptance of a future
implementation and records verification of this specification.
