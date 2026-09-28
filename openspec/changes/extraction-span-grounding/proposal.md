# Proposal

## Why

Article grounding currently verifies every populated scalar against every source unit,
even after finding support. Generated quotes also force four-claim batches and repeat
source text in model output. The user proposed selecting source spans, explicit schema
evidence policies, and retrieval with exhaustive fallback to reduce this work.

## What Changes

- Add a separately fingerprinted Article span-selection verifier that materializes exact
  quotes and canonical parent/cell references server-side. Retain subject attribution.
- Expose independently controlled unresolved-claim filtering and schema evidence policy.
  Derived and deliberately unverified fields remain visible; neither becomes verified.
- Route verification through recorded extraction-origin hints and deterministic retrieval,
  with exhaustive fallback for unresolved claims. Record attempted and omitted units.
- Register a new grounding comparison with fixed upstream records. Preserve all frozen
  R1/R2a/R3/R4 manifests, source archives, captures, running jobs and reporting ownership.
- Evaluate request cost and source-location validity separately from semantic support.
  Human-reviewed claim/source pairs remain a required gate for semantic quality claims.

## Capabilities

### New Capabilities

- `span-grounding`: Source-span selection, explicit evidence eligibility, auditable
  verification scheduling and controlled grounding comparisons.

### Modified Capabilities

None. Existing canonical Evidence Anchor ownership and schema persistence contracts
remain in force. Extraction-local span choices resolve to existing canonical parents;
they do not create a competing persisted evidence identity system.

## Impact

Parsing Service extraction stage assembly, grounding, method fingerprints, schema
validation and experiment reporting; matching TypeScript schema transport where policy
metadata is introduced. No new service, queue, remote model change, database migration
or production default. MiniCheck and learned dense retrieval remain follow-up options
requiring separately pinned models; this first revision uses existing providers.
