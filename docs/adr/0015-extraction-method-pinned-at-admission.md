# 0015: Extraction Method pinned at admission

Date: 2026-09-29. Status: accepted; amends 0011 (the Extraction Model Choice is
submitted with each start, not applied from the account per request); amended
by [0017](0017-durable-extraction-control-and-call-checkpoints.md) (the pin
applies to each durable input selection).

## Context

The Parsing Service exposes independently configurable extraction and grounding
methods, and Humanities Researchers need to try them from Studio. Before this
change, Studio applied the account's Extraction Model Choice to every request
at the moment it was made, and forwarded nothing else. With more choices, that
pattern would let queued or recovered work run on settings saved after it was
started. It would also leave a run's details unable to say which method it was
admitted with.

## Decision

- **Extraction Method Settings live in the account's configuration.** They are
  part of the one Model Configuration document, as a required
  `extractionSettings` member with one member per strategy (Article; generic and
  recipe Catalog, and the unified Catalog preference where
  `FREE_CATALOG_METHOD=unified`). `{}` means the Parsing Service's defaults.
  They are edited on the page's Advanced tab through the same draft, Apply and
  Discard. They never hold a key and never edit an Extraction Schema.
- **A start submits what it showed.** Every single, batch and suggested-batch
  start sends the Extraction Model Choice and the applicable settings it
  displayed ("Saved advanced settings"). Admission compares them with the
  account's saved ones, in the same transaction that writes the Extraction.
  That transaction takes the Source Document rows first (sorted), then the
  configuration row `FOR SHARE`, so the comparison is ordered against the
  configuration write. A changed method is refused as `method_changed` and
  nothing starts. A repeated request with the same identity replays before
  today's settings are consulted; this includes a batch request that waited for
  an equal one.
- **Execution reads only the pinned method.** The Extraction (and its Batch
  Extraction) records the admitted method, and each durable input selection
  pins it. The Parsing Service captures the effective models, options and
  protocol versions per selection, and call captures carry only that method,
  also after a restart.
- **Batch identity includes the active method.** Equal-selection reuse compares
  the pinned method for the batch's strategy. Settings for the other strategy
  do not affect it.
- **The Parsing Service stays the authority.** Studio's copy of the method rules
  (`packages/extraction/src/extraction-method.ts`) is pinned to the Python
  validator by shared fixtures. The service re-validates every request.

## Consequences

- A start can be refused because the settings changed after its summary was
  shown. Applying in the same page updates open start views, so only a change
  made elsewhere produces this refusal.
- Extraction details show the requested method beside the options and protocol
  versions the Parsing Service reported for that run.
- Equal settings do not promise identical output across runtime revisions.
- A later narrowing of the method contract would leave stored methods it no
  longer parses. Reading them shows "Not recorded", while running on one fails
  only that Extraction.
- Direct API clients must now send the `method` intent with every start.

## Amendment (0017, 2026-10-06)

The [durable-only amendment of ADR 0017](0017-durable-extraction-control-and-call-checkpoints.md#durable-only-amendment)
extends the pin from one admission to each linked input selection: each
selection pins its requested method, and a later immutable selection may be
adopted at a paused boundary. Valid requests admit durable work directly.
