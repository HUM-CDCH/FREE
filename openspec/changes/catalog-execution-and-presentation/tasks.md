## 1. Contracts and field sources

- [x] 1.1 Extend strict strategy, attempt, diagnostic, persisted-payload, and reopen contracts for Catalog.
- [x] 1.2 Add top-level-only `valueSource` validation, subtree partitioning, deterministic overlay, and package-origin grounding exemptions.
- [x] 1.3 Update Article to honor the shared field-source contract without adding another values call.

## 2. Canonical boundary resolution

- [x] 2.1 Implement the pure exact heading-label resolver and end-exclusive canonical boundary representation.
- [x] 2.2 Cover unknown, duplicate, non-heading, ambiguous, non-monotonic, nested, terminal-peer, and document-end cases.

## 3. Catalog orchestration

- [x] 3.1 Factor the existing lifecycle into one shared orchestration shell with strategy-specific Article and Catalog execution.
- [x] 3.2 Implement optional document extraction, one discovery call, ordered record calls, deterministic assembly, and one final assembled-result grounding pass.
- [x] 3.3 Enforce the 100-record constant, ordered `not_attempted_limit` diagnostics, partial-success semantics, zero automatic retry, and cancellation with no partial result.
- [x] 3.4 Persist and reopen self-contained stage/record diagnostics, strategy, completeness, route attribution, and pins.
- [x] 3.5 Add explicit immediate-parent Catalog child retries for selected failed components, reuse provenance, current-route attribution, fresh full grounding, and no copied review state.

## 4. Studio presentation

- [x] 4.1 Add an Article-default strategy selector beside Extract and submit the selected strategy.
- [x] 4.2 Render successful partial records under an Incomplete banner without placeholders.
- [x] 4.3 Show stage/record summaries directly and technical diagnostics in expandable details.
- [x] 4.4 Restore the result-first layout and move diagnostics and Catalog retries behind one collapsed, height-bounded disclosure.
- [x] 4.5 Restore explicit nested-result navigation with Root, ancestor breadcrumbs, Back/Forward, and Clear-to-root controls.

## 5. Acceptance gates

- [x] 5.1 Add deterministic contract and server tests for call scheduling, field overlays, grounding exemptions, ordered partial assembly, failure states, cancellation, and 100-record truncation.
- [x] 5.2 Add real Vite + disposable PostgreSQL + fresh-browser lifecycle coverage for Catalog complete, partial, discovery failure, record failure, truncation, cancellation, review finalization, and reopen.
- [x] 5.3 Run the existing Article lifecycle suite and verify the one-call Article behavior remains intact.
- [ ] 5.4 Manually smoke one Article and one Catalog through each configured provider; block release on calls, completeness, boundaries, and grounding correctness, while reporting tokens and latency without a hard budget.
