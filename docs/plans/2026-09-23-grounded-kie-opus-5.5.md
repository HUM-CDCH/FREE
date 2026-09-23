# Grounded catalogue KIE: implementation plan for Opus 5.5

Date: 2026-09-23. Status: **proposed implementation plan; work below is not complete**.
Target workspace: `/home/gennaro/projects/FREE`, branch `feat/kei-exp-parser`.
Baseline inspected: `b07741d0b258612fdda5d4104940ea34a446d78f` plus the existing
uncommitted prompt-version-4, fixture, launcher and validation changes.

This is the execution plan for the user's *grounded KIE for long scanned
catalogues* design. It does not replace the original research objectives or
claim that the service-consolidation milestone completed them. Its immediate
deliverable is a working, measurable numbered-catalogue pipeline in FREE;
annotation, calibration and generalization have separate completion gates.

## Instructions to the implementing agent

Read this document in full, then implement the milestones in order. Carry each
milestone through its acceptance checks and record the actual result before
moving on. Preserve the current working tree, including changes you did not
author. Do not reset, automatically commit, push, open a PR, or deploy to
production. This handoff does not launch Opus or authorize additional agents.

Use ordinary Python functions and the existing API/worker/Procrastinate flow.
Do not build a workflow framework, stage registry, another frontend, or a queue
and database table for every conceptual stage. Do not spend the next increment
tuning Qwen discovery prompts: the target segmenter uses source structure and
explicit rules. The current LLM discovery is an interim baseline.

Keep implemented, tested and measured distinct. A passing two-record PDF test
does not establish catalogue coverage, extraction accuracy, or OCR quality.
Missing annotations are a real limit: build the annotation/evaluation machinery
and report the missing evidence instead of manufacturing labels or scores.

Required reading, in order:

1. [Repository instructions](../../AGENTS.md), [README](../../README.md),
   [domain vocabulary](../../CONTEXT.md), [contribution rules](../../CONTRIBUTING.md).
2. [Parsing Service README](../../prototypes/parsing_service/README.md),
   [its instructions](../../prototypes/parsing_service/CLAUDE.md), and
   [Studio instructions](../../prototypes/studio/CLAUDE.md).
3. [Ownership decision](../adr/0009-own-parsing-and-extraction-service-in-free.md).
4. [Frozen model/ingest design](../../prototypes/parsing_service/docs/superpowers/specs/2026-09-14-kie-model-and-ingest-design.md)
   and [canonical evidence design](../../prototypes/parsing_service/docs/superpowers/specs/2026-09-21-canonical-evidence-design.md).
5. The current section of the [consolidation handoff](../validation/2026-09-22-service-consolidation-handoff.md)
   and [validation record](../validation/2026-09-22-monorepo-service.md).

The original supplied plan is locally available at
`/home/gennaro/.codex/attachments/82ea9d40-e4fa-43cf-9f02-dc2bf322002f/pasted-text.txt`.
This document summarizes the decisions needed to execute without that attachment.
Preserve the original; record necessary amendments explicitly.

## 1. Starting point and target

The backend now belongs to FREE under `prototypes/parsing_service/src/kei_exp`.
Studio owns authentication, Project Contexts, schemas, persistence and review;
the backend owns parsing, segmentation, extraction and evidence verification.
Do not resume implementation in a sibling kei-exp checkout.

| Area | Current state | Target for this plan |
| --- | --- | --- |
| Parsing | Ingest/spread splitting, Surya/native adapters, immutable page files and geometry exist | Preserve them and connect the correct page interpretation to Studio uploads |
| Discovery | Qwen selects whole-passage `starts` and `end`; prompt version 4 | Source-backed entry spans, heading events, explicit unresolved boundaries |
| Evidence | Segment identity plus a segment box | Raw-text spans, key/heading provenance, honest geometry precision |
| Extraction | One call per discovered group; grounding afterwards | Bounded entry context, compact heading state, glossary subset, verified candidates |
| Merge | Combines record, document and filename fields | Primary ownership, continuation repair, heading inheritance, competitors |
| Review | Evidence navigation and durable review already work | Preserve those flows; add rejected-candidate and later calibrated-confidence views |
| Evaluation | Synthetic cases and integration tests | Labelled boundaries/fields, coverage, accuracy, cost and held-out evaluation |

