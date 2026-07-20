## Why

The main evidence-highlight contract still describes value-string selection and double-painted active highlights, while the merged Studio uses result paths and a single deterministic paint. The contract must match the duplicate-safe behavior that is now implemented and tested.

## What Changes

- Select evidence by result path so equal values in different fields remain independent.
- Paint normal, active, and dimmed highlights once at explicit opacity levels.
- Prefer model-provided evidence snippets and page hints, with direct extracted-value search as a fallback.
- Include string, number, and boolean leaves when evidence text is available.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `evidence-highlight-layer`: Replace value-based focus and double painting with path-based focus, deterministic single painting, and evidence-aware text lookup.
- `result-tracing`: Thread result paths through selection and provide an explicit clear-selection action.

## Impact

This reconciles the existing `EvidenceHighlightLayer`, result-path click plumbing, Results clear action, paint helper, and regression tests with the repository's main OpenSpec contracts. It does not change the public extraction API.
