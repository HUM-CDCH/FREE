# Prompt: run and report the extraction ablation study

Status: reusable execution prompt, written 2026-09-27. Copy the prompt below into
a future coding-agent session. Paths are starting points, not proof of current
state. Completion counts, process IDs and branch heads must be discovered live.

---

You are working on FREE's document extraction pipeline. Run a reproducible,
controlled ablation study of its extraction techniques, analyse the results,
and leave a report that another person can regenerate from the saved artifacts.
Carry the work through execution and analysis. A plan, passing unit tests, or a
few successful example documents is not completion.

You may refactor local code when needed to make the extraction architecture
understandable and the experimental factors independent. Preserve the behavior
of registered baselines. Use the existing configured model services; deployment,
model-service replacement and automatic promotion of an experimental production
default are outside this task. Commit coherent changes and push a research/report
branch. Merge only when the current session explicitly authorizes it.

## 1. Establish the execution mode and current state

Use `resume-existing` when an unfinished registered study already exists, unless
I explicitly request a new revision. Otherwise use `fresh-revision`. State the
mode before generating model responses.

- In `resume-existing`, keep the original manifests, source code, inputs,
  providers and captured responses. Resume only compatible unfinished work.
- In `fresh-revision`, register a new study ID and new output paths before
  observing its outcomes. Never overwrite or silently amend an earlier study.
- A changed implementation is a new experimental revision, not an excuse to
  weaken a pin check. For exact historical reproduction, use the original frozen
  archive. For an evaluation of newer code, freeze that code and rerun both arms
  of each affected comparison. Do not pool the two revisions.
- If another batch is live, identify it and its purpose before launching work.
  Continue a compatible batch, or schedule the new revision after it settles.
  Do not create duplicate cells or exceed the registered concurrency.

Start from these locations, resolving replacements if paths moved:

```text
Repository: /home/gennaro/projects/FREE
Isolated reporting checkout: /home/gennaro/projects/FREE-worktrees/extraction-current-stack
Historical diagnosis: /home/gennaro/Documents/Codex/2026-09-26/kei-article-diagnosis
Study artifacts: /home/gennaro/projects/FREE/artifacts/extraction-ablation
```

Read repository instructions and the actual working-tree state first. Read
`README.md`, `CONTEXT.md`, `CONTRIBUTING.md`, the Parsing Service README and its
local instructions before changing their contracts. Use CodeGraph first for
code exploration where the checkout has a `.codegraph/` index.

Read these authoritative study documents:

- `docs/plans/2026-09-27-modular-extraction-ablation-study.md`.
- `openspec/changes/modular-extraction-ablation-study/`, if still active; otherwise
  follow its archive/superseding change.
- `prototypes/parsing_service/docs/extraction-experiments.md`.
- `docs/validation/2026-09-27-extraction-ablation.md`.
- `docs/validation/2026-09-27-extraction-stack-integration.md`.
- The selection, rendering and grouping protocols in
  `prototypes/parsing_service/experiments/extraction/`.
- `artifacts/extraction-ablation/INTEGRATION-POINTER.md`, then the referenced
  manifests, execution plans, receipts, logs and actual processes.

Treat progress notes as pointers. Confirm Git HEAD/status, code hashes, source
hashes, provider configuration and current process identities yourself. A PID
file or a statement that a job was started does not prove it is still running.

## 2. Keep the research claims accurate

Read the pinned literature review and original design:

- https://github.com/GennaroBaratta/kei-exp/blob/4f724dd9d576329e4b8a53c6f25d3da8c84fe319/docs/literature.md
- https://github.com/GennaroBaratta/kei-exp/blob/4f724dd9d576329e4b8a53c6f25d3da8c84fe319/docs/plan.md
- BLOCKIE: https://arxiv.org/html/2505.13535v1
- LMDX: https://arxiv.org/html/2309.10952v2

Inspect the original papers when justifying a technique. Distinguish a faithful
replication, an adaptation and a new hypothesis. Our typed-block grouping,
literal quote verification and deterministic context selector are adaptations;
they do not reproduce entire published systems, training regimes or benchmarks.
Do not claim that lexical selection reproduces hybrid retrieval, or that source
IDs reproduce coordinate training or stochastic voting.