Useful baseline evidence: 32 focused extraction tests and the local real-model
service E2E passed; Spark passed a generated native page and its scanned version.
The revised discovery prompt scored 30/34 on development cases A–Q: case Q's
continuation survived, but case N misclassified German headings without an
issue. These results are not the segmenter's acceptance benchmark.

### Current integration hazards to address first

- `prototypes/studio/api/source_documents.ts` explicitly sends `page_source=pdf`.
  Importing the spread splitter did not make the Studio upload path use it.
- `kie/model.py` defines `Span`, `Block` and `HeadingEvent`, but the current
  `kie/extract/run.py` consumes `Passage` groups and does not use those structures
  to segment records.
- There are two ID namespaces. `kie/evidence.py` constructs book-page IDs using
  one-based per-unit counters. `kie/extract/evidence.py` and Studio use physical
  PDF page IDs with zero-based canonical segment indexes. Both look like
  `pN_sM`; string resemblance is not proof of identity.
- Surya currently supplies block boxes. Exact character offsets in text do not
  imply exact character boxes on the image.
- The generic FREE schema and Catalog strategy must not silently become a
  fixed German archaeological schema. The proposed 20-field schema is a
  research fixture until the user confirms it.

## 2. Scope and decisions

### Delivery boundaries

**First delivery, milestones M0–M6:** canonical evidence → reading order and
source routing → entry segmentation → bounded extraction → verification and
heading inheritance → reviewable grounded results in FREE. Prove two entries
inside one canonical segment, continuations across columns/pages, and headings
before and between entries. Then assess the full supplied catalogue.

**Later deliveries, M7–M10:** richer normalization, measured sub-line geometry,
annotated evaluation, scheduling/resampling experiments, calibrated confidence,
and an independent catalogue. They remain part of the plan, not prerequisites
for writing the first segmenter. Do not call the overall plan complete at M6.

Docker image/build completion is a separate consolidation concern. Finish the
relevant packaged checks before claiming a deployable result, but do not replace
the catalogue work with another infrastructure rewrite.

### Resolve these contract details in M0

Write a compact design next to the service's current contracts, and update an
active OpenSpec change if available. `docs/` may retain this dated execution
record under CONTRIBUTING.md; unresolved product decisions belong in an active
change or an issue, not an untracked to-do list. Do not create a remote issue
or publish anything without authorization.

1. **Supported input and generic Catalog cutover.** The first segmenter targets
   numbered catalogues. Keep content rules in one small, versioned structural
   recipe: entry marker syntax, heading syntax, section/ending rules and
   explicit schema-field bindings. No PDF names, fixed page counts or Beier
   coordinates in algorithms. FREE's existing generic Catalog behavior is a
   product contract: do not silently route every schema through German rules.
   Specify how a researcher/source selects the numbered-catalogue recipe before
   production cutover. If this needs a new product setting, settle that decision
   before changing the default; core segmentation can proceed independently.
   Avoid a permanent `use_new_pipeline` toggle or automatic LLM fallback.
2. **Coverage.** Amend the literal “every OCR line belongs to an entry” rule:
   every relevant source interval must have exactly one disposition—primary
   entry content, heading, glossary/reference/figure material, excluded content
   with a reason, or unresolved content. Only primary entry content has an entry
   owner. Context overlap confers no second ownership. Non-record material must
   be accounted for instead of forced into an entry.
3. **Numbering.** Preserve printed labels and suffixes (`31`, `31a`). Apply
   sequence checks to candidate boundaries, not as permission to discard text.
   Defer gaps and ambiguous nested numbering until the complete sequence is
   available; report unresolved gaps/duplicates without inventing missing
   records. Use the frozen `(entry_no, entry_suffix)` identity initially. If a
   real source restarts numbering by section, specify scoped identity explicitly
   before changing that contract.
