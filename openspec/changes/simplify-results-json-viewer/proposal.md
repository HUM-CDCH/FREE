## Why

The Results tab is a heavy per-field *review workstation* — roughly 500 lines across `ResultsTab.tsx`, `extraction.ts`, `useExtraction.ts`, and `ExportModal.tsx` implement accept/edit/reject decisions, a pending-field stepper, schema-staleness tracking with decision-preservation across re-runs, and scoped JSON/CSV export. For the current prototype the goal is simply to *see what the model extracted* and iterate on extraction quality. All of that review apparatus is over-engineered for that goal and gets in the way.

## What Changes

- Replace the Results tab review surface with a **read-only, pretty-printed JSON dump** of the latest extraction result (`JSON.stringify(result, null, 2)` in a scrollable `<pre>`).
- **BREAKING** Remove the per-field review workflow entirely: accept / edit / reject / confirm-empty, array row review, and bulk-accept.
- **BREAKING** Remove the pending-field stepper and its navigation.
- Remove schema-staleness and ghost-row tracking, including signature comparison and decision-preservation across re-runs (`preserve*`, `unitState`, `ghostPaths`, stale banner/chips).
- **BREAKING** Remove the export feature entirely — delete `ExportModal.tsx` and the JSON/CSV builders, scopes, and counts.
- Reduce `useExtraction.ts` to: trigger extraction, and expose state (`idle` / `running` / `ready` / `error`), the parsed result, and the streamed raw text for in-flight progress.
- Reduce `extraction.ts` to the minimum needed to request and parse a result; delete `buildRun`, `templateSignatures`, the unit/group type model, `decide*`, `acceptPending*`, `bulkAccept*`, and all export builders.
- Update `RightRail.tsx` results badge (drop pending-count / ✓ done state → a simple has-results indicator) and `App.tsx` button states that depended on review (`needsRerun`, `allReviewed`) plus the `ExportModal` mount.
- **Keep:** the Run extraction action, the running and error states, and the ability to re-run.

## Capabilities

### New Capabilities
- `extraction-results-view`: read-only presentation of the latest extraction result as pretty-printed JSON, including the run / running / error states and behavior when no result exists yet.

### Modified Capabilities
<!-- None. The review/export workflow being removed was never captured in openspec/specs/, so there is no existing spec to delta. -->

## Impact

- **Frontend code (`prototypes/mine/pdf-render/src/`):**
  - `ResultsTab.tsx` — rewritten to a minimal read-only viewer.
  - `extraction.ts` — heavily reduced to the request/parse path.
  - `useExtraction.ts` — reduced to run + state + result + raw stream.
  - `ExportModal.tsx` — deleted.
  - `RightRail.tsx` — results badge simplified.
  - `App.tsx` — remove `ExportModal` mount and review-derived button states.
- **APIs / backend:** none. `requestExtraction` in `api.ts` is unchanged.
- **Tests:** no test files import the deleted `extraction.ts` helpers (`jsonlStream.test.ts` is unrelated), so nothing breaks; remove any review/export assertions only if added later.
- **User-facing tradeoff:** loss of in-app value verification and export. Accepted for the prototype — the JSON can be inspected directly and copied out as needed.
