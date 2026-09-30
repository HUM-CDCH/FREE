# Extraction harness: risk-control audit and human-gold inventory

2026-09-30. Status: research audit and proposed annotation protocol; no formal
certification, human annotations, production changes, or held-out execution.
Audit baseline: checkpoint `f5827cd7ab8df2f6f63e9816608822618c4c6a6f`.
Implementation references below describe that checkpoint, before the revised
evaluation contract. Historical pilot manifests remain historical evidence.

## What LTT and CRC would control

For source group `g`, let `N_g` be its scored predicted fields, `A_g(t)` its
accepted fields at threshold `t`, and `W_g(t)` its accepted incorrect fields.
The implementation uses two different losses:

| Method | Per-group loss | Statistical statement, if its assumptions hold |
| --- | --- | --- |
| LTT, Hoeffding–Bentkus p-values, single-start fixed sequence | `W_g(t) / A_g(t)`, defined as zero when `A_g(t)=0` | With probability at least `1-delta` over independent calibration groups, the selected rule's **expected group accepted-error fraction** is at most `alpha`. |
| CRC | `W_g(t) / N_g` | Expected **group error mass**, jointly over calibration and a new exchangeable group, is at most `alpha`. This is an expectation guarantee, not a `1-delta` statement. |

Neither target is pooled accepted-field error, record recall, F1, or the chance
that a particular value is correct. Groups receive equal weight despite
different field counts. [Implementation: `group_losses`, `certify`,
`micro_macro`](../../prototypes/parsing_service/experiments/harness/confidence.py).