4. **Evidence identity.** Internal book-page spans resolve through the existing
   `EvidenceRef(generation, page, index)` to the canonical page file and Studio
   anchor. For example, internal `p2_s1` may resolve to physical page 1/index 3,
   hence Studio's `p1_s3`; it must never be sent as `p2_s1` by assumption.
   Generation and digest remain mandatory. Do not rewrite canonical OCR text
   or renumber segments to accommodate the segmenter.
5. **Offsets and geometry.** All text spans are half-open Unicode code-point
   ranges over the original canonical segment text. They are neither Markdown
   byte offsets nor JavaScript UTF-16 offsets. Normalization must retain a
   mapping back to raw spans. Use existing physical-PDF transforms for display.
   Keep boxes explicitly coarse until actual line/character alignment exists;
   do not divide a block box by character count to fabricate precise geometry.
6. **Rejected candidates.** The target Catalog result contains verified accepted
   fields; failed candidates remain available separately for review with their
   reason and proposed evidence. Map a rejected singular field to null in the
   accepted record. Preserve raw text, proposals and review history. FREE's
   existing explicit-ungrounded historical results remain readable; implement
   the new semantics as a versioned result contract, not silent rewriting.
7. **Completeness.** Separate processing success, boundary/coverage accounting,
   accepted-value grounding and empirical recall. No `complete: true` when
   required coverage is unresolved or a call was truncated. Complete internal
   accounting is still not proof that OCR captured every printed entry.

The existing `Document` remains an in-memory view. Persist one immutable
segmentation artifact containing references, spans, roles and diagnostics, not
another transcript. Bind it to source generation/digest and all semantic
segmentation settings. Extraction additionally binds schema, model, prompts,
tokenization/budget settings and normalization rules. Do not make the
schema-independent segmentation cache depend on a changed field schema unless
a structural recipe actually uses schema-dependent decisions.

## 3. Implementation milestones

### M0 — Baseline, contract and reproducible fixtures

Primary files: `kie/model.py`, both evidence readers, `kie/extract/run.py`,
`packages/extraction/src/kei-exp.ts`, `prototypes/studio/api/_kei_exp.ts` and
`source_documents.ts`; read their existing tests before adding replacements.

- [ ] Record the live Git state and preserve all existing modifications.
- [ ] Freeze the decisions above, including the generic Catalog cutover boundary
  and a concrete versioned wire example for spans, candidates and diagnostics.
- [ ] Locate the user-provided full Beier PDF and any reusable canonical run;
  record source SHA-256, parse generation and recipe. Do not fetch a substitute
  PDF or transmit research material to an external service.
- [ ] Create small synthetic/recorded fixtures for the acceptance matrix below.
  Reproduce the same-segment limitation in the old path and preserve that result.
- [ ] Preserve the current LLM discovery implementation/prompt as an offline
  baseline fixture when it is replaced. Do not maintain a hidden production
  fallback merely to keep the baseline executable.

Exit: fixtures and expected source boundaries are inspectable; the target
artifact contract and supported-input selection have no implicit ID conversions.
Absent real PDFs block real-catalogue acceptance, not synthetic implementation.

### M1 — One trustworthy evidence view and explicit page interpretation

Primary files: `kie/evidence.py`, `kie/extract/evidence.py`, `kie/model.py`,
`geometry.py`, `pagefile.py`, `kie/runner.py`, `api.py`, `jobs/`, Studio upload
and parser adapters. Extend the existing projection rather than making a third
text store.

- [ ] Give the extraction view access to canonical references, book-page units,
  reading-order metadata, raw text, parser labels and honest geometry precision.
- [ ] Resolve every internal span to a canonical physical-page segment before
  returning evidence to Studio. Test both halves of a spread on the same PDF
  page, including nontrivial placement transforms and rejected segment indexes.
