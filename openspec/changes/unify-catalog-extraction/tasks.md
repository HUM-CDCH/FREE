## 1. Freeze the contract and evaluation protocol

Gate: agreed examples and evaluation rules before tuning. These are planning
tasks for implementation; no checkbox is marked complete by writing this plan.

- [ ] 1.1 Refresh `dev`, PR #150 and the active numbered-catalogue/sample-workbench changes; record the implementation baseline and integration responsibilities without overwriting concurrent work.
- [ ] 1.2 Characterize generic document/record/grounding clipping and recipe document clipping with executable late-source examples; capture golden v1/v2 artifacts (scripted models and fixed clock/metadata), settings, review and export fixtures before changing shared helpers.
- [ ] 1.3 Define the unified Catalog method discriminator/defaults version and v3 result schema in shared TypeScript/Python fixtures, including atomic execution/discovery records and their digests, primary ranges/Unicode whitespace, continuation observations, literal versus nonliteral support, exact item-occurrence identity, partial cardinality and unverified document fields.
- [ ] 1.4 Register a publication-family evaluation manifest with separate development/holdout data, human boundary/field/evidence labels, known cross-window partial items, applicable legacy baselines, exact per-family quality/partial-rate tolerances, cost/latency and two role-correct model configurations. Count partials as unresolved without excluding expected items from recall denominators. Freeze before evaluation; never apply the numbered recipe outside its supported family.
- [ ] 1.5 Specify numeric limits and versioned defaults for input Auto/custom ceiling, stage/role reply reserves, overlap (including zero), heading context and verification; specify bounded recovery and context-omission policies. Record which defaults are engineering choices and which have measured support.

## 2. Implement general discovery and source accounting

Owners: Parsing Service `kie/extract/catalog.py`, new private discovery/accounting
modules as needed, reusable range/window utilities. Gate: scripted end-to-end
discovery artifact with no recipe dependency.

- [ ] 2.1 Define general entry identity and canonical range ownership without modifying the frozen legacy numbered `Block` meaning; preserve optional printed labels and table/cell geometry.
- [ ] 2.2 Implement token-fitted discovery requests using the actual reasoning tokenizer, complete source coverage and validated intra-segment boundary references; support multiple records on one line or in one parser segment.
- [ ] 2.3 Reconcile overlap and two-sided begins/ends-inside-entry observations across windows, including overlap zero, repeated boundary text, restarted labels and cross-page entries; unknown/disagreeing/failed neighbors leave the affected head/tail unresolved rather than assigning them to the previous entry.
- [ ] 2.4 Atomically publish and validate write-once `catalog-discovery.json` under the Extraction ID, referencing its execution-record digest and complete dependencies; equal repeats are no-ops, conflicting writes fail, recovery reuses only validated records. Include the exhaustive ledger and disable cross-extraction reuse.
- [ ] 2.5 Add deterministic tests for unnumbered/non-Latin entries, dense tables, nested lists, multiple entries per segment, very long units, withheld source, reading-order uncertainty and discovery response overflow/failure.

## 3. Process and reconcile all Catalog source text

Owners: Catalog implementation, `windows.py`, source validation and candidate
modules. Gate: complete v3 artifacts through the service entry point with scripted
models, while public admission remains on the old version.

- [ ] 3.1 Adapt the pure window fitter for complete entry/document primary ranges, preserving raw offsets and cell identity through whitespace/code-point subdivision; re-count final rendered requests and explicitly refuse an unfittable minimum request.
- [ ] 3.2 Replace document-prefix extraction with an independent partition of every admitted nonblank range, including front matter/nonrecord/unresolved entry regions; collect document candidates across all windows, preserve conflicts, and track document processing separately with explicitly unverified field status.
- [ ] 3.3 Implement schema-driven candidate extraction and separate source-reading verification without recipe keys or field-name bindings; preserve literal-value spans versus supporting spans for nonliteral values and verification-Off proposals.
- [ ] 3.4 Characterize and adapt merging for accepted/proposed/mixed candidates, scalar alternatives and nested arrays. Deduplicate only matching validated item occurrences with equal structure/values/leaf support and one-to-one correspondence; do not join complementary partial objects. Expose observed/resolved/partial counts and test shared headings, first-leaf collisions and within-observation multiplicity.
- [ ] 3.5 Batch candidates into counted verification requests with stable candidate IDs and partition on overflow; count arbitration, bound retries/subdivision, retain all unresolved competitors and report supplemental-context omissions without clipping primary text.
- [ ] 3.6 Apply deployment concurrency to unified entries with deterministic assembly for identical observations; check cancellation before each call/window and before publication. Do not introduce per-window durable steps in this change.
- [ ] 3.7 Test late-only fields after 24k characters, late document metadata, huge cells, output-truncated boundary/array replies, wrong-entry evidence, all-failed windows and no-record results; assert honest completeness and exact canonical support.