The historical comparison repository is
https://github.com/HUM-CDCH/FREE-technical.git. Use it to trace earlier extraction
and DocTags behavior, with a recorded commit. Do not assume that converting
DocTags to Markdown preserves tables and their relationships. Inspect actual
canonical blocks, cell positions, spans, captions and footnotes.

## 3. Preserve the corpus and evaluation boundary

Use the repository's example PDFs and the existing validation PDFs. The original
matrix uses six collagen papers with development gold—Akita, Harvey, Mizuta,
Sousa, Wang and Zelechowska—and ten example documents. The examples comprise nine
Article sources and the Ellekilde Catalog excerpt.

There is no independently annotated held-out document set in this task. Some
documents and their outcomes already influenced extraction fixes. Report a
controlled development study. Do not rename these documents a test set, invent
independence by making a new split, or fabricate annotations for the examples.

Keep PDFs, canonical generations, schemas, identity dimensions, gold and scorer
fixed within each comparison. Do not mix an OCR repair with an extraction-method
change. If a canonical source needs correction, preserve the original and
register a separate comparison/revision. The only available field gold is
non-exhaustive: extra records and observations require review; they are not
automatically false positives.

Do not feed gold identities, measurements, scoring decisions or corrected labels
into inference, selection or prompts. Gold belongs only in evaluation.

## 4. Keep the pipeline modular and the evidence intact

Follow the existing stage ownership: canonical evidence → rendering → context
grouping → identity inventory/reconciliation → record-specific selection →
value extraction → grounding → result assembly → evaluation.

Keep ordinary typed functions and explicit stage boundaries. Do not add a plugin
framework, another queue, hidden fallback pipeline or parallel state system just
to expose experimental switches. Serving code must not import experiment runners.

Maintain these invariants:

- Stable source IDs, canonical generation and evidence digest throughout.
- Preserve exact text, Docling labels, page/block IDs and available table-cell
  IDs, row/column positions, spans and roles. Do not invent missing geometry or
  cells. Missing upstream table structure remains an explicit source limitation.
- Treat rendering and grouping as separate factors. Typed markup alone is not
  semantic grouping. Preserve the registered plain-text baseline.
- Keep tables and required adjacent qualifiers intact. Primary ownership must
  be disjoint; overlap and inherited heading context must be explicit and counted.
- Count the actual rendered request with the served tokenizer and reserve output
  tokens. Refuse an oversized atomic group visibly; never silently clip it.
- Merge identities only under the declared rule. Partial matching keys do not
  establish that two records describe the same subject.
- Keep omitted contexts, unresolved identities and conflicting values visible.
- Keep raw values, source links, exact source quotes and semantic acceptance
  distinct. A literal quote or model attribution is not independent entailment gold.
- Preserve literal source characters. Do not manufacture quote matches through
  normalization or repair truncated model output into apparent success.

Validate a refactor with exact baseline replay before changing experimental
behavior. Any algorithm, prompt, decoder, schema or policy change after
registration requires a new revision; never mutate the active study's code.

## 5. Register the matrix before generation

Inspect the actual manifests. The original study family is the following scope;
do not silently replace it with a few convenient examples or a smaller matrix.

### R1: live extraction factors

79 cells: six annotated Article papers × eight methods; nine unannotated Article
examples × three methods; and four Catalog methods on Ellekilde.

Article methods and their controlled differences:

| Method | Definition |
| --- | --- |
| `reference` | Full source, reference identity handling and prompt, semantic grounding |
| `identity` | Reference plus conservative identity reconciliation |
| `schema` | Conservative identity plus schema-derived prompt |
| `bounded` | Schema method with bounded contexts and no overlap |
| `quoted` | Bounded method with literal quoted grounding |
| `full_quoted` | Full-source schema method with quoted grounding |
| `overlap` | Bounded method with one preceding overlap passage |
| `unverified` | Bounded method with grounding off |