- [ ] Specify and wire source layout selection: single PDF pages versus scanned
  spreads. Persist/fingerprint that choice, including any gutter overrides.
  Do not force every landscape page or native PDF through the spread splitter.
- [ ] Preserve native list-marker evidence where Docling makes it available;
  recover printed markers from source-backed parser data, never fabricate them
  from record position. Changes to canonical text create a new parse generation.
  Missing/unrecoverable markers must remain visible uncertainty.
- [ ] Preserve the existing physical-PDF-page evidence navigation and old source
  representation revisions when adding the book-page interpretation.

Exit: native, single scanned page and two-page spread fixtures resolve all
evidence to the correct original PDF region. No identity collisions, silent
coordinate-space conversions, or reuse against a mismatched generation.

### M2 — Reading order, source roles and heading events

Suggested new functions belong in `kie/stages/layout.py` and `route.py`; reuse
the existing Docling/Surya layout and cutting code before adding detectors.

- [ ] Establish left/right book-page order and column order from existing
  geometry. Use a measured whitespace rule only where the parser does not
  already provide adequate order. Keep thresholds normalized to geometry.
- [ ] Derive text-line views only from available source text/HTML/line metadata,
  preserving raw offsets. A block-level box is not a line box.
- [ ] Classify source intervals/regions as entry content, headings, glossary,
  prose, figures/captions or references; allow mixed-role pages. A page-level
  “bibliography” label must not discard an entry above it.
- [ ] Emit `HeadingEvent`s with evidence spans and structural scope. Parser
  labels are hints: a SectionHeader can be a real record title, and a Text
  block can be a grouping heading. Encode the selected recipe's semantic rules.
- [ ] Parse the document glossary once into verified key/expansion spans.
  Ambiguous or malformed entries remain diagnostics. Pass only relevant entries
  to later extraction, with an explicit token allowance.
- [ ] Identify overlapping OCR observations and account for potential duplicates
  without deleting canonical evidence or collapsing separate repeated text on
  text equality alone.

Exit: fixtures exercise two-column order, headings mixed with entries, final
references, figures and duplicate OCR observations. Region exclusion is explicit
and visible in coverage accounting.

### M3 — Entry spans, sequence checks and coverage

Add the segmenter in `kie/stages/segment.py`, using the frozen `Span`, `Block`
and `HeadingEvent` types. A suitable interface is a pure function from the
verified ordered evidence view plus structural recipe to blocks, coverage and
diagnostics; it must not call a model or write files.

- [ ] Detect entry-start candidates within segments, retaining exact offsets.
  Two numbered starts in one segment must create two blocks without splitting
  or rewriting that canonical segment. Use real line/structural boundaries;
  an incidental number in prose is not automatically a record start.
- [ ] Resolve candidate starts with numbering, suffixes, indentation/available
  layout and paragraph context. Distinguish nested finds from new entries.
- [ ] Assign each accepted primary interval once and attach a bounded two-line
  context window on either side. If reliable line boundaries are unavailable,
  use a documented bounded text window and record that limitation.
- [ ] Continue the same entry across column, book-page and PDF-page boundaries.
  Heading events change subsequent inheritance; they do not become blank records.
- [ ] Preserve and report orphan prefixes, uncertain starts, numbering gaps,
  duplicate identities, ambiguous resets and unexplained excluded intervals.
  Never silently discard them to satisfy a `1..N` assertion.
- [ ] Publish/load the immutable segmentation artifact atomically, reusing
  existing hashing/publication helpers. No new queue or mutable “current block”.

Exit: the acceptance matrix passes with zero model calls for segmentation;
ownership/coverage invariants hold; invalid cached artifacts are refused; a
re-run produces equivalent boundaries and does not repeat OCR.

### M4 — Bounded extraction, verification, inheritance and repair