## 4. Connect versioned methods, artifacts and recovery

Owners: `packages/extraction`, Parsing Service options/worker, Studio API/shared
contracts and persistence only where the final contract requires it. Reader
support lands before any v3 writer can be enabled.

- [ ] 4.1 Add v3 decoding/acceptance and result mapping in `kei-artifact.ts` and review/export consumers; retain v1/v2 readers and reject source/schema/method/model/option mismatches.
- [ ] 4.2 Extend `extraction-method.ts`, stored descriptors, single/batch admission identity and reuse with the unified version, requested overrides, versioned defaults and frozen budget policy. Preserve tolerant legacy account decoding and refuse new Catalog admissions refreshably until required preference migration is applied; add only necessary additive storage/migrations.
- [ ] 4.3 Update handoff/dispatch; atomically publish write-once `catalog-execution.json` before model work, then discovery before extraction. Recover by validated reuse or explicit identity/budget-unhonorable failure; embed records/digests in v3 for existing artifact acceptance. Preserve the durable step sequence and include sidecars in existing lifecycle cleanup.
- [ ] 4.4 Isolate unchanged legacy execution and its dependency closure for admitted work; use frozen helpers or golden scripted-output proof before sharing a changed module. Distinguish old-ID replay, actual recovery, fresh Run again and stale new requests. Never reinterpret character limits.
- [ ] 4.5 Add cross-language fixtures and guarded PostgreSQL/recovery tests for settings changes, batch snapshots, stale intent, old-ID replay and rollback. Cover crashes before/after each sidecar publication, after discovery/before result, concurrent recovery, identity mismatch, changed serving capacity and cancellation/retired-method handling.

## 5. Deliver one Catalog configuration and run flow

Owners: Studio `App.tsx`, `providerConfig`, `savedMethod`, `MethodUsed`, Results
and batch preparation plus configuration/API contracts. Gate: new single and batch
runs show the same method and settings, with no recipe choice.

- [ ] 5.1 Replace Generic/Recipe controls with the five-control inventory; update draft/default behavior, field-addressed shape validation, explanations and tests. Actual token fit is checked where serving metadata exists and surfaced per member as a budget/settings refusal, not a fabricated browser preflight or provider error. Keep schema meanings and models in their existing editors.
- [ ] 5.2 Remove the Catalog recipe selector and new-request recipe list from single-run controls; update single/batch start summaries and Run again to display the unified method version.
- [ ] 5.3 Implement visible legacy migration through draft/Apply; explain retired character/glossary/recipe choices without guessed conversion, preserve old keys until Apply and replace the Catalog branch atomically. Block new single/batch Catalog admission refreshably until migration, keeping Article/history usable.
- [ ] 5.4 Display accounting, processing and evidence separately, including unresolved source ranges, omitted supplementary context and unverified document fields; keep historical method labels and review/export behavior truthful.
- [ ] 5.5 Run browser scenarios for untouched defaults, custom knobs, invalid requests, migration/cancel/apply, old results, failed windows, lost-response replay and single/batch parity; verify keyboard errors and narrow-layout usability.

## 6. Evaluate, cut over and retire the split

Gate: mechanical correctness plus preregistered held-out quality. Missing live
models or independent labelled documents leave the cutover gate open.

- [ ] 6.1 Run the relevant parser, extraction and Studio suites, workspace typecheck/lint, guarded database/recovery checks and browser/service scenarios; record commands, revisions, failures and scope rather than claiming unrun tiers.
- [ ] 6.2 Execute the frozen held-out protocol on two role-correct configurations; report boundary/field/evidence quality, partial-item rate and unresolved/processing coverage per family, plus per-stage calls/tokens/latency including document fields. Use applicable baselines; do not tune on the holdout or hide partials from denominators. Excessive partial rates fail the preregistered gate rather than relaxing identity rules.
- [ ] 6.3 Exercise schema-name/printed-label perturbations and adversarial array/continuation cases; verify that no recipe, corpus name, field-name binding or provider-specific default selects a different active algorithm.
- [ ] 6.4 Publish the evaluation and defaults manifest; enable new unified admission only after the gates pass. Freeze old admission and inventory queued/running/retrying/suspended legacy jobs before the drain; document a rollback that retains v3 readers/workers for admitted work.
- [ ] 6.5 After legacy resumable work is drained or explicitly settled, remove the old Catalog executors, recipe picker and dead runtime recipe imports; preserve historical readers and research/regression fixtures. Prove that retries cannot silently execute a retired method under new semantics.
- [ ] 6.6 Update root/service README, CONTEXT.md, configuration explanations and the active related changes' status in coordination with their owners. Record the final durable decision with the next available ADR number, validate/sync the completed specifications and archive only after implementation/evidence are complete.