Use all eight on the six gold papers. Use `reference`, `schema` and `bounded`
on the nine unannotated Articles. Catalog has generic extraction, the declared
recipe, recipe without overlap, and recipe without verification. Glossary and
inherited-heading effects are not estimable on the current Ellekilde excerpt;
report their contract tests separately instead of claiming a measured null effect.

The nine registered one-factor comparisons are:

```text
reference -> identity             article.identity
identity -> schema                article.prompt
schema -> bounded                 article.context
bounded -> quoted                 article.grounding
schema -> full_quoted             article.grounding
bounded -> overlap                article.overlap_passages
bounded -> unverified             article.grounding
catalog -> catalog_no_overlap     catalog.factors.overlap
catalog -> catalog_unverified     catalog.factors.verification
```

Keep the registered context-by-grounding interaction:
`(quoted - bounded) - (full_quoted - schema)`. Generic versus recipe Catalog is
a multi-component assembly comparison, not an isolated one-factor effect.

### R2a: conditional selection replay

30 cells: all 15 Article sources × `all_units` and `selected`, both with grounding
off. Preserve inventory and retained replies from the corresponding R1 bounded
cell. First reproduce the original bounded requests and stable artifact exactly.
Then accept only an exact monotone subsequence of its captured requests.

An unseen request must fail without live-generation fallback. Repeated identical
requests with different replies are ambiguous and must be refused, not resolved
by choosing a convenient response. Keep single-unit/no-omission documents in
the denominator. R2a estimates a conditional omission/reconciliation effect and
captured request budgets; it is not fresh inference or a latency benchmark.
Do not pool it with the superseded initial R2 canary.

### R3: fresh rendering comparison

12 cells: all six gold papers × plain and structured rendering. Both arms use
full source, conservative identity, schema prompts, no selection and grounding
off. Change only `article.rendering`. Retain all markup-induced context refusals.
This comparison measures rendering, not grouping or grounding quality.

### R4: fresh grouping comparison

12 cells: all six gold papers × token grouping and structural grouping. Both
arms use structured rendering, conservative identity, schema prompts, bounded
12,288-token contexts, zero overlap, no selection and grounding off. Change
only `article.grouping`. This does not estimate the decoder or rendering effect.

The historical R1/R3 archives retain protocol v11; R4 uses v12. Never attribute
differences across those studies to a single factor. For a fresh revision,
hold protocol/decoder implementation constant within every paired comparison.
Do not expand the matrix after seeing results without registering a distinct
follow-up hypothesis and explaining why it is needed.

## 6. Freeze executable source and inputs

Preserve verified byte copies of the registered PDFs, canonical representations,
schemas, evaluation inputs and manifests alongside their hashes. Include an
index of original paths and archive members, and verify each archived member
against its registered hash. For this existing study, the local input recovery
copy is `artifacts/extraction-ablation/input-preservation-20260928.zip`, with its
verification receipt beside it. Restore only after checking destination ownership;
keep active inputs unchanged.

Before generation, pin and save:

- Every source PDF and canonical file, generation and digest.
- Schemas, per-source identity fields, gold, scorer and protocol files.
- Every relevant Python/JSON implementation file and a complete code archive.
- Model IDs, endpoints, observed context limits, tokenizer settings, decoding
  settings, dependency lock/environment and provider image/version when available.
- Method configurations, contrasts, interaction, seeded order, repetitions,
  concurrency and analysis policy for refusals/failures.

The historical configuration uses Qwen/Qwen3.8-27B-FP8 for both roles, greedy
decoding, thinking disabled, a 32,768-token serving context, seed 20260927 and
at most two simultaneous cells. These are historical pins, not assumptions about
the server you find. Verify them. Record unavailable weight attestation honestly.

Execute from extracted, verified source archives outside mutable checkouts.
Set `PYTHONPATH` explicitly, check the imported package path, and validate all
code/input pins from that exact directory. Freeze R2a as well as live-generation
studies. A branch name or an unchanged Git HEAD is not sufficient protection.

Keep the environment interpreter separate from the frozen source directory. For
example, after resolving these paths for the actual run:

```sh
PYTHON_BIN=/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python
SERVICE_SOURCE=/absolute/path/to/verified/frozen/service
MANIFEST=/absolute/path/to/registered-manifest.json
OUTPUT_DIR=/absolute/path/to/new-or-compatible-study-directory
cd "$SERVICE_SOURCE"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$SERVICE_SOURCE/src:$SERVICE_SOURCE"
"$PYTHON_BIN" -m experiments.extraction.study validate "$MANIFEST" "$OUTPUT_DIR"
```

Use `preflight` before fresh generation. Do not overwrite an existing preflight
artifact when resuming. Count the actual rendered prompts and output reserves,
including tables, headings, overlap and markup. A refusal is a legitimate
outcome; do not shorten a source or drop it to obtain a successful result.

Estimate workload before starting: bounded value calls grow with records ×
contexts, and grounding adds further calls. Record the estimate and uncertainty.
Do not present a few fast canaries as an estimate for every paper, or change the
registered method because one paper is slow.

## 7. Use the real registration and execution interfaces

Inspect `--help` and current source before invoking commands. Registration runs
from the chosen implementation checkout before freezing; execution runs from
the verified archive. Reset `SERVICE_SOURCE`, the working directory and explicit
`PYTHONPATH` whenever changing phases. These are the known interfaces, not a
sequence to run blindly alongside an active batch:

```sh
"$PYTHON_BIN" -m experiments.extraction.register DIAGNOSIS_ROOT NEW_R1_MANIFEST
"$PYTHON_BIN" -m experiments.extraction.study validate MANIFEST OUTPUT_DIR
"$PYTHON_BIN" -m experiments.extraction.study preflight MANIFEST OUTPUT_DIR
"$PYTHON_BIN" -m experiments.extraction.study run MANIFEST OUTPUT_DIR --cell CELL_ID
"$PYTHON_BIN" -m experiments.extraction.selection_replay register R1_DIR NEW_R2A_DIR
"$PYTHON_BIN" -m experiments.extraction.selection_replay run R2A_DIR SOURCE_ID
"$PYTHON_BIN" -m experiments.extraction.register_rendering R1_MANIFEST NEW_R3_MANIFEST
```

The existing registrars contain dated study identifiers. For a new revision,
make identifiers configurable or otherwise set the new registration identity
before freezing code and writing the manifest. Do not assume that choosing a
different filename changes the study ID. Do not run registration over a frozen
existing study or launch a full matrix beside an existing scheduler.

There was no dedicated grouping-registration CLI in the inspected checkout.
Check whether one now exists. If absent, follow `grouping-protocol.md` and use
the existing manifest utilities (`code_pin`, `pin`, `validate`, `write_new`) to
create an immutable R4 registration with exactly the declared factor difference.
Do not invent a `register_grouping` command or undocumented flags.

Preserve the registered order. R2a may follow each completed bounded parent;
fresh R3 follows R1 generation, and fresh R4 follows R3. Use one identifiable
background launcher with durable logs, not several competing shell loops.

## 8. Monitor, wait and recover correctly

Record the launcher command, source directory, script hash, manifest hash,
process ID and process start identity. Verify the same details for workers.
Monitor actual child processes, request/reply timestamps, receipts and errors.
Explain progress in terms of document, method and stage, not just opaque PIDs.

When a long model call is healthy, wait. Use interruptible observation intervals
and preserve the same process. An observation timeout does not mean extraction
stopped, and is not a reason to restart it. Do not keep emitting unexplained
counters; report stage transitions, completed comparisons and actionable failures.

For a real interruption:

1. For each interrupted cell, establish that its owning worker has exited or is
   absent and that its launcher will not dispatch it again. Other healthy cells
   can continue if recovery excludes them and respects the total concurrency.
2. Preserve requests, replies, attempt receipts and completed results.
3. Revalidate the original frozen code and input pins.
4. Resume only missing work. Reuse a saved reply only when its complete request
   matches exactly. A request with no saved reply has an unknown prior completion;
   record that uncertainty if it must be submitted again.