Primary files: `kie/extract/run.py`, `stages.py`, `schema.py`, `llm.py`.
Introduce small stage modules only when they own substantive logic; keep one
readable orchestration path.

- [ ] Consume the segmentation artifact in Catalog extraction. Each call sees
  one entry's primary spans, marked context, approved schema, relevant glossary
  and bounded state. Continue to support the existing Article strategy.
- [ ] Carry current heading evidence and a bounded unresolved continuation tail
  in source order. Do not accumulate previous entries' text in the prompt.
  Whole-document coverage indexes can grow on disk/in memory; prompt state cannot.
- [ ] Bind inherited fields explicitly through the recipe and approved schema.
  The most recent valid heading supplies the value and evidence; an occurrence
  of `Kreis` in an entry body must not overwrite that state. Parent-heading
  changes clear obsolete child-heading state according to the recipe.
- [ ] Request candidates with raw value, cited spans and key provenance
  (`token`, `positional`, or `inherited`). Validate IDs, bounds, eligible source
  role, substring/normalization mapping, key context and field types in code.
  A matching word anywhere in an entry is insufficient evidence for every field.
- [ ] Preserve raw and normalized values separately. Accepted inherited values
  cite their heading; context-only candidates cannot be emitted twice merely
  because two calls saw the same overlap.
- [ ] Reject unsupported candidates from accepted fields while preserving them
  for review. A model's assertion that a passage supports a value does not
  replace source verification. Never mark an unsupported inferred box exact.
- [ ] Resolve continuation fragments by ownership first. Conflicting verified
  candidates remain competitors; arbitrate only over those candidates and
  their bounded snippets, with a null/unresolved outcome available.
- [ ] Enforce an actual input-token limit, initially 4096 including instructions,
  schema, examples, context and glossary, plus an explicit output allowance
  fitting the server context. Use the deployed model's verified tokenizer;
  character counts are not an enforceable token budget. Version the budget.
- [ ] For an oversized entry, process bounded evidence windows under the same
  entry identity and merge verified candidates. If the schema/system portion
  alone exceeds the budget, return a specific diagnostic before a model call.
  Do not truncate away unseen text and claim success.
- [ ] Preserve non-thinking requests for the current Qwen deployment and all
  call/error/cost provenance. Add adaptive resampling only in M9, after the
  single-sample baseline is measured; do not silently erase failed attempts.

Exit: cross-page inheritance and continuation work with scripted completions
and a real local model; rejected values remain reviewable; no model call exceeds
its configured input budget. Exact text spans with coarse boxes are explicitly
a partial implementation of R2 until M7 supplies measured finer geometry.

### M5 — Versioned API, Studio evidence and durable jobs

Primary files: `api.py`, `jobs/tasks.py`, `jobs/store.py`, `runs.py`,
`packages/extraction/src/kei-exp.ts`, `parsed-document.ts`, Studio extraction
contracts, evidence UI and the relevant `packages/db` artifact/review code.

- [ ] Version the extraction result for span evidence, rejected candidates,
  competitors and coverage diagnostics. Update Python validation, TypeScript
  decoding, persistence and fixtures together; an API field that the client
  silently strips is not implemented product behavior.
- [ ] Keep the canonical physical-page anchor as the stable navigation target;
  attach raw-text spans and precision metadata. Handle Python code-point,
  JavaScript UTF-16 and Markdown byte offsets explicitly at their boundaries.
- [ ] Show accepted fields, rejected proposals and unresolved source coverage
  clearly in the existing Results/review flow. Preserve valid existing reviews,
  stale-source/schema behavior and ownership checks. Never fabricate a calibrated
  confidence number from a boolean `complete` flag.
- [ ] Keep parse/extraction generations immutable. Schema edits rerun extraction
  against the pinned parse; segmentation is reused only when its complete
  semantic key matches. A normalization/profile change invalidates affected
  results even if OCR text is unchanged.
- [ ] Preserve atomic terminal job/event publication, retryable database
  unavailability, exclusive worker ownership and restart recovery. Provisional
  streamed tokens never become canonical evidence. No page-resume controls in
  this increment.
