# Modular extraction and controlled ablation study — 2026-09-27

Status: active; implementation and study authorized. This is the durable execution plan.
Task status and evolving design live in `openspec/changes/modular-extraction-ablation-study/`.
Working branch: `feat/modular-extraction-ablation`, based on `6e641b6c11bdf8073f10e824176532885f28484d`.

## Goal and authorization

Implement the researched extraction techniques as understandable, independently testable
pipeline components, then run and report a proper controlled ablation study. The user
explicitly authorizes refactoring pipeline organization so humans can reason about the
architecture. Preserve useful experimental baselines. Continue through implementation,
verification and actual experiments; creating this plan is not completion of the goal.
No production deployment, database reset, remote checkout change or model-service
replacement is implied. Existing configured model endpoints may be used for the study.

## Research contract

Source documents, read on 2026-09-27 at kei-exp commit `4f724dd9d576329e4b8a53c6f25d3da8c84fe319`:

- [Literature](https://github.com/GennaroBaratta/kei-exp/blob/4f724dd9d576329e4b8a53c6f25d3da8c84fe319/docs/literature.md).
- [Original plan](https://github.com/GennaroBaratta/kei-exp/blob/4f724dd9d576329e4b8a53c6f25d3da8c84fe319/docs/plan.md), especially R3, R5 and section 7.
- Existing FREE continuation: `docs/plans/2026-09-23-grounded-kie-opus-5.5.md`.
- Recent repair: `docs/validation/2026-09-26-article-extraction.md`.
- Detailed audit: `/home/gennaro/Documents/Codex/2026-09-26/kei-article-diagnosis/fix/DESIGN-REVIEW-2026-09-27.md`.

Distinguish faithful paper replication, a technique adapted to these documents, and a
new hypothesis. Do not report an adapted component as a reproduced paper result.
Numbered catalogue rules belong to recipes; laboratory-specific instructions belong
to approved schemas. Neither is a universal document assumption.

| Source | Technique to expose | Comparison and diagnostic |
| --- | --- | --- |
| BLOCKIE | Decomposition before local extraction | Page/structural/discovered units; block quality; gold-block oracle when boundary labels exist |
| LMDX | Source identifiers, exact quote/span checking, explicit nulls | Grounding policy and coordinate encoding; unsupported-value rate and localization |
| Tan/CPI | Primary ownership plus overlapping context | Zero versus bounded overlap; boundary recall and duplicates; no claim to replicate supervised SCRI/GEC |
| OCBC KYC | Evidence selection before expensive extraction | Complete-source reference versus bounded selection; source-evidence recall and tokens; lexical selection is not hybrid BM25+embedding replication |
| Multi-VIE | Routing and optional visual reread | Keep document/region routing separate; a visual arm requires an available VLM and measured OCR failures |
| LayIE-LLM | Controlled factor comparisons and typed postprocessing | One-factor changes first, selected interactions second; exact and normalized results separately |
| SchemaRAG | Relevant schema/context subset | Glossary/state on/off; actual schema retrieval only if implemented and independently measured |

## Architectural invariants

1. One canonical source and evidence identity system. All spans reference a pinned parse
   generation and its text; no debug artifacts, duplicate transcripts or invented geometry.
2. Ordinary typed functions with a visible stage order. No plugin framework, extra services,
   second durable queue, or generic graph executor is required by modularity.
3. Article and Catalog are assemblies of explicit stages. Article can join noncontiguous
   evidence; Catalog can own contiguous entries and inherit heading state.
4. Each experimental setting names a real technique and is saved in the result fingerprint.
   The current full-source Article is a named reference arm, not a hidden fallback.
5. Bounded arms count the actual rendered request plus output reserve. Every source unit
   receives a disposition; oversized units, omitted context and unresolved ownership are
   visible. Do not silently clip a document, table, record or model reply.
6. Partial equal attributes do not prove entity identity. Preserve provisional identities
   and distinguish conflicts from duplicates; later extraction must not silently rewrite
   a record into another subject.
7. Keep candidate values, source support and semantic acceptance distinct. Verification-off
   experiments still retain provenance and are scored for grounding independently.
8. Refactor with behavior-preserving checks before changing algorithms. Preserve existing
   API/worker cancellation, generation checks, result paths and authentication boundaries.

## File ownership and implementation sequence

Paths below are under `prototypes/parsing_service/` unless stated otherwise. Adjust a
boundary when code evidence warrants it and record the decision in the OpenSpec design.

### M0 — Freeze the experiment and recovery pointers

- Persist this plan, OpenSpec proposal/design/spec/tasks, and a memory update pointing here.
- Inventory current sources, gold, scorer, schemas, baseline artifacts and model endpoints;
  record hashes and which data have already influenced development.
- Pin the existing six-paper full-source baseline. Never overwrite the prior diagnosis.
- Register every planned arm and comparison before looking at its results. No gold identities,
  counts or values may enter inference. Use document-grouped evaluation partitions.
- Gate: an executable study manifest validates its pins, arm differences and data status.

### M1 — Make stage ownership easy to read

- Reduce `kie/extract/run.py` to loading/dispatch, stage assembly and result publication.
- Separate Article inventory/identity handling from generic Catalog discovery in `stages.py`;
  expose Article orchestration in `kie/extract/article.py`.
- Put bounded source units/context assembly in `kie/extract/context.py`; canonical span
  models remain shared with `evidence.py`/`kie.model`, without a duplicate source store.
- Keep verification, reconciliation and prompt serialization independently callable; extract
  them from oversized modules only where it removes mixed responsibilities.
- Document entrypoints and artifacts in `docs/extraction-pipeline.md`, linked by README.
- Gate: existing tests and fixed-reply baseline outputs preserve behavior, excluding clocks.
- Deletion criterion: moved logic has one owner; remove obsolete definitions/import paths
  once callers/tests migrate. Preserve named research baselines through configuration or
  a pinned historical checkout, never by an undocumented second production implementation.

### M2 — Implement measurable Article variants

- Explicit pipeline configuration, validated and fingerprinted; neutral schema-driven prompts.
- Deterministic bounded units with primary ownership, canonical span references and configurable
  overlap; preserve tables/headers where available and report irreducible overflow.
- Windowed inventory followed by conservative identity reconciliation; explicit identity fields
  and distinct source occurrences. Regression: same-name people remain distinct.
- Evidence context selection combining identity support, nearby qualifiers and relevant shared
  context; record selected/omitted spans. Selection recall is an evaluated outcome.
- Independent grounding policies and candidate handling; record output completeness dimensions
  separately from unmeasured recall and human validation.
- Gate: late evidence, dispersed methods, partial identities, contradictory attribution,
  missing records, table boundaries, schema-only budget refusal and cancellation regressions.

### M3 — Expose existing Catalog techniques to the same experiment contract

- Reuse `recipe.py`, `segmentation.py`, `stages/{layout,route,segment}.py`,
  `extract/{grounded,locate}.py` and `boundaries.py`.
- Independent factors: overlap, glossary, heading context/inheritance and verification.
  Preserve primary ownership regardless of overlap setting; artifact fingerprints cover every
  result-affecting choice. Keep concurrency comparisons separate from semantic changes.
- Gate: removal of one factor changes only that technique; raw candidates remain inspectable.
- Do not claim full sequential-sweep/repair, resampling, VLM or confidence experiments until
  their modules and required data/providers exist. Record those conditions explicitly.

### M4 — Reproducible experiment runner and analysis

- Add `kei_exp/kie/study/` with manifest validation, run execution/capture and metrics/reporting
  as distinct small modules, plus a CLI; study configs under `experiments/extraction/`.
- Record source/schema/code/prompt/module/model/decoding/tokenizer pins, request/reply captures,
  stage costs, complete/failed/refused states, and immutable per-document/per-arm outputs.
- Resume only exact pinned completed cells. Replayed outputs never count as independent
  stochastic repetitions or fresh wall-time observations. Do not mix old and new code silently.
- Keep the original collagen scorer frozen as a secondary compatibility metric. Add generic
  record/observation accounting and adversarial fixtures so extra predictions, omissions and
  false subject assignments cannot disappear behind the gold projection.
- Gate: interrupted-run recovery, changed-pin refusal, no-gold-inference checks, missing-cell
  accounting and hand-calculated metric/statistical fixtures.

### M5 — Freeze and run the controlled study

- Primary comparisons isolate bounded context, overlap, identity reconciliation and grounding;
  Catalog comparisons isolate glossary and heading state. The exact arm count follows verified
  availability and is frozen before live execution, with deviations logged before reruns.
- Use identical source generation, approved schema, serving model and decoding settings across
  each paired comparison. OCR/model/schema changes form separately named experiments.
- Use repeated fresh calls when measuring model variability; temperature-zero repeats measure
  reproducibility, not independent random seeds. Document-level sampling is the statistical unit.
- Execute an admission/preflight check, then the complete manifest. Keep failures in denominators;
  never count a zero exit code or scheduled job as successful extraction.
- Gate: every manifest cell has a terminal status and capture/provenance checks; no selective
  dropping of difficult documents or replacement of predictions after scoring.

### M6 — Report effects, uncertainty and limitations

- Report per-document and aggregate record recall/duplicate rate, populated-field correctness,
  unsupported fills, extra observations, evidence validity, boundary cases, token/call counts,
  stage latency and refusal rate. Separate reviewed semantic labels from exact-match metrics.
- Paired document-level effects and cluster bootstrap intervals; report the very small number
  of documents. Do not treat hundreds of fields as independent replicates. Predeclare primary
  comparisons and apply a multiplicity adjustment if presenting hypothesis-test p-values.
- Test selected interactions only after identifying them as exploratory or preregistering a
  second matrix. Never claim that an OFAT result estimates all interactions.
- Existing six papers and ten examples are development data. Freezing a split now does not
  make already-inspected documents unseen. Report the controlled study honestly on that corpus;
  independent human-adjudicated held-out generalization is a separate acceptance gate.
- If exhaustive gold or boundary labels are absent, report unscored predictions and supply an
  adjudication queue; do not silently invent labels or substitute model agreement for gold.
- Produce a reproducible report under `docs/validation/` with effect tables, exact commands,
  limitations, effective architecture and outstanding gates. Choose a production default only
  from stated acceptance evidence; do not auto-deploy the winning development arm.

## Verification and completion

Run Parsing Service unit/contract tests, focused algorithm/study tests, adapter tests and
typechecking when their contracts change, then required disposable PostgreSQL lifecycle
checks when worker behavior changes. Keep deterministic tests, live model accuracy,
authenticated Studio E2E and crash/recovery evidence distinct. Run bloat audit before delivery.

The goal is complete when the modular implementation is documented/tested, the agreed
controlled study has actually run, and its results and limitations are reproducible. Any
unavailable human labels, provider, compute or integration gate stays explicitly outstanding;
do not mark the goal complete merely because a plan or synthetic test suite is finished.

## Progress and resume

- Automatic follow-up is running from `artifacts/extraction-ablation/follow-study.py`.
  Its PID, script hash, observed R1 process identity and manifest hashes are saved in
  `artifacts/extraction-ablation/followup-20260927/execution-plan.json`; logs and terminal
  command statuses are beside it. It runs R2a only after the parent bounded result exists,
  never starts/resumes R1 generation, and generates analysis/observation reports when the
  R1 launcher exits. An exited launcher or generated report is not proof of a complete
  study: inspect all missing/failed cells before closing the goal. Verify the follower's
  live process before manually running the same R2a source.

- Implementation checkpoint: `d183d4f` on `feat/modular-extraction-ablation`.
  Selector work is isolated at `/home/gennaro/projects/FREE-worktrees/extraction-evidence-selection`
  on `feat/extraction-evidence-selection`, so R1's pinned source stays unchanged.
  The selector and conditional replay runner are implemented; 1007 unit tests passed
  (72 skipped, 68 deselected), and six-source / 88-call reference replay still matches.
  R2a is registered at `artifacts/extraction-ablation/20260927-r2a-selection/manifest.json`.
  Its protocol is `prototypes/parsing_service/experiments/extraction/selection-protocol.md`
  in the selector checkout. It compares raw values with fixed R1 response subsequences,
  not fresh inference or independent generalization. The initial R2 canary was superseded
  by a repeated-request ambiguity guard; never pool R2 with R2a.
  Katrinesminde has passed exact bounded control replay and both R2a arms. Remaining
  sources depend on their R1 bounded captures; neither study is complete.

- Completion audit found two remaining obligations beyond finishing the first matrix:
  observation accounting must expose extra measurements inside matched records, and the M2
  record-specific evidence selector is not supplied by the all-unit bounded baseline.
  `docs/validation/extraction_ablation_accounting.py` now supplies supplementary observation
  accounting, with three independent regression tests. On the old offline Akita fixture it
  exposes nine thermal observations omitted by the gold projection (20 total, 11 selected).
  This does not relabel them as false positives. The focused selector remains an explicit
  unfinished gate and will receive a separately registered comparison; R1 is not being changed.

- Frozen study: `artifacts/extraction-ablation/20260927-r1-manifest.json`; code snapshot:
  `artifacts/extraction-ablation/20260927-r1-code.zip`; execution, captures and logs:
  `artifacts/extraction-ablation/20260927-r1/`. The registered launch order uses two
  concurrent cells and is saved in `execution-plan.json`; timings include possible provider
  contention and are not isolated latency estimates. `launcher.pid`, `progress.jsonl`,
  `logs/`, and `cells/*/result.json` distinguish running, failed and completed work.
  Live inference has started. Do not edit pinned implementation files during this batch.
- Real-tokenizer preflight passed every bounded inventory unit. Full-source Age inventory
  is expected to refuse (34,873 / 34,699 input tokens before output reserve versus a served
  32,768-token context). The bounded Age arm has five units. Keep both refusals in results.
- Verification before inference: 995 parser tests passed, 72 skipped, 68 deselected;
  68 extraction adapter tests passed; typechecking passed; final reference replay preserved
  six sources / 88 calls. An isolated **offline** analysis fixture reproduced 333/374
  populated gold fields and ten unscored extras from old captures; it is not live study data.
- Metric decision after the corpus clarification: the frozen collagen scorer supplies the
  primary document-level accuracy measure because it is the only available adjudicated
  field gold. Generic source coverage, grounding links and costs are diagnostics. Generic
  semantic field accuracy, exhaustive record precision and boundary F1 remain unavailable.

- 2026-09-27 implementation milestone: Article inventory and orchestration moved to
  `article.py`; `method.py` owns validated controls; `contexts.py` owns whole-passage
  partitions and conservative value reconciliation. Reference replay matched six sources
  and all 88 captured calls/artifacts. Experimental controls now cover identity, prompt
  policy, bounded contexts/overlap, and grounding; Catalog controls cover glossary,
  headings, overlap and verification. Stage ownership and commands are documented in
  `prototypes/parsing_service/docs/extraction-experiments.md`.
- Corpus clarification from the user: no independent annotations are available; use the
  example PDFs and validation inputs. The protocol uses the six existing collagen gold
  papers and all ten examples. This is a controlled development study, not a held-out
  accuracy claim. Gold is non-exhaustive; extra predictions remain an adjudication queue.
- Study draft: 79 cells, 16 pinned canonical sources, eight Article assemblies, a registered
  context-by-grounding interaction, three recipe Catalog assemblies and the generic Catalog
  reference. The Ellekilde recipe recognizes standalone `Grav N` headings; glossary and
  inherited-heading factors are not estimable on that excerpt and have scripted tests only.
  Registration/validation/capture/resumption/analysis live in `experiments/extraction/`.
  No fresh model inference has been run for this study at this milestone.

- 2026-09-27: authorized goal created; new branch based on pushed Article repair; architecture
  and research notes inspected. Current code has useful Catalog modules but no complete
  ablation harness. OpenSpec CLI absent on PATH; using an ephemeral CLI invocation without
  changing runtime dependencies. Detailed checklist is in the active OpenSpec change.
- Resume by reading this file, the OpenSpec tasks/design, `git status`, and the latest study
  status artifacts before editing or launching more model calls.