5. Keep completed cells immutable and verify their artifact hashes/receipts.
6. Reconnect followers to the new verified parent identity, with explicit
   dependency gates. Avoid duplicate replay workers and fresh-generation workers.

If a checkout changed, restore the registered archive into a separate frozen
directory; do not reset someone else's checkout or relabel current code as the
old revision. A pre-execution pin rejection is an infrastructure gap to recover,
not an observed model failure or a completed experimental cell.

Check free disk space before launch and between cells. Disk exhaustion can
prevent even the failure receipt from being written. Retain the original logs,
validate saved JSON and request/reply pairs, audit missing receipts, and document
unknown prior completions before resuming. Do not fabricate a successful or
failed extraction artifact to fill an infrastructure gap. Retire only a verified
waiting scheduler when reconnecting dependencies; preserve healthy workers.

Do not rerun a scientifically poor result until it looks better. Retain invalid
JSON, truncation, unsupported evidence, context refusal and partial processing
as outcomes, distinct from infrastructure interruptions.

## 9. Verify captures and analyse with the correct code

Check whether a live final-collection service already owns the report paths.
Verify its process identity, frozen reporting code and dependency checks before
starting manual copies of its commands. A collection-complete receipt proves
only its stated artifact/verification scope; final interpretation and the
requirement-by-requirement completion audit are still necessary.

For every sealed live-inference result, verify its manifest/cell pin, artifact
seal and exact finished receipt. Rebuild the artifact from exact saved requests
and replies, consuming every captured reply. Compare everything except the
explicitly excluded top-level clocks.

Use `docs/validation/extraction_capture_replay.py` from the corresponding pinned
runtime. `--allow-tokenize` may obtain missing tokenizer probes only; save those
separately as later observations. It must never generate new model responses.
Then replay again without that flag, with HTTP disabled, to prove offline
reproduction. R2a uses its own original-control/subsequence checks. Keep a
coverage ledger so no sealed cell is silently omitted from replay acceptance.

The replay helper takes a study directory, a new report path and a tokenizer
cache directory. For example, with `SERVICE_SOURCE` still pointing to the
registered inference archive:

```sh
REPLAY_SCRIPT=/absolute/path/to/reporting-checkout/docs/validation/extraction_capture_replay.py
PYTHONPATH="$SERVICE_SOURCE/src:$SERVICE_SOURCE" "$PYTHON_BIN" "$REPLAY_SCRIPT" \
  "$OUTPUT_DIR" NEW_INITIAL_REPLAY_REPORT TOKEN_CACHE --allow-tokenize --cell CELL_ID
PYTHONPATH="$SERVICE_SOURCE/src:$SERVICE_SOURCE" "$PYTHON_BIN" "$REPLAY_SCRIPT" \
  "$OUTPUT_DIR" NEW_OFFLINE_REPLAY_REPORT TOKEN_CACHE --cell CELL_ID
```

For the second pass, also verify that an HTTP attempt would raise rather than
silently reaching the provider. Do not invent an unsupported `--offline` flag.

Use the corrected reporting analyzer for final analysis, even when a frozen
launcher emitted an older initial report. Preserve historical reports; write
new, uniquely named outputs. Record the analyzer path/hash separately from
the frozen inference implementation.

The known reporting sequence is:

```sh
# Use the corrected reporting implementation, not the frozen inference source:
REPORTING_SERVICE=/absolute/path/to/reporting-checkout/prototypes/parsing_service
cd "$REPORTING_SERVICE"
PYTHONPATH="$REPORTING_SERVICE/src:$REPORTING_SERVICE" \
  "$PYTHON_BIN" -m experiments.extraction.analyze STUDY_DIR NEW_ANALYSIS_JSON

# From the reporting repository root:
cd ../..
python3 docs/validation/extraction_ablation_accounting.py \
  STUDY_DIR NEW_ANALYSIS_JSON NEW_ACCOUNTING_JSON
python3 docs/validation/extraction_ablation_tables.py \
  STUDY_DIR NEW_ANALYSIS_JSON NEW_ACCOUNTING_JSON NEW_TABLES_MD
```