- [ ] Cut over the agreed numbered-catalogue behavior only when contracts and
  existing supported-input regressions pass. Remove replaced runtime discovery
  code for that scope; retain its measured baseline only in evaluation fixtures.
  Any continuing generic Catalog policy must be explicit, not a hidden fallback.

Exit: authenticated upload → parsing → segmented Catalog extraction → evidence
navigation → review → restart works against real API/worker/PostgreSQL. History
remains readable without rewriting accepted old artifacts.

### M6 — Full-catalogue acceptance and Phase 1 exit

- [ ] Run the full supplied catalogue through the real scan/spread path. Record
  source hash, hardware, model/tokenizer, recipe, timing, calls and token totals.
- [ ] Inspect boundaries across columns/pages, nested numbered finds, heading
  changes, suffix entries, glossary and bibliography. Use the coverage ledger
  to locate losses and duplicate ownership rather than guessing from totals.
- [ ] Have a reviewer label boundaries on 20 stratified pages. Measure block-F1
  with a frozen matching definition; report boundary/interior breakdowns and
  every numbering/coverage exception.
- [ ] Complete the planned OCR comparison on labelled lines and record the
  engine choice. Existing Surya integration alone is not an OCR bake-off.
- [ ] Verify complete source accounting and expected printed entry identities
  against inspected ground truth. If expected coverage is unknown, report it
  as unknown rather than using the algorithm's output as its own gold standard.

Exit: the original Phase 1 gate is evidenced—full sample segmented, expected
entries accounted for, block-F1 measured on 20 annotated pages. If labels are
missing, stop the claim at “implementation ready for boundary annotation”; keep
the next data-independent work moving.

### M7 — Normalization and measured geometry

- [ ] Add recipe-specific, tested normalization for map sheets, coordinates,
  inventory identifiers, citations and verified glossary expansions. Preserve
  the raw source values. Singular/plural field conflicts remain explicit.
- [ ] Obtain real line/character alignment where the engine supports it. Store
  alignment provenance, bind it to the correct generation and test transforms
  on scans with rotations/crops. Do not retrofit guessed character boxes.
- [ ] Add the bounded crop re-read path for unresolved/fuzzy candidates only
  after measuring its benefit; retain both readings and their provenance.
- [ ] Complete evidence cards showing value/key/heading evidence, precision,
  competitors and verification reasons in the existing Studio UI.

Exit: typed values and localization are evaluated on labelled examples. Report
segment-level and character-level localization separately; unavailable fine
geometry is not a passing sub-line IoU result.

### M8 — Annotation set and baseline evaluation (original Phase 2)

- [ ] Prepare 200 entry annotations, 20 boundary pages and 20 OCR-transcribed
  pages; oversample boundary entries as the original plan specifies. Store
  source references and spans, not only copied strings. Pre-fill may assist
  annotators but cannot stand in for human correction.
- [ ] Obtain second-annotator review on 20% and report agreement. Confirm or
  replace the proposed archaeological schema before labelling all 200 entries.
- [ ] Freeze train/calibration/test partitions before tuning, grouping related
  pages/sections to reduce leakage. Keep development cases A–Q out of claims
  about independent evaluation.
- [ ] Implement field exact/normalized F1, free-text NED, citation F1, complete
  record accuracy, boundary/interior recall, localization, hallucination,
  grounded fraction, coverage/duplicates, heading accuracy and stage cost.
- [ ] Run the S1-equivalent pipeline and a gold-boundary oracle to distinguish
  segmentation error from extraction error. Record that M4's sequential
  functional implementation is not itself the planned S1/S3 comparison.

Exit: corrected labels, agreement figures and reproducible baseline metrics.
No “98% precision” or calibrated confidence claim before held-out measurement.

### M9 — Scheduler, resampling and confidence experiments (Phases 3–4)

