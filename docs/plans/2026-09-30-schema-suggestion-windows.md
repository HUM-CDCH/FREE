# Schema Suggestion reads the whole source (Option B)

Status: in progress on `feat/schema-suggestion-windows`. Plan drafted by Codex (gpt-6.1-sol) as sparring partner.

Why: since `b07741d0` no `<!-- FREE:PAGE N -->` markers exist, so a source over 48,000 characters sends only its
first and last ~23k characters to Schema Suggestion; the "Suggested from excerpts" notice reports the loss. Batch
merges also drop suggestions past 48,000 characters ("uncombined"). Option B windows the whole source, UNION-reduces
per source and INTERSECTION-reduces across sources, so new suggestions read every character.

Loop protocol: one iteration per loop turn — fail-first test, implement, `pnpm -s typecheck` + the listed tests,
commit, Codex review of the commit (fix findings), tick the box. Iteration 9 is manual and stops the loop.

Defaults taken for the open decisions (change here to override):
1. Oversized reducer input or a level that cannot progress: explicit failure.
2. Conflicting UNION fields: the model reconciles into one supported shape.
3. Beier acceptance: semantic equivalence with Schema Revision 6; naming differences recorded.

## Progress

- [ ] 1. Deterministic source windows
- [ ] 2. One model call separated from source preparation
- [ ] 3. Bounded hierarchical reduction (UNION / INTERSECTION)
- [ ] 4. Full-source single generation behind a DBOS patch
- [ ] 5. Full-source batch members behind a DBOS patch
- [ ] 6. Hierarchical intersection replaces dropping batch merges
- [ ] 7. Guard provider truncation
- [ ] 8. Recovery, checkpoint privacy, historical notices
- [ ] 9. Real Beier validation (manual / needs-user)

### 1. Add deterministic source windows

- **Goal:** Introduce `schemaSourceWindows(markdown)` alongside the legacy excerpt helper.
- **Files:** `api/_schema.ts`, `api/_schema.test.ts`.
- **Fail first → pass:** A source containing `UNIQUE_MIDDLE_FIELD` beyond 48,000 characters produces bounded, contiguous windows whose concatenation exactly equals the original.
- **Verify:** `pnpm -s typecheck`; `pnpm -s vitest run api/_schema.test.ts`.
- **Done:** Stable half-open offsets; no gaps, trimming, or added source text; one window for a fitting source. Cover page markers, oversized pages, unmarked text, and Unicode boundaries. Keep the legacy helper available for replay.

### 2. Separate one model call from source preparation

- **Goal:** Extract a one-call primitive from `suggestSchema`, so orchestration can send an exact window without excerpting it again.
- **Files:** `api/_schema_suggestion.ts`, `api/_model.test.ts`.
- **Fail first → pass:** The primitive sends a supplied window unchanged, including its middle marker, in exactly one model call.
- **Verify:** `pnpm -s typecheck`; `pnpm -s vitest run api/_model.test.ts`.
- **Done:** Preserve parsing, mandatory `_description`, instruction, temperature, cancellation, and general/NuExtract execution. Existing fitting-source behavior remains one call. Leave legacy `generateSchemaWithModel` behavior available until patched workflows select the new path.

### 3. Add bounded hierarchical reduction

- **Goal:** Introduce a shared reducer supporting explicit **UNION** and **INTERSECTION** modes.
- **Files:** `api/_schema_suggestion.ts`; `api/_schema_reduction.ts`, `api/_schema_reduction.test.ts` (**new**).
- **Fail first → pass:** Inputs exceeding one reduction request form multiple levels, with every leaf represented and every serialized request within budget.
- **Verify:** `pnpm -s typecheck`; `pnpm -s vitest run api/_schema_reduction.test.ts api/_model.test.ts`.
- **Done:**
  - UNION retains fields found in any window and chooses one coherent `_description`.
  - INTERSECTION retains the existing `MERGE_INSTRUCTION` semantics.
  - Budget includes labels, separators, and serialized schemas; reserve space for guidance.
  - Each model invocation goes through a supplied step runner.
  - Singleton groups carry forward unchanged; empty intersections remain empty.
  - Oversized individual schemas or a level that cannot make progress fail explicitly. Never truncate, drop an input, or loop indefinitely.

### 4. Enable full-source single generation behind a DBOS patch

- **Goal:** Window and UNION-reduce single-source suggestions durably.
- **Files:** `api/_schema_generation_workflow.ts`, `api/_schema_generation_workflow.test.ts`, `api/_schema_suggestion.ts`, `server/workflows.ts`.
- **Fail first → pass:** Crash before window two, then replay: window one is reused, later windows and UNION complete, and the outcome declares `{ complete: true }`.
- **Verify:** `pnpm -s typecheck`; `pnpm -s vitest run api/_schema_generation_workflow.test.ts api/_model.test.ts api/generate_schema.test.ts`.
- **Done:** Patch decision precedes the changed sequence. Legacy branch preserves `generateSchema` and its old behavior. New windows and reductions have stable indexed step names and fresh `MODEL_OPERATION_TIMEOUT_MS` signals. Markdown is reread from the pinned revision outside checkpoint outputs. Fitting sources skip UNION and still make one call.

### 5. Enable full-source batch members behind a DBOS patch

