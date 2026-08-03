## MODIFIED Requirements

### Requirement: Behavior-preserving migration of existing wrappers

The existing `requestSchema` function SHALL retain its current call signature and observable behavior. `requestExtraction` SHALL retain its observable behavior for the arguments it already accepted, and MAY gain new trailing parameters (such as `hasTables: boolean`) to support features that did not exist at the time of the JSONL-streaming migration; any such addition SHALL update every call site in the same change, so no caller is left passing a stale argument list. `parseDocumentToMarkdown` MAY change its return type (such as from `Promise<string>` to `Promise<{ taskId: string; markdown: string }>`) when a caller needs data it already resolves internally but previously discarded; its sole call site SHALL be updated in the same change.

#### Scenario: Schema request unchanged for callers

- **WHEN** `App.tsx` calls `requestSchema` with the same arguments as before
- **THEN** it resolves with the parsed extraction schema
- **AND** the function signature is unchanged

#### Scenario: Extraction request signature may grow, call sites move together

- **WHEN** `requestExtraction` gains a new trailing parameter
- **THEN** its existing parameters and resolved value shape (`{ result, evidence }`) are unchanged
- **AND** `useExtraction.ts`'s call site is updated in the same change, so no caller passes a stale argument list

#### Scenario: parseDocumentToMarkdown return shape may grow

- **WHEN** `parseDocumentToMarkdown`'s return type changes to expose data it already resolved internally (such as `taskId`)
- **THEN** its sole caller in `App.tsx` is updated in the same change
- **AND** no other module depends on its previous return shape