- [ ] Compare parallel-then-repair, sequential sweep and section-parallel sweep
  with identical inputs, models and budgets. Do not assume a Python sequential
  loop proves stateful scheduling quality. Measure forward/reverse/shuffled
  section sensitivity without changing canonical reading order.
- [ ] Add adaptive K=3 only on the defined verification/missing-field trigger.
  Count every call, preserve competitors and distinguish agreement from proof.
- [ ] Implement B1 page-chunk, B2 page-VLM and bounded five-page B3 comparisons;
  measure infeasibility at full length rather than asserting it from a name.
- [ ] Run one-factor-at-a-time ablations for glossary, state, overlap,
  verification, repair, schema exclusions, OCR and model size. Choose the
  extraction model from measurements; Qwen3:8b is currently an integration
  baseline, not the plan's evaluated 32B/30B default.
- [ ] Fit confidence on labelled calibration data and evaluate on held-out data.
  Keep uncalibrated scores visibly uncalibrated. Report ECE, precision and queue
  size at the chosen thresholds; order review by an explicitly stated policy.
- [ ] Run the 100-field evidence necessity/sufficiency study and measure reviewer
  time. Benchmark the full target workload on the stated GPU before claiming
  under-one-hour throughput; the original cost figures are hypotheses.

Exit: measured scheduler/model choices, held-out confidence results, ablations,
faithfulness results and a hardware-specific cost table.

### M10 — Independent catalogue and final acceptance (Phase 5)

- [ ] Evaluate a second catalogue without adding its expected answers to prompt
  examples or hard-coding its page layout. Record recipe changes separately
  from results obtained with the frozen recipe.
- [ ] Preserve the native-PDF path already present in FREE; extend its fine
  evidence geometry as needed rather than disabling it to follow the old
  “born-digital later” ordering literally.
- [ ] Report every original success target: coverage 1.0/zero duplicates;
  token-keyed F1 >0.9; finds/literature F1 >0.8; heading accuracy >0.98;
  boundary recall within 3 points of interior; hallucination <0.5%; grounded
  fraction >0.98; review queue <15% at 98% precision; order spread <1 F1 point;
  full 200-scan workload under one hour on the 4090. Distinguish missed targets
  from unavailable measurements. Attach uncertainty/sample sizes where relevant.

Exit: an honest comparison with the original success criteria. Completing
implementation does not turn a missed research target into a pass.

## 4. Minimum acceptance matrix for M1–M5

| Fixture or fault | Required observation |
| --- | --- |
| Two entries in one OCR segment | Two primary span sets; disjoint ownership; same immutable canonical segment |
| Entry crosses a column, page or spread | One entry identity and preserved reading order; all field evidence resolves |
| District heading before entries and between entries | Correct inheritance and heading evidence; no heading-only record |
| Parent heading changes | Old child heading does not leak into the new section |
| Record title labelled SectionHeader | Retained when content/recipe identifies it as an entry |
| Nested `1.`/`2.` finds | Kept in their parent entry; not promoted solely by regex |
| `31a`, a numbering gap, duplicate label, reset | Printed label retained; supported cases resolved; ambiguous cases explicitly reported |
| Final continuation followed by references | Continuation retained; bibliography excluded and accounted for |
| Unnumbered/stripped native items | Source-backed markers restored or an explicit unsupported/uncertain result; no invented numbers |
| OCR overlap with repeated text | Duplicate observation distinguished from genuinely repeated content |
| No records | Explicit no-record outcome; no invented empty entry; no misleading complete catalogue |
| Mixed-role page or ambiguous orphan | No silent whole-page drop; unresolved content prevents a coverage-complete result |
| German `ß`, combining characters, ligatures, hyphenation | Normalized matching maps to valid raw code-point spans and correct UI text selection |
| Same value in unrelated fields | Field/key context is checked; token occurrence alone does not accept the wrong field |
| Oversized entry/schema/context | Bounded processing or explicit refusal before exceeding the token budget |
| Stale generation, corrupt page hash, invalid span | Refused before model calls/publication; no invented evidence |
| Crash during publication, worker/API restart, database outage | No partial accepted artifact; existing authoritative lifecycle/retry semantics preserved |
| Two researchers with identical PDFs | No cross-account source, result or review access |
| Changed schema, profile, model or rules | Correct fingerprint/cache invalidation without unnecessary OCR reruns |