Require matching manifest/analysis/accounting hashes. Do not mix a new table with
old accounting. Verify that repeated document metadata is aggregated across
eligible rows rather than taking whichever row happened to be last.

## 10. Report the right outcomes and denominators

Primary outcome: per-document populated sample-field correctness under the frozen
collagen scorer. Report each of the six papers and the mean paired treatment-minus-
control effect. Use the registered document bootstrap: 10,000 draws, seed 20260927.
Fields are not independent document replicates. Do not add post-hoc p-values;
a zero-width interval is not proof of equivalence.

Also report:

- Populated versus empty-field correctness, pending semantic review, and
  normalized versus exact projected representation matches.
- Document metadata, matched/missing gold identities, duplicate identity groups,
  unmatched predictions and extra array observations inside matched records.
- Selected/omitted contexts, ownership, overlaps, inherited qualifiers, conflicts
  and source-unit dispositions.
- Evidence-link coverage, invalid labels, literal quote validity and available
  localization. Do not call these independent semantic grounding accuracy.
- Inventory, document, record and grounding stage calls, input/output tokens,
  failures, refusals, retries, output truncation and completion status.
- Fresh versus reused calls, unknown prior completions, current-attempt elapsed
  time versus historical saved model duration, and provider/concurrency context.

Keep all registered sources and negative outcomes visible. Show expected,
completed, failed, refused, missing and paired denominators. Do not report an
effect on successful pairs as if every registered source contributed. Unannotated
examples supply operational observations, not invented semantic accuracy or block F1.

Inspect raw changes as well as scores. Unchanged gold scores can conceal changed
notes, diagnostic statuses or unscored measurements. Do not interpret removed
`field_statuses` leaves as lost scientific measurements. Retain an adjudication
queue rather than silently assigning truth labels to extras.

Grounding-arm comparisons may regenerate different upstream records. Verify
whether those records match before attributing value-score differences to the
verifier. Rendering and grouping change prompts and require fresh paired runs;
old replies cannot evaluate new prompts.

Distinguish direct shared-provider timing, conditional replay budgets, and real
Studio/DBOS lifecycle behavior. None substitutes for the others. Report no
held-out generalization claim without independently annotated unseen documents.

## 11. Deliver and audit completion

Keep the durable plan current and record the location of the final source,
manifests, launchers, outputs, replay reports and analysis entrypoints. Preserve
baselines and failures. Update the OpenSpec tasks only when evidence supports it.

Deliver a reproducible report with the final architecture, research mapping,
matrix, corpus exposure, exact versions, per-document effects, cost/refusal
tables, observation review queue, failure cases, limitations and reproduction
commands. Explain which techniques helped, hurt or had no estimable effect.
State when the evidence does not support choosing a production default.

Run checks appropriate to code changes. Verify factor isolation, canonical/table
preservation, budget refusal, exact reply reuse, changed-pin rejection, immutable
publication and reporting arithmetic. Exercise guarded persistence/DBOS or UI
boundaries only when those contracts changed, and keep those results distinct
from model accuracy. Audit unnecessary abstractions and duplicate legacy paths.

Before declaring completion, derive requirements from this prompt, the protocols
and the durable plan, and map each to current authoritative evidence. Require:

1. Every registered cell accounted for by a sealed result (including negative
   outcomes) or an explicitly audited terminal execution failure under the
   registered analysis policy. Recoverable missing launches are not completion.
2. All required dependency gates satisfied without bypassing pin checks.
3. Complete capture/replay coverage and reconciled call/token/attempt totals.
4. All declared comparisons, interaction and limitations reported with honest
   denominators and no silent cohort changes.
5. Final analysis and tables regenerated from pinned artifacts with the verified
   reporting implementation.
6. Relevant implementation/integration checks passed, or concrete unresolved
   requirements left explicit rather than called success.
7. Final documents and code committed and pushed to a reviewable branch.

Do not equate a live launcher, scheduled follow-up, merged implementation, partial
table or passing synthetic test with completion of the study. Continue until the
requested end state is actually established, or identify the specific external
input required to proceed without weakening the objective.