- **Goal:** Give each batch member the same window-plus-UNION treatment.
- **Files:** `api/_batch_suggestion_workflow.ts`, `api/_batch_suggestion_workflow.test.ts`, `api/_schema_suggestion.ts`, `server/workflows.ts`.
- **Fail first → pass:** A multi-window member contributes a field found only in its middle; replay reuses its completed window suggestion and publishes complete source coverage.
- **Verify:** `pnpm -s typecheck`; `pnpm -s vitest run api/_batch_suggestion_workflow.test.ts api/_batch_schema_suggestions.test.ts`.
- **Done:** Keep legacy `suggestSource:<id>` replay behavior. New step names include member, window, or reduction coordinates. Check attempt state before every model call; combine cancellation with a fresh timeout. Preserve first-failure handling, missing-key handling, store retries, and conditional publication.

### 6. Replace dropping batch merges with hierarchical intersection

- **Goal:** Make the new batch path include every per-source suggestion.
- **Files:** `api/_schema_suggestion.ts`, `api/_schema_reduction.ts`, `api/_schema_reduction.test.ts`, `api/_batch_suggestion_workflow.ts`, `api/_batch_suggestion_workflow.test.ts`.
- **Fail first → pass:** Combined suggestions exceed 48,000 characters, and the final member lacks a candidate field; the hierarchical result excludes that field and reports every member `combined: true`.
- **Verify:** `pnpm -s typecheck`; `pnpm -s vitest run api/_schema_reduction.test.ts api/_batch_suggestion_workflow.test.ts`.
- **Done:** Each intersection call has its own checkpoint and timeout. Successful new runs have no `uncombined` members. Empty common schemas publish `HETEROGENEOUS`. Oversized inputs fail visibly rather than publishing a partial common schema. Retain old `mergeInput` only for the legacy branch.

### 7. Guard provider truncation

- **Goal:** Reject truncated output and add the cheapest supported protection against Ollama silently shortening input.
- **Files:** `api/_provider.ts`, `api/_provider.test.ts`, `api/_model_execution.ts`, `api/_model.test.ts`.
- **Fail first → pass:** A mocked length-terminated response containing syntactically valid schema JSON is rejected instead of becoming a successful suggestion.
- **Verify:** `pnpm -s typecheck`; `pnpm -s vitest run api/_provider.test.ts api/_model.test.ts`.
- **Done:** Check generic and NuExtract finish reasons, including the `NoObjectGeneratedError` recovery path. At Ollama’s existing call-scoped fetch boundary, characterize and test a supported input-overflow rejection mechanism. If unavailable, document the limitation and the characterized window/context envelope. Do not infer complete input from `prompt_eval_count` alone or silently retry with excerpts. Preserve cancellation and anonymous-key behavior.

### 8. Verify recovery, checkpoint privacy, and historical notices

- **Goal:** Close the replay and compatibility boundary before real-model validation.
- **Files:** `api/schema_generation.postgres.test.ts`, `api/batch_suggestion_workflow.postgres.test.ts`, existing workflow unit tests, `src/sourceCoverageNotice.test.ts`, `src/projectContexts/BatchExtractionsPanel.test.tsx`.
- **Fail first → pass:** A PostgreSQL recovery scenario resumes after a completed window and reduction without repeating either, then publishes once.
- **Verify:**
  - `pnpm -s typecheck`
  - `pnpm -s vitest run api/_schema_generation_workflow.test.ts api/_batch_suggestion_workflow.test.ts src/sourceCoverageNotice.test.ts src/projectContexts/BatchExtractionsPanel.test.tsx`
  - `pnpm -s vitest run --config vitest.postgres.config.ts api/schema_generation.postgres.test.ts api/batch_suggestion_workflow.postgres.test.ts`
- **Done:** Actual DBOS history contains IDs and model suggestions, no raw source text or keys. Exercise patched and pre-patch recovery. Historical omitted ranges, `combined: false`, and absent coverage still render honestly; new successful outcomes show neither notice. Keep `studio@1`. PostgreSQL checks use caller-provisioned disposable `free_test_*` databases under README restrictions.

### 9. Real Beier validation — **manual / needs-user**

- **Goal:** Check model quality and operational cost against the retained canonical source.
- **Files:** `docs/validation/2026-09-07-beier-user-test.md`; a dated Option B validation record (**new**).
- **Fail first → pass:** Manual acceptance probe starts unmet: an Option B suggestion must complete against Source Representation `12ed88db-d3fa-4b1d-8b7b-92b88ca3c856`, read every window, and pass the six-field comparison.
- **Verify:** `pnpm -s typecheck`; `pnpm -s vitest run api/_schema.test.ts api/_schema_reduction.test.ts api/_schema_generation_workflow.test.ts api/_batch_suggestion_workflow.test.ts`; then the authenticated real-model probe.
- **Done:** Compare with Schema Revision 6, `32860369-2d89-4031-93bd-af016cda089d`:
  - catalogue label;
  - locality/findspot;
  - FA code;
  - find description;
  - repeated museum/inventory passages;
  - repeated references.

  Check one `_description` defining complete parent entries, the selected catalogue scope, and exclusions. Confirm complete coverage and no excerpt notice; exercise a batch containing Beier and confirm every member is combined. Record model, context settings, window/reduction counts, elapsed time, and semantic differences. Preserve the prepared schema and extraction. User involvement supplies the live stack/model and judges schema adequacy; this is not an extraction rerun.

