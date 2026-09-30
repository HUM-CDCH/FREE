# Development error ledger, 2026-09-30

Status: completed offline diagnosis against
`406263e58c030b367af75ddf1a9e16717ac9c1e5`. Production, extraction configurations,
the evaluator and published scores are unchanged. No fresh extraction, OCR or
tokenizer calls were made, and no held-out PDF or annotation was opened. This
is an agent inspection of development evidence, not human adjudication.

## Illinois: all disagreements accounted for

[The executable audit](audit_scoring.py) captures the actual virtual records and
matching produced by the frozen evaluator, then classifies its disagreements.
[scoring-audit.json](scoring-audit.json) retains all 57 discrepant leaves with
field paths, annotation states and value hashes; it contains no values or source
excerpts. Its socket guard recorded zero network attempts. The original sealed
prediction and evaluator are never changed.

| Diagnosis | Raw disagreements | Canonical disagreements | Evidence and interpretation |
| --- | ---: | ---: | --- |
| Document title used as `section` | 28 | 28 | Every gold section is explicitly null; every prediction contains the same source-visible document title. The original field definition excludes document titles and says this grid has no section grouping. |
| `rate_basis` vocabulary | 7 | 7 | The mileage-column label is returned instead of the billing-basis term required by the original field definition. This is a semantic mapping disagreement, not case/spacing. |
| Issuer specificity | 1 | 1 | The predicted issuer is the exact prefix of gold, lacking its final two tokens identifying the issuing group. Both full strings are inferred rather than contiguous source literals; the original definition permits issuer inference. |
| `rate_basis` capitalization | 21 | 0 | Case folding alone reconciles these leaves under the already declared canonical comparator. Raw equality remains wrong. |
| **Total** | **57** | **36** | Twenty-eight populated-versus-null disagreements plus 29 raw / eight canonical wrong populated-gold values. |

All 28 item labels and all 28 rate values match under raw equality. The effective
period also matches. The actual record matcher pairs the wrapper and all 28 items
in identity order, with zero missed, duplicated or extra records. Thus the new
Illinois failures do not come from wrong record correspondence.

The unchanged denominators are **114 predicted populated leaves** and **86 gold
populated leaves**, with 28 explicitly absent gold leaves. Raw scoring has 57
true positives, 57 false positives and 29 false negatives; canonical scoring has
78, 36 and eight, respectively. These reproduce raw F1 **0.57** and canonical F1
**0.78**. Each of the 28 repeated records has the section error; seven also have
the billing-basis error. This explains why none is canonically complete, even
though all records were found. The wrapper has the issuer error. No hypothetical
correction is promoted to a new extraction score.

