## Why

When `extractWithModel` wraps the schema in evidence envelopes (`{value, snippet, page}`), the model consistently returns `snippet: null, page: null` for every field because there is no prompt instruction requiring it to fill those fields. As a result `splitEvidenceResult` finds no valid evidence, evidence highlights are never drawn, and the snippet-anchored search path in `EvidenceHighlightLayer` is never exercised.

## What Changes

- A mandatory evidence-field instruction is injected into every structured-extraction prompt so the model knows it **must** set `snippet` to a verbatim excerpt from the document and `page` to the 1-based image index.
- Caller-supplied `instruction` text is appended after the system evidence instruction (not replaced).

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `nuextract-request-construction`: Add requirement — when the extraction mode is `structured`, a built-in evidence-field instruction MUST be prepended to the instructions block, mandating non-null `snippet` and `page` values.

## Impact

- `api/_model.ts` — `extractWithModel` constructs a combined instruction string before calling `generateWithNuExtractRawPrompt`.
- No API surface or schema changes — callers pass `instruction?` as before; the evidence instruction is injected transparently.
- `splitEvidenceResult` starts receiving non-null snippets → evidence highlights become functional.