LTT requires a fixed predictor and hypotheses/order selected independently of
calibration labels, i.i.d. bounded group losses, valid p-values, and stopping at
the first failed rejection. Its loss need **not** be monotone; ordering affects
power. [LTT v5, §1.1, Proposition 1, §2.3.1](https://arxiv.org/html/2110.01052v5).

CRC requires exchangeable group loss functions, a fixed finite bound `B`,
non-increasing loss for **each** group as conservativeness increases, and a
safe terminal rule with loss at most `alpha` almost surely. The theorem also
states right continuity; a finite ordered grid can use a step-function
extension. Checking monotonicity only in the mean is insufficient. Accepted
error is generally non-monotone; fixed-denominator error mass is monotone for
nested acceptance sets. [CRC v4, equation 4 and Theorem 1](https://arxiv.org/html/2208.02814v4).

### The sample-size conditions are method-specific

For the implemented HB test with zero observed loss, `p=(1-alpha)^n`.
Single-start fixed sequence can reject only if
`n >= ceil(log(delta) / log(1-alpha))`. CRC's nonnegative-loss correction is
`n/(n+1) * mean_loss + B/(n+1) <= alpha`; even at zero loss this requires
`n >= ceil(B/alpha - 1)` for a qualifying grid point. These are algebraic
feasibility floors, not sufficient study sizes; CRC can still use a known-safe
abstain-all fallback below its floor. [LTT equation 2](https://arxiv.org/html/2110.01052v5),
[CRC equation 4](https://arxiv.org/html/2208.02814v4).

| `alpha` | `delta` | LTT zero-loss minimum | CRC zero-loss minimum (`B=1`) |
| --- | --- | --- | --- |
| 0.10 | 0.10 | 22 | 9 |
| 0.05 | 0.10 | 45 | 19 |
| 0.10 | 0.05 | 29 | 9 |

The [pilot summary](../plans/2026-09-30-extraction-research-harness-evidence/README.md)
gave both methods a universal “22 groups” restriction. That statement is
superseded by the conditions above. Neither this screening cohort nor its
metadata-based selection establishes the assumptions for deployment claims.

### Implementation boundaries found in the audit

- `table` receives predicted-field outcomes. Groups producing no scored
  predictions disappear, so the present population is groups with eligible
  predictions, not every admitted source group. An eventual risk study must
  retain the registered group inventory and define zero-prediction loss.
- Legacy `value` uses the evaluator's configured equality policy. Legacy
  `supported` combines value correctness with gold-span matching and omits
  unannotated outcomes; it does not independently measure semantic support.
  Future risk targets must name the evaluator version, normalization policy,
  evidence component, and annotation-eligible population explicitly.
- CRC checks the terminal losses only on calibration observations. The grid's
  threshold `1.0` with `score >= threshold` still accepts score-1 values; it is
  not an unconditional abstain-all endpoint. Also, the low-level routines do
  not validate every finite/bounded-array precondition. The `certified` output
  is not proof that the caller supplied a valid statistical design.
- `confidence_study` refuses learned analysis on single-class fit or
  calibration data. That implementation restriction is separate from the
  mathematical bounds: observing no calibration errors is not itself a
  theoretical obstacle for a previously fixed scoring rule.

Sources: [confidence routines](../../prototypes/parsing_service/experiments/harness/confidence.py),
[study wrapper](../../prototypes/parsing_service/experiments/harness/study.py),
[confidence fixtures and simulations](../../prototypes/parsing_service/tests/test_harness_confidence.py).
The simulations test examples of assumptions; they do not establish those
assumptions for a dataset. Defer confidence-model development and formal
certification beyond this increment.

## Already available FREE catalogue material

Read-only metadata inventory of the documented sibling `kei-exp` checkout
found 20 PDFs with six distinct byte hashes. Seventeen files are Beier
catalogue copies or derivatives, with three byte hashes; conservatively they
form **one source-document group**, not 17 independent sources. No source PDF
was copied or committed. `PARSING_FIXTURE_DIR` was unset; FREE's own optional
PDF fixture directory lacked these originals. [Fixture contract](../../prototypes/parsing_service/README.md),
[recorded prior use](../validation/2026-09-25-dbos-m1-verification.md).

Paths below are relative to that sibling checkout. Counts and hashes were
read with `pdfinfo` and SHA-256 on 2026-09-30; no source-text excerpts are stored
here.

| Available source | PDF pages | Copies with same bytes | SHA-256 |
| --- | --- | --- | --- |
| Full Beier, `runs/_old/20260915-152812-surya-12cb/input.pdf` (68,086,716 bytes) | 45 | 2 | `31b024007313aa5323e5d428ea49ec47dfd236ed95a31a56ba14cacc3211dc2f` |
| `Beier1988_GAC_02_Catalogue7.pdf` | 1 | 6 | `cbfa2b3b1fc88136a129255520dec9ae8ada6ce6c48b4d8d07b8010bf8c93012` |
| Beier derivative, `runs/_old/20260915-155142-granite_docling-a41d/input.pdf` | 1 | 9 | `f7ea58bd4d4330e02759ac09c64463e4c8a84fb1c361ed33d13f582542559cd5` |

The current one-page fixture hash differs from the `source_sha256` in the
[recorded Surya replay](../../prototypes/parsing_service/tests/recorded/surya-ingest-catalogue7.json).
Filename equality is insufficient to reuse its pins. The other three byte
identities were article or unidentified fixture material; they are excluded
from this catalogue inventory.

Repository reports name Bosch, Kirsch, Wiermann and six other real catalogue
documents, but their current source availability and permission scope were
not established in this inventory. The reports explicitly call their old
labels **model judgments with adjudication**, not human ground truth.
[Historical inventory and label limitations](grounding-lab-performance-report.md).
The later full-Beier segmentation observation likewise reports no inspected
gold. [Catalogue validation record](../validation/2026-09-23-grounded-catalogue.md).

## Proposed small human-gold plan

1. Begin with Beier as a development-only source group. Pin source bytes,
   parser/model artifacts, Source Representation Revision and schema. Retain
   derivatives in that group; keep copyrighted source material outside Git.
2. Have a human inspect a metadata-selected sample of 20 PDF pages, including
   adjacent-page pairs and front/back matter. Map PDF pages to printed pages
   or spread units. Register selection before viewing model outcomes.
3. Label every record intersecting those pages and follow boundary records
   onto neighboring pages. Annotate raw values, explicit absence/illegibility,
   acceptable alternatives and arrays, semantic supporting passages, and
   separate exact-value spans. Record whether each annotation is available;
   inherited headings and distributed evidence may need multiple anchors.
4. Two humans independently label an initial 30 records, reconcile guideline
   disagreements, then one completes the page sample and the other audits
   all boundary/ambiguous cases plus 20% of remaining records. Preserve both
   original labels and adjudication. Report actual complete record counts and
   disagreements; do not invent a target count from segmentation predictions.
5. Store gold in evaluator-only files. Existing model outputs may assist
   navigation after blind annotation, but never supply authoritative labels.
   One catalogue cannot establish transfer; obtain another authorized source
   family before a FREE catalogue holdout study.

For a later ExtractBench final comparison, freeze A0 and one development-selected
challenger, the evaluator, parser pins, requests, recovery and call/token
budgets before opening the eight held-out groups. Run both on the same groups
once; report paired per-group differences, raw and canonical value scores,
record completeness, annotated evidence components, failures and actual cost.
Keep missing evidence annotations unavailable. Verifier flags, if evaluated
later, are error-detection decisions with false positives/negatives and review
workload, not automatic F1 improvements. This is a proposed protocol; the
holdout remains untouched.