Tests should assert behavior, source ownership and failure consequences. Avoid
tests that merely repeat a constant or assert that a particular regex exists.
Keep model-backed experiments outside fast deterministic unit tests.

## 5. Verification and reporting

Use focused checks after each change. Broaden to the following tiers when the
implemented surface warrants them; do not rerun every expensive tier after a
documentation-only edit.

```bash
# Existing fast backend suite; add the new stage/coverage tests to this suite.
pnpm --filter parsing-service test
pnpm --filter extraction test
pnpm typecheck
pnpm lint

# Isolated real API/worker, native parser, PostgreSQL and authenticated browser.
pnpm test:service

# Real model: obtain the currently running endpoint rather than assuming a port.
FREE_REAL_EXTRACT_URL=http://127.0.0.1:PORT/v1/chat/completions \
FREE_REAL_EXTRACT_MODEL=MODEL pnpm test:service
```

For lifecycle/persistence changes run the existing guarded PostgreSQL and
recovery tiers using the target rules in README. For UI/review changes run the
relevant ordinary browser cases; for Compose/launcher changes run safety checks
and sequential image builds. Run the final bloat audit and `git diff --check`.
Do not count stale saved logs as tests of newly changed code.

Extend the real-service fixture to exercise a heading, a within-segment split,
a continuation and inherited evidence. Keep exact result assertions. Add a
scanned/spread workflow when claiming that path works; native parsing alone
cannot establish it. Record scripted-model results separately from real-model
results, and browser/review checks separately from backend-only probes.

Resource notes are observations, not permanent configuration:

- Last local successful real-model run needed `OMP_NUM_THREADS=2`,
  `MKL_NUM_THREADS=2`, `OPENBLAS_NUM_THREADS=2` under host contention; initial
  database readiness and upload attempts failed. Preserve those boundaries and
  inspect current resources instead of weakening tests.
- Spark's development stack was left running at
  `baratheon.cdch-dgxspark.lan.ku.dk:/home/geba/Projects/FREE`. Its API/worker
  containers contain copied prompt-v4 source; their images were not rebuilt for
  that change. Verify live state before reuse. Earlier authorization covered
  those specific copies/restarts, not arbitrary future deployments or data
  transfers. Prepare reviewable changes before any required new approval.
- Do not stop unrelated workloads or globally prune Docker/cache storage.
  Generated test projects may be cleaned up by recorded IDs; preserve useful
  research evidence and the user's existing databases.

At each milestone record: source/commit and working-tree state, implemented
behavior, exact commands, passed/failed/skipped checks, artifact paths,
unresolved defects and the next gate. Update the consolidation handoff only
with current evidence; keep its original snapshot clearly historical.

## 6. Completion checklist for the handoff

- [ ] M0–M5: working numbered-catalogue vertical slice, full evidence identity
  preservation, explicit coverage, verified accepted fields and durable review.
- [ ] M6: full-catalogue segmentation and original Phase 1 exit measurements.
- [ ] M7–M8: normalization/localization evidence and corrected annotation set
  with baseline metrics.
- [ ] M9–M10: experimental comparisons, calibrated review and independent
  catalogue results; every original target reported without inflated claims.
- [ ] Packaged images/startup validated for the configurations actually claimed.
- [ ] Remaining unsupported input families and data-dependent work are explicit;
  no hidden old/new fallback paths, synthetic confidence, or silent text loss.

**Start with M0 and M1. The first algorithmic acceptance target is M3's
two-records-in-one-segment fixture, followed by heading inheritance and a
cross-page continuation. Do not substitute another prompt comparison for it.**
