# Article extraction repair — 2026-09-26

Status: repair and validation complete; residual semantic errors and the full paleopathology context limit remain documented below.

Tested checkout: `fix/article-extraction-coverage`, based on `bbfe5477cf672f91c1a31f765873acedd46a974a`.
The original diagnosis and immutable baseline are under
`/home/gennaro/Documents/Codex/2026-09-26/kei-article-diagnosis`; new evidence is in its `fix/` directory.
No production deployment, remote checkout edit, or application database change is part of this validation.

## Changes and acceptance checks

- Article inventories source-supported identities and their canonical supporting passages, then extracts each
  record separately. A typed identity object gives each attribute one value, retained across value extraction;
  unknown passage IDs and invalid attribute types are rejected. Repeated identities retain the union of their
  supporting passages with a review diagnostic. Attributes left null remain available for value extraction.
  No gold identities or expected record counts are supplied to inference.
- Article uses the endpoint's actual tokenizer and context size. Document extraction and inventory read the
  complete canonical source. Each value call also receives the complete source: inventory citations cannot
  hide uncited methods or alternate reported measurement bases. Grounding
  retains the complete source and record context, splitting claims when necessary. Oversized input is reported,
  never silently clipped; unique lexical occurrences are insufficient for Article grounding.
- Field notes show permitted labels explicitly. vLLM's structured-output grammar constrains decoding but does
  not place the schema in Qwen's prompt. A controlled Sousa replay changed wrongly labelled sequence-derived
  Pro/Hyp and a wrongly labelled Pro+Hyp observation to the correct measured-composition categories.
- Native PDF routing detects substantial textless images/forms, including outlined vector table text. An empty
  native table fails conversion completeness. Akita's numeric table bodies now survive OCR; both the whole-page
  and default-crop page-4 runs pass 66 checks against values read from the original PDF (22 Table 1 Pro/Hyp values
  and 44 Table 2 Pro/Hyp/Pro+Hyp/Td values). Evidence precision remains segment-level.
  The complete default-crop conversion passes the same checks and preserves `Pterocaesio digramma` correctly;
  the earlier whole-page OCR misspelled that name. Existing immutable parses are not repaired in place:
  Akita needs a new conversion before extracting from the recovered tables.
- Article's execution deadline is three hours, matching Catalog's existing per-record allowance. The existing
  model-call timeout defaults to 1,800 seconds; a full-source Qwen experiment exceeded the old 600-second limit.
  Cancellation is checked before inventory, each record and each grounding batch.
- Version-1 prompt version is 11. Grounded Catalog's prompt version is 4 because shared field notes changed;
  its accepted-span extraction design remains the same.

## Regression evidence

| Check | Result |
| --- | --- |
| Parsing Service unit suite, excluding `postgres` and `live_model` | 971 passed, 72 skipped, 68 deselected; existing dependency deprecation warnings only |
| Extraction workflow suite, local disposable PostgreSQL | 34 passed, including cancellation during Article inventory, record extraction and grounding |
| Extraction adapter unit suite | 68 passed |
| Extraction adapter TypeScript typecheck | Passed |
| Focused Article/schema/stage/grounded checks after complete-source value extraction | 87 passed |
| Grounded Catalog/token-counter checks after shared prompt-version bump | 35 passed |
| `git diff --check` | Passed |
| Bloat audit | No blockers; the scanner's sole flag is a changed default on an existing timeout variable |

PostgreSQL checks use the existing `free-m1-pg` loopback service and `free_test_parsing` only as a maintenance
connection; the fixture creates and removes fresh guarded test databases. These tests use scripted model
responses. Live accuracy runs call the local Python extraction path with the actual remote models over SSH
tunnels after VPN connectivity was restored. They do not exercise authenticated Studio or deployment recovery.

## Evaluation pins and comparison limits

### Upstream integration check — 2026-09-27

