## Why

Whole-proposal Apply or Discard is safe but too coarse when a useful schema-chat proposal contains one unwanted node change. Researchers need to accept or reject each affected node without changing the immutable proposal preview or weakening the existing atomic Apply boundary.

## What Changes

- Give every id-addressed proposal row one acceptance decision, initially accepted.
- Keep rename and retype changes for the same node under one decision, while added groups and their added children remain independently decidable.
- Recompute an accepted-subset replay from the original schema after every decision without changing proposal rows.
- Apply only the currently accepted, materialisable changes; Discard still leaves the original schema unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `schema-chat-edit`: Pending proposal review gains per-node acceptance and deterministic replay from the original schema.
- `schema-inline-diff`: Diff rows expose acceptance controls while retaining stable proposed values and suppressing direct schema-edit controls.

## Impact

The Studio schema-change derivation/replay logic, SchemaPanel review state, and focused unit/component tests change. The schema-edit API and model contract do not change.