The scorer's category name `hallucinated_fields` means populated output against
annotated absence. Here the title is present in the source but assigned to the
wrong conceptual field. That count does not establish invented source text.
Literal presence is likewise not proof of semantic support. A0 provides no
evidence selections, and this native-line adapter cannot measure semantic support
or exact geometric localization. See the [historical result](../development-continuation/README.md#results-and-limitations).

## Gold and adapter interpretation

The [adapter](../../../../prototypes/parsing_service/experiments/harness/extractbench.py#L34)
retains structural field names and types, and removes descriptions, examples,
defaults and enums. This is deliberate: development descriptions contain
document-specific answers, source locations and examples. Reinstating them
unchanged would breach the study's inference-input contract.

Inspection of the Illinois development-only original schema found that its
definitions also carry legitimate semantics: section headings exclude the
document title, billing basis uses a normalized vocabulary, and issuer may be
inferred from document identity and the footer. These definitions do not reach
the model under the structural-only adapter. **Loss of semantic guidance is a
plausible contributor, not a measured causal effect.** No fresh paired intervention
was run to distinguish that contribution from model behavior.

The structured [scorer](../../../../prototypes/parsing_service/experiments/harness/evaluate.py#L490)
distinguishes explicit null (`absent`) from a missing/unannotated leaf. It also
retains populated acceptable alternatives from field rules. All 28 section rules
have null evidence values, so there is no omitted populated alternative that
would excuse these predictions. The native-source view and the original section
definition agree with these null labels. **No Illinois gold defect or scorer
defect was established.**

The official code checkout was read at pinned revision
`c8e59696b19c50d904801390dedef8d292d529e7`; its
[field-rule comparison](https://github.com/run-llama/ExtractBench/blob/c8e59696b19c50d904801390dedef8d292d529e7/src/extract_bench/evaluation/metrics/field_grounding/value_compare.py)
also treats rule evidence and comparator selection as explicit inputs. This
audit did not run official scoring. The custom harness differs in schema
sanitization, source representation, matching and scoring, so its scores remain
custom harness results.

The earlier suggestion to handwrite generic field guidance is withdrawn after
[the sparring review](sparring-decision.md): it would add an unrequested extraction
intervention. No automatic adapter correction is established by these observations.
Keep anti-leak versus semantic fidelity explicit and unresolved. Do not relax the
comparator, relabel nulls or restore answer-bearing prose in response to these errors.

## Ingestion: absence of native text is not a blank page

The adapter rejected Byline page 24 and CLIN pages 44–60, 64–66 before decoding
their expected output or field rules. This audit rendered **Byline 24, CLIN 44
and CLIN 64**, using the already downloaded development PDFs only:

- Byline 24 is a nonblank closing page with a raster brand mark over a photograph.
- CLIN 44 contains a substantive contract data form.
- CLIN 64 contains prose and rating tables.

These observations rule out silently dropping all textless pages as blank. They
do not establish the content of every rejected CLIN page or OCR quality. The
other 18 rejected CLIN pages were not visually inspected in this increment, and
the blocked groups' gold remained unopened. Source hashes and all rejected page
numbers remain in the [adapter manifest](../development-continuation/adapter-manifest.json).
Rendered pages are kept in ignored scratch storage, never in Git.

A future ingestion amendment needs pinned OCR or another complete representation,
source-only coverage checks, and a separate resource estimate. No OCR alternative
was executed or certified here. Keep the blocked cells in the registered population.

## Operational findings

The [resource audit](resource-budget.md) establishes four distinct blockers:

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Output truncation persists after recovery | Viega A2 has nine capped replies, including five recovery halves at maximum depth. | Identical cache replay cannot repair those regions. More elapsed time alone does not change the cached responses. |
| Recovery does not fit the matrix allowance | 268 nominal calls expand to 804 with full one-level recovery; continuation allowance is 400. | Nominal admission is not a completion guarantee. |
| Long/cross-page resource feasibility is missing | DD1155 needs 68 nominal calls; maximum outputs alone reserve 278,528 tokens. Erie needs up to 108 calls per arm. | Lifting only DD1155's 60-call cap leaves its 250,000-token problem; Erie also needs a new recovery envelope. |
| Cell budgets reset on resume | Real executor counterexample: cap two, first attempt one fresh scripted call, next attempt two more and one replay; cumulative three. | Enforce cumulative call/token spending across attempts before resuming an unsealed cell. No recorded historical overspend was found. |

[reproduce_budget_reset.py](reproduce_budget_reset.py) drives the actual executor
with a fabricated source and an in-process scripted provider, with network
connections prohibited. It respects a cumulative three-call study allowance but
exceeds the configured two-call cell cap after resumption. This is executable
evidence of an operational defect; it is not real development inference. No
harness fix was made in this audit.

## Earlier smoke evidence remains distinct

The [48-row population](../development-continuation/per-document-all-development.csv)
retains the earlier three documents and all four arms. Their aggregates include
wrapper and nested-record scorer categories; they are not independent observations
of invented records or a causal diagnosis of merge behavior.

| Arm | Repeated matched / gold | Repeated misses | Repeated extras | Wrapper plus repeated duplicates | Complete records |
| --- | ---: | ---: | ---: | ---: | ---: |
| A0 | 7 / 10 | 3 | 27 | 5 | 0 |
| A1 | 2 / 10 | 8 | 9 | 4 | 0 |
| A2 | 7 / 10 | 3 | 13 | 4 | 0 |
| A3 | 7 / 10 | 3 | 13 | 4 | 0 |

These counts are preserved historical evidence, not newly adjudicated causes.
They establish that solving the Illinois semantic disagreements alone would
leave the earlier record/merge failures unresolved. This audit selects no arm
and does not pool the unequal development subsets into a ranking.