[Draft PR #142](https://github.com/HUM-CDCH/FREE/pull/142) integrates this repair
with parser/DBOS foundation commit `299bfc6d777aa52f62da860761aa02d94fd9a0fd`.
The merge was checked in the separate `article-repair-review` worktree; the live
ablation study's checkout and inference pins were not changed.

The overlapping grounding cancellation hooks were retained once. Article still
checks before inventory, each record and each grounding batch, including before
the tokenizer/budget probe. Two newly added upstream tests were updated for
typed inventory plus per-record extraction and for the pre-split budget check.
The README now combines the upstream durable-worker contract with complete-source
Article extraction and the three-hour deadlines.

- Fast parser suite: **983 passed, 72 skipped, 74 deselected**.
- Guarded disposable PostgreSQL extraction-workflow suite: **34 passed**.
- Extraction adapter suite: **72 passed**; TypeScript typecheck passed after
  generating this checkout's local database contract with `pnpm db:generate`.
- Offline replay: **six sources, 88 exact requests/replies and matching artifacts**,
  excluding only top-level clocks. Output is
  `artifacts/extraction-ablation/repair-integration-20260927/replay.json` in the
  primary FREE checkout. The replay helper is the study branch's
  `experiments/extraction/replay_reference.py`; `PYTHONPATH=src` selected the
  merged repair's runtime, with no sibling-runtime imports or fresh model calls.
- Diff and bloat review passed: no duplicate callback, compatibility path,
  added dependency or configuration surface in the conflict resolution.

These checks cover extraction integration. They do not repeat the upstream
foundation's separate garbage-collection, deployment or Studio E2E validation.

### Standalone PR service boundary — 2026-09-27

The service model fixture now answers Article inventory, per-identity values
and semantic grounding from its parsed source. The expected eight calls cover
five Article calls plus Catalog discovery and its two records. This fixture
update lives in the original repair so later stacked PRs are not required to
make its service checks work. Interactive and batch deadline assertions both
expect the implemented three-hour allowance.

The existing cancellation fix from the later integration is also applied here:
a forced status check after the final model call prevents publishing a cancelled
Extraction or refreshing its run's GC age. Two regression cases cancel Article
and Catalog during their final call with a recently read status, proving that
the publication check bypasses throttling. Workflow steps/version are unchanged.

Validation in `article-repair-review`: **985 fast parser tests**, **36 extraction
workflow tests**, and root TypeScript typechecking pass. The first full service
run passed 12/13 scenarios; its only failure was the stale ten-minute deadline
expectation (the worker reported 10,800,000 ms). After correcting that assertion,
the affected scenario passed in an isolated rerun. Thus all 13 distinct service
scenarios have passed; this is not described as a single clean full-suite run.
Logs are in that worktree's `artifacts/article-repair-integration/`.

The real-service boundary uses authentication, PostgreSQL, DBOS, native parsing,
canonical evidence and review; model replies alone are scripted. Its own Compose
project `free-article-repair-service` used PostgreSQL 25446, Studio 41791 and OIDC
41792 and was removed after each run. No deployment or new accuracy result is
claimed. Diff and bloat review passed; the backport adds no runtime dependency
or compatibility path. R1's running code and saved artifacts remain unchanged.

The parent also carries the existing browser-fixture fix from `45411f1`: its
manual-entry case uses a NuExtract ID absent from the mocked provider catalog.
The previously listed ID lost its `Use ...` option when the asynchronous probe
finished, causing the parent CI failure at `93e1ea7`. The unchanged test passed
locally before the backport, consistent with that timing race; all **12 model
configuration browser scenarios** pass afterward. Logs are
`model-config-before.log` and `model-config-fixed.log` in the same artifact
directory. This changes no product behavior. A separate CI attempt at `3c714c9`
failed before browser execution because PostgreSQL port 45432 was occupied;
the log does not identify its owner, and that attempt was retried once.

Full-stack CI at `71a209e` later exposed a separate asynchronous UI assertion:
the extraction-complete toast can render before the terminal-admission caller
opens its completion dialog. The test now awaits that accessible heading before
dismissing it, without changing product behavior or adding a fixed delay.
All **45 App tests** pass; the parent log is
`artifacts/article-repair-integration/app-completion-dialog-test.log`.

### Original live comparison

The original six PDFs were rehashed against the adjudicated gold. Gold, original schema, scorer and baseline
artifacts are unchanged. `fix/evaluation-pins.json` records their hashes. Every live run saves its exact code
diff, schema hash, canonical run, request and reply bodies, and final artifact. The final complete-source run
reuses earlier live replies only when the entire model request (including the shown schema/instructions), model,
options and canonical generation
match; `replay.jsonl` identifies each reused reply and its hash. Changed requests run live. Replay timings
are not fresh end-to-end performance measurements.

The baseline is 104/374 correct populated sample fields (27.8%), with 9/28 uniquely aligned gold identities.
The gold is a development subset, not an exhaustive paper inventory. Additional source-supported predictions
are unscored, not automatically false positives. Model links and page overlap do not independently prove value
correctness; document-level fields remain unverified.
These same papers guided the repair and schema clarifications; this is development-set evidence, not a held-out
accuracy estimate.

Earlier arms and intentionally stopped experiments are retained with status files. The original-model canary
still exposed NuExtract table-row mixing. The corrected run explicitly selects Qwen for both fields and
reasoning and uses `fix/collagen.schema.v3.json`, a separately pinned clarification of identity, thermal-label
and measurement-array instructions. A complete-source Wang probe recovered the omitted solvent and viscosity
protocol, but left one mass measurement in notes; v3 requires all reported measurement bases in the structured
array. No gold values, counts or record lists were added to that schema. This combined comparison is
not an isolated estimate of the code change's accuracy effect. Existing application model choices are retained.

A separate Akita-only arm, `amino-alias-v4`, uses `collagen.schema.v4.json` to make the domain mapping
`Pro+Hyp`/`Pro+OhPro` to `imino_acid` explicit. It changes schema descriptions only and requests reported
totals, never calculated totals. Its result is reported separately from the uniform six-paper v3 run;
substituting its result for Akita would be a mixed-schema development comparison.

Canonical conversion is a separate gate. Five papers use their pinned baseline canonical generations;
Akita uses a new conversion. Conservative textless-artwork routing may send other native PDFs through OCR,
so this is not a fresh six-paper conversion benchmark. OCR spelling and model assignment still require review.

## Reproduction artifacts

Under the diagnosis's `fix/` directory:

- `run_fixed.py`: database-free live extraction with exact call capture and explicit model/schema selection.
- `score_arm.py`: unchanged scorer over completed native extraction artifacts; absent papers are identified
  separately and never counted as a completed six-paper result.
- `check_artifacts.py`: canonical generation/digest, passage/path, geometry and actual request-budget checks.
- `verify_akita_tables.py`, `akita-full/table-check.json`, `akita-auto-page4/table-check.json`: canonical table checks.
- `full-source-v11/`: final live candidate and its per-paper code/input/model captures.
- `amino-alias-v4/`: separate Akita domain-label clarification, with its own schema hash and request capture.
- `typed-identity-v10/`: typed objects fixed the conflicting attributes, but selected-passage inputs still
  omitted methods. Retained as a partial, superseded experiment.
- `instruction-schema-v6/`: earlier candidate, including the conflicting attribute-list failure that the
  typed object removes; unchanged calls may be reused by the final run.
- `grounding-scope-probe.*.json`: a negative grounding stress test. Stronger instructions still falsely
  grounded two other tissues' Hyp values as raw-scale measurements. This was not adopted as a prompt fix;
  a model-created link is not an independent accuracy check.

## Primary six-paper result

| Paper | Baseline correct | Fixed correct | Incorrect populated | Needs review |
| --- | ---: | ---: | ---: | ---: |
| Akita | 92/187 | 156/187 | 20 | 11 |
| Harvey | 0/9 | 7/9 | 0 | 2 |
| Mizuta | 0/66 | 66/66 | 0 | 0 |
| Sousa | 0/52 | 47/52 | 3 | 2 |
| Wang | 12/49 | 47/49 | 0 | 2 |
| Zelechowska | 0/11 | 10/11 | 0 | 1 |
| **Total** | **104/374 (27.8%)** | **333/374 (89.0%)** | **23** | **18** |

All **28/28** gold sample identities align uniquely, versus **9/28** before. The run returns 38 records;
the ten extra predictions are outside this gold subset. Empty gold fields are correct in **231/247** cases
(93.5%), versus 28/247 before; all sixteen new false fills occur in Sousa controls.

All **88 model-call records** pass actual-token, context-reserve and canonical-provenance checks. Six are
exact document-call replays; the other 82 calls ran live. There are **38 grounding calls**, 932 evidence links
and 61 ungrounded leaves (60 status-metadata leaves and one note). Harvey retains seven duplicate-identity
review diagnostics after support was combined. No call failed, source was truncated or grounding request
was rejected for budget. The smallest reserved-context margin is 211 tokens.

Remaining populated-field errors are twenty missing Akita imino-acid value/unit fields and three Sousa
control amino-acid values. Sousa also inherits unsupported imino-acid and thermal observations from
swim-bladder samples. Nine of eleven Akita ASC records also contain raw-skin shrinkage temperature `Ts`; this
additional observation can escape the gold projection when the correct `Td` observation is also present.
Zelechowska's extra raw-bone record also repeats collagen measurements and needs scope review. These
examples make the complete-paper precision limit explicit; 28/28 gold alignment is not proof of exhaustive
or correct enumeration of every sample in the papers.

The diagnosis's `fix/FIX-REPORT.md` links the prediction bundle, unchanged scorer output, artifact checks and review queue.

## Separate Akita schema-v4 result

The explicit `Pro+Hyp`/`Pro+OhPro` alias clarification recovers all eleven reported imino-acid totals.
Akita improves from 156/187 to **176/187 correct populated fields (94.1%)**, with no incorrect populated
gold fields and eleven thermal-protocol descriptions requiring semantic review. All eleven identities
match, all 55 empty gold fields are correct, and its 24 call records pass budget/provenance checks.
One document call was exactly replayed; the remaining 23 calls ran live.

This remains an Akita-only schema-v4 result. It is not substituted silently into the primary six-paper
schema-v3 score. Nine extra raw-skin `Ts` observations are still assigned to ASC, despite all values
having model links and `complete: true`. They are listed in `amino-alias-v4/review-queue.json`.

## Additional `examples` validation

The user requested all ten PDFs under `examples`, including the five grave reports (154 physical pages).
Fresh default-path conversions and source-appropriate extractions are recorded under `fix/examples/`.
`evaluation-plan.json` pins schemas and strategies; `checks.before.json` records checks derived directly
from the sources before inspecting extraction replies. These checks are not injected into inference.

Zhang uses the collagen schema with an explicit experimental-group dimension and reported yield fields.
The paleopathology and Hamburg papers use research-question/method/findings fields. Grave reports use
site, chronology, explicitly qualified counts and burial-form fields; Ellekilde also exercises generic
Catalog extraction of individual grave entries. The historical notice uses one record per detained person,
retaining repeated names, an unnamed person and inherited detention-place headings.

Hamburg exposed an unsafe layout boundary crossing text on physical page 3. The cutter now retains
blocks across such a boundary, while keeping other verified cuts. Both axes stop recursing when no safe
split remains. Its fresh 24-page conversion and paper extraction pass the recorded checks. The added regressions cover
unsafe boundaries on both axes and mixed safe/unsafe column gaps. Katrinesminde also exposed a numbered
blank last page: detected furniture accounting for at least 90% of the ink now permits whole-page OCR,
while unexplained missing body content still fails. The final Parsing Service suite is **971 passed,
72 skipped, 68 deselected**.

The full paleopathology paper was explicitly refused: its document call needs 32,603 input tokens plus
2,048 output tokens against a 32,768-token endpoint. Its inventory also exceeds context. The preserved
full-document artifact is incomplete with zero records; process exit zero is not an extraction success.
A separate `Age-body-1-8` run covers physical pages 1–8, including conclusions and acknowledgments before
the References heading on page 8. This is an explicit partial-document validation, not a full-PDF success.

All ten PDFs now pass conversion completeness: **154/154 physical pages**, with no conversion errors or
OCR token caps. Nine full PDFs produce extraction records. The separate pages 1–8 paleopathology run also
produces a record; the full eleven-page case remains a context refusal. There are 70 new live model calls
and two pre-inference budget refusals across these cases; none of the inference responses was truncated.

Zhang preserves both RF/CF groups and their checked yields, standard deviations, Td and measurement
conditions. Ellekilde retains all seven grave entries, including the last partial one. The historical
notice retains all thirteen people, both Edouards, an unnamed person and the 10/3 detention headings.
Grave reports preserve the principal checked counts and fieldwork dates. Six Zhang status annotations
remain ungrounded, so its artifact is not marked complete.

Source review still finds five semantic/schema issues: Jean's former enslaver's address is assigned to
the current-enslaver location; two reports label reported lower-bound counts as merely possible; Hamburg
presents the study's single-case scope as an explicit limitation; and Hvissinge places its two boat graves
in narrative finds instead of structured count categories. Limited numeric checks alone miss these errors.
The retained `fix/examples/REPORT.md`, `checks.json`, `conversion-checks.json` and `manual-review.json`
separate these outcomes. No prediction was edited to pass evaluation.
