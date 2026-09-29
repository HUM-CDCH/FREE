# Catalog unification: sparring record

Date: 2026-09-29. Participants: Codex and Claude Code Fable 5.1, explicitly
requested by the researcher. Planning only. Baseline:
`80686ec4aea3f4a5d37dfcb643d29ac5a23e0ed3`.

Claude Code CLI version was `2.1.284`; completed model responses identify
`claude-fable-5-1` in their `modelUsage`. No substitute model or agent was used.
Round 1 inspected the repository read-only. Subsequent rounds received the
earlier response, Codex's objections and the concrete draft artifacts. A CLI
session-resume attempt was unavailable, so continuity was carried explicitly in
the next prompt rather than claiming a resumed session. Application code and
runtime data were not modified.

## Round 1: independent inspection and initial disagreement

Fable traced generic clipping, recipe windowing/acceptance, Studio controls,
artifact versions and worker settings. It confirmed the split is an execution
and contract issue, not only configuration copy.

Its first proposal kept structural recipes as selectable segmenter plugins,
added schema key hints and changed legacy generic execution before unification.
It also initially treated generalization metrics as observational rather than
a default-cutover gate. Codex rejected these proposals because they retain the
product split, expand the schema interface, change old admitted semantics and
provide insufficient evidence of a general Catalog method.

Both agents independently identified recipe `_document` prefix extraction and
the acceptance rule requiring recipe keys. The first review's introductory claim
that the recipe path never truncates contradicted that evidence. Its claim that
an immutable method ensures byte-equal live artifacts also contradicted
`CONTEXT.md`. These were explicitly challenged, not adopted.

## Round 2: corrections and shared direction

Codex supplied a concrete alternative and nine code-backed challenges. Fable
explicitly retracted the truncation/reproducibility claims, the replay analysis,
the interim change to old settings, and the non-gating generalization proposal.
It accepted one active schema-driven discovery path with no recipe plugin.

| Discussed issue | Resolution carried into the plan |
| --- | --- |
| Keeping recipes as internal plugins or a per-run choice | Remove from new Catalog execution and controls; retain only bounded legacy execution for already admitted work. |
| General acceptance without recipe keys | Exact source/type checks plus a separate schema-aware verification request; verification Off leaves proposals. |
| Discovery cache keyed like recipe segmentation | Extraction-local artifact first; schema, model, method and protocol dependencies are explicit. No cross-extraction reuse in this release. |
| Only parser-segment start labels | Validated intra-segment boundaries, ambiguity and explicit continuation handling are required. |
| Reusing the old array merger unchanged | Characterize it; use discriminating item identity and retain ambiguous partial objects. |
| Silently interpreting old settings under new code | Versioned new admission, replay existing IDs first, frozen legacy execution until a proven drain. |
| Full accounting presented as recall | Keep source accounting, processing and evidence separate; recall is unmeasured without evaluation. |
| Generic glossary and schema key hints | Defer both; no new format-dependent subsystem or field-binding metadata in the first release. |
| Configuration | Five controls in one Catalog section; schema and model responsibilities remain where they are. |
| Generalization evidence | Deterministic invariants gate code changes; preregistered independent-family live evaluation gates default cutover. |

## Round 3: adversarial review of the actual artifacts

Codex provided the complete design, tasks and both specification files, not just
an outline. It accepted Auto budgeting as a capacity policy without claiming
measured optimality, kept document fields explicitly unverified in release 1,
and deferred numeric-gap diagnostics. It rejected Fable's suggested use of the
first located scalar as an array-item identity because different items can share
that support.

Fable returned **REVISE**, with six concrete amendments. They were incorporated:

1. Atomic write-once execution/discovery records, validated reuse on recovery,
   digest verification, conflicting-writer failure and crash-boundary tests.
2. Legacy executor dependency isolation or CI evidence that shared changes
   preserve scripted old outputs; capture fixtures before modifying helpers.
3. A concrete conservative array rule: exact occurrence plus matching complete
   observation for deduplication; no automatic complementary-partial stitching.
4. Document-field windows cover all admitted text independently of entry
   dispositions, including front matter and unresolved entry regions.
5. Explicit legacy preference migration blocks only new Catalog admissions until
   Apply, with tolerant decoding and atomic Catalog-branch replacement.
6. Separate shape validation at admission from actual model-budget fit checks;
   surface failures per affected Extraction.

The revision also added two-sided continuation observations with zero overlap,
verification batching, and an explicit Unicode whitespace policy.

## Round 4: agreement on the amended plan

Fable reviewed the amended design, tasks and specifications and returned
**AGREED**. Its complete closing response is preserved in
[fable-final-review.md](fable-final-review.md).

Two refinements were explicitly accepted: embed execution/discovery records in
the existing result artifact instead of creating an additional metadata API;
and preserve ambiguous partial array objects rather than implementing risky
stitching in the first release. Known split-item cases and partial-item rates
were added to the evaluation tasks. They count as unresolved, remain in expected
recall denominators and can prevent cutover.

Agreement is about the plan's direction and executability. Numerical default
registration, corpus availability, actual implementation and performance remain
unchecked work. No application or extraction-evaluation success is implied.

## Validation scope

The planning files were checked with `openspec validate unify-catalog-extraction
--strict`. No application, database, browser or live extraction tests were run.
CLI model calls here were architecture review, not extraction evaluation.
Implementation tasks and release gates remain unchecked in [tasks.md](tasks.md).
