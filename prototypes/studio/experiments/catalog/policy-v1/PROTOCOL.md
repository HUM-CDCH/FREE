# Catalog policy v1: protocol

Written before the first frozen run. The question: can the production Catalog
executor make far fewer model calls without losing values or evidence quality,
using only the call-structure changes both labs support? Nothing here accepts
a link automatically, scores a link, or tunes a threshold.

## Policy under test

`CatalogPolicy` in `packages/extraction/src/catalog.ts`, read by Studio from
`FREE_CATALOG_POLICY`:

- `recordBatchSize`: records per values call. Each slice sits under a
  `### Record R<n>` heading; the response must return every identity once, in
  order, or the batch falls back to one call per record.
- `lexicalLinks`: a claim whose value is a bounded token of exactly one
  candidate anchor in its record slice links in code (`verbatim: true`,
  `lexicalHits: 1`) and is not sent to the grounder.
- `groundingGroupSize`: records whose unresolved claims share one grounding
  call. Each claim is validated against its own record's anchors.
- `fieldAwareGrounding`: the grounder receives each claim's record, field
  name and schema description.

Discovery is unchanged. The default policy reproduces today's behaviour.

## Arms

| Arm | batch | lexical | group | field-aware | values model |
|---|---:|---|---:|---|---|
| baseline | 1 | off | 1 | off | qwen3.8 |
| batch-only | 5 | off | 1 | off | qwen3.8 |
| policy-v1 | 5 | on | 5 | on | qwen3.8 |
| policy-v1-b3 | 3 | on | 5 | on | qwen3.8 |
| policy-v1-nuextract | 5 | on | 5 | on | NuExtract3 Q4_K_M |

Two repetitions per arm, arm order rotated across repetitions, requests
serial. Discovery and grounding use `qwen3.8:latest` (27B Q4_K_M) on the
local RTX 4090 through the production Ollama adapter; the Spark server was
not reachable when the experiment started. NuExtract uses the production raw
adapter. Both are the models the production route uses, at their production
settings.

## Inputs

- Beier excerpt: `artifacts/catalog-lab/beier/parsed_document.json`, the
  frozen seven-field `schema.ts`, scored against `beier.reference.json` with
  `evaluate.py` (29 records, 203 values, 164 populated fields).
- Transfer set: the five Danish grave reports under
  `artifacts/catalog-lab/examples-transfer-v1/*/parsed_document.json` with the
  same schema, paired with their existing `prod-qwen-r2` production runs. No
  value reference exists; every populated value of both arms is labelled blind
  (labeller sees only the document text and an unlabelled sheet).

## Gates, fixed before running

- G1 identity: every boundary yields exactly one record in every batch run;
  single-record fallbacks at most 5% of batches.
- G2 calls: non-discovery calls at most 40% of the baseline arm's, on Beier
  and on each Danish document.
- G3 Beier: correct values at least baseline minus one (of 203), supported
  fields at least baseline (of 164), evidence precision at least baseline,
  29 of 29 records.
- G4 transfer: no link into another record; blind-labelled wrong-anchor rate
  at most the baseline's; supported-link coverage at least baseline minus five
  points.
- G5 lexical links: wrong-anchor rate among links made in code at most that
  of links made by the model. If G5 fails, rerun with `lexicalLinks: false`
  and gate again.

A failed gate keeps the default policy unchanged. Passing all gates flips
`DEFAULT_CATALOG_POLICY` to the winning arm; the env override stays.

## Freeze

`suite.py --freeze` records SHA-256 hashes of the harness, the scoring inputs
and the production files the executor imports (`FROZEN_FILES` in `run.ts`)
and refuses to run when any of them changes. Run directories are never
reused; failed runs stay. `report.py` generates `RESULTS.md` from
`result.json` and `evaluate.py`; no number in it is typed by hand.

## Deviations recorded after the runs

- The Spark route was unreachable; every arm ran on the local RTX 4090
  (`qwen3.8:latest`, NuExtract3 Q4_K_M). Seconds are therefore local
  figures, and the ablation arms below shared the GPU with the transfer
  suite, so their seconds are not comparable.
- The pre-registered policy arms failed G3 on Beier (lexical links linked
  the wrong passage on two traps and the remaining grouped claims drew a
  NONE cascade). Five exploratory arms were added to `suite.py` after
  inspecting those runs: `batch-group-field`, `batch-group`,
  `policy-v1-nofield`, `policy-v1-g1`, `policy-v1-g1-nofield`.
  `batch-group-field` passed every Beier gate and was confirmed with two
  further Beier repetitions and one run per Danish report before adoption.
- `DEFAULT_CATALOG_POLICY` was flipped after the Beier runs and reverted
  the same day: with coverage evaluated over a shared denominator, the
  candidate fails G4 on Herredsvejen and Hojbakkegaard, and G2 on Hvissinge
  (3 calls against 6). The candidate is `CATALOG_POLICY_V1`, opt-in through
  `FREE_CATALOG_POLICY`. The frozen hashes of `catalog.ts` and `module.ts`
  no longer match (default revert, batch validation and routing-key fixes),
  so the roots are closed; every run passed its policy explicitly and the
  fixes do not change a successful batch's prompt or result.
- The review also corrected the checks: `report.py` evaluates coverage and
  the wrong-anchor rate from the labelled sheet, counts only single calls
  for a slice a rejected batch already carried as fallbacks (the recorded
  runs have none), and `suite.py` refuses an input whose hash differs from
  the frozen one.


## Revision 2: per-record against the candidate on the Danish schema

Pre-registered 2026-09-09 before the first run. The failed transfer gates
were measured with the Beier schema on Danish reports, a schema mismatch.
Astra's `models-policy-v2` root ran the candidate under a Danish grave
schema but never ran the per-record policy, so the gates stay unresolved.

- Input: the five parsed Danish reports frozen in
  `artifacts/catalog-lab/models-policy-v2/inputs/<doc>/baseline/`.
- Schema: `danish` from `models-policy-v2/schemas.ts` (`run.ts --schema danish`,
  now a frozen file).
- Arms: `baseline` (per-record, today's default) and `batch-group-field`
  (`CATALOG_POLICY_V1` exactly). One repetition: Qwen at temperature 0 gave
  byte-identical outputs across repetitions in every recorded run.
- Scoring: `score_danish.py` applies Astra's frozen `references-v1.json`
  and `adjudications-final.json` through `models-policy-v2/score.py`
  unchanged; values or links without a decision are listed as pending and
  adjudicated against the source text in a new decisions file before the
  gates are read. Katrinesminde is reported but excluded from the gates:
  its reference credits eleven graves that the schema tells the model to
  exclude.
- Gates: G1 and G2 as before; G4 on the fixed denominator: correct units
  and supported-link units of the candidate at least the baseline's minus
  5% of the denominator, no more wrong-record or wrong-passage links, no
  more unsupported values.
- Roots: `artifacts/catalog-lab/policy-v1-danish/<doc>/`, frozen per document.

### Revision 2 deviations, recorded after the runs

- The candidate's values on the Danish schema differ from Astra's run of
  the same policy, input and model by one unit on Herredsvejen and
  Hvissinge; local Ollama is not bit-reproducible across processes, so a
  second repetition would have measured that noise, not the policy.
- The two-record batch on Katrinesminde was rejected (the model returned
  `R1` for both records); both records re-ran one per call with the same
  values. G1 would fail there (2 fallbacks of 1 batch), but Katrinesminde
  is not gated.
- The 66 decisions for the per-record arm were made by the agent that ran
  the comparison, with arm labels visible, applying the rules recorded in
  Astra's adjudications (body deposition counts as a stated rite; stones,
  human remains and find inventory numbers are not grave goods; values on
  an unbound record are unsupported).
- `pnpm lint` failed on two unused bindings in `models-policy-v2/run.ts`;
  fixing them changed a file frozen in that root, which was already
  complete (88 of 88 runs, final report written), so that root is closed.

## Gate revision (2026-09-09, after the revision 2 results)

G2 as pre-registered (candidate non-discovery calls at most 40% of the
per-record arm's, per document) cannot hold on small documents: with five
records per batch and per group, three records cost one values call, one
document-level values call and one grounding call, and three is more than
40% of seven. Revised G2, applied to every root by `report.py` and
`score_danish.py`: the 40% ratio applies where the per-record arm makes at
least ten non-discovery calls; below that, the candidate must make no more
non-discovery calls than the per-record arm. This revision was decided
after seeing the revision 2 results and is recorded as such. G4 is
unchanged: its wrong-link criterion is the pre-registered rate per
document, wrong links over linked units.

## Reconciliation after the second opinion (2026-09-09)

A second opinion (`REVIEW-g4-second-opinion.md`) found three contradictions
in this file and the scorer; they are recorded here rather than edited out.

- The original G4 compares a wrong-anchor *rate*; the revision 2 text above
  says "no more wrong-record or wrong-passage links", a *count*. The scorer
  implemented the count first and the rate from commit `c0ff54f6`. Both
  readings fail Herredsvejen (1 against 0; 0.067 against 0.000).
- The gate-revision note says "wrong links over linked units"; the scorer
  divides wrong links by supported-link units plus wrong links. The scorer's
  definition stands; the note was imprecise.
- The unsupported-values criterion was pre-registered in the revision 2
  text, contrary to what the brief said, and stays.
- G1 pooled over revision 2: one of seven batches was rejected
  (Katrinesminde, `R1` returned twice), 14%, above the 5% threshold. The
  gated reports had no rejection; Katrinesminde is outside the gates because
  of its reference, which does not erase this observation.

The second opinion also objects that the G2 floor creates a cliff at ten
per-record calls and that a prospectively specified overhead allowance
(candidate calls at most 40% of the per-record calls plus a fixed number for
document-level calls and rounding) would have an operational rationale the
floor lacks. No further gate change is made without an explicit decision.

## G2 reformulated, and the human review queue (2026-09-09, after a brainstorm with GPT Astra)

The floor above is superseded. The second opinion objected that it creates
a cliff at ten calls with no operational rationale, and proposed a scope
correction instead (`REVIEW-g2-brainstorm.md`), adopted as follows.

- G2 compares only the calls the policy changes: record values calls and
  grounding calls, every attempt counted (a rejected batch and its fallback
  singles all count). Discovery and document-level values calls are
  identical in both arms by construction and are excluded from both sides;
  total non-discovery calls are reported next to the ratio, because scoped
  savings are not runtime savings.
- Per document, as pre-registered: candidate at most 40% of the per-record
  arm. A document whose per-record arm made no such call is not evaluated;
  a run that threw is not an efficiency pass.
- 40% is a declared budget: with full five-record batches the ideal is 20%,
  so 40% allows twice the ideal cost. Two-record documents can fail without
  any fallback; that is the intended reading.
- Outcomes: Beier 12 against 58, Herredsvejen 2 against 6, Hojbakkegaard 4
  against 18, Hvissinge 6 against 24 pass. Katrinesminde fails, 4 against 4
  (one batch, rejected, both records re-run), and fails G1 (one fallback of
  one batch); its exclusion from G4 because of its reference does not
  exclude it here. Hvissinge under the Beier schema fails, 3 against 6:
  the per-record arm produced no values and so no grounding call, while
  the candidate produced five values and one grounding call, a
  claim-eligibility confound that a scoped ratio cannot remove.
- This is the second post-hoc amendment of G2. A gate chosen after the
  results needs fresh confirmation on documents not used to choose it
  before it counts as passed; none has been run.

Human review of uncertain adjudications, decided by the user: an
adjudication is final without human review only when the value is an exact
alias or a punctuation/inflection variant of a reviewed unit, the record
binding is explicit, and the link was accepted as directly supporting that
record. `review_queue.py` builds the sheet from every other decision of
both agents, in tiers: tier 1 holds every negative decision (unsupported,
wrong-record, wrong-passage, unbound record) and every disagreement between
the agents, the decisions that penalise an arm and can move a gate; tier 2
adds values and links accepted by judgment; `--all` adds the mechanical
ones. Sizes on the Danish schema: tier 1, 134 items on the three gated
reports and 158 with Katrinesminde; tier 2, 531; all, 569. The sheet shows
the field rule, the value, the record identity, the reference units, and
the linked passage with its pages; it hides the arm, the model and the
prior decisions, which a private map keeps for rescoring. Decisions apply
to both arms under one rule; `score_danish.py --reviewed` re-reads the
gates. Until then G4 is reported as provisional, numerically established G2
and G1 failures as failed, and the policy as not approved.

## Review outcome (2026-09-09)

The user delegated the tier-1 review to Claude. It was made from the sheet
and the source text only, with the arm, the model and the prior decisions
hidden; it is an agent review, not independent human validation, and the
reviewer had earlier made 66 of the decisions under review. One rule per
class, applied to both arms (`review-sheet.filled.json`,
`adjudications-review-tier1.json`): skeletal remains, stones, structure
parts, traces, comparison sites, recording methods, objects of another
grave, hypotheses, inventory numbers and flotation samples are not grave
goods; a direction of the body, head, limb or a landscape feature is not a
grave axis; a generic noun, body position or another grave's type is not a
grave type; a boat part, shroud conjecture, construction term or
reconstructed sequence is not a rite; a report-level period or a date of
parallel finds is not this grave's date; values on the loose-remains
record are unbound. Two readings differ from the earlier agent decisions
and were applied to both arms: an axis or period stated for the grave with
a dropped hedge word (omtrentlig, forsigtigt, formentlig) counts as
correct, a precision loss rather than a wrong value (four values); and the
A240 brandgrave link is supported, because the passage states burnt human
bones and a pyre-burnt comb in that grave. Outcome, 134 items: 4 values
correct, 121 unsupported, 6 links (1 supported, 4 wrong-passage, 1
wrong-record), 3 record bindings none; three further links surfaced by the
accepted values are supported. Sensitivities the user may wish to revisit:
20 axis values were rejected under the body-direction rule and 4 values
were accepted under the dropped-hedge reading; both arms carry them.

Gates after the review (`score_danish.py --reviewed`):

- **Herredsvejen_SBM1694**: G1 pass (fallbacks 0 of 1 batches); G2 pass (2 policy-sensitive calls vs 6; all non-discovery calls 3 vs 7); G4 pass (units 17 vs 14, links 17 vs 14 of 22, wrong-link rate 0.000 vs 0.000, unsupported 7 vs 9)
- **Hojbakkegaard_TAK_1177**: G1 pass (fallbacks 0 of 2 batches); G2 pass (4 policy-sensitive calls vs 18; all non-discovery calls 5 vs 19); G4 pass (units 61 vs 55, links 61 vs 54 of 66, wrong-link rate 0.000 vs 0.018, unsupported 6 vs 9)
- **Hvissinge_Ost_TAK_1728**: G1 pass (fallbacks 0 of 3 batches); G2 pass (6 policy-sensitive calls vs 24; all non-discovery calls 7 vs 25); G4 pass (units 39 vs 38, links 39 vs 38 of 49, wrong-link rate 0.000 vs 0.000, unsupported 21 vs 27)
- **Katrinesminde_SBM1116**: G1 FAIL (fallbacks 2 of 1 batches); G2 FAIL (4 policy-sensitive calls vs 4; all non-discovery calls 5 vs 5); G4 not gated (the reference credits graves the schema excludes)
- **Brondbylund_3_TAK_1506**: not gated (a run did not succeed)

Every gate passes on Beier, Herredsvejen, Hojbakkegaard and Hvissinge;
Katrinesminde fails G1 and G2 on its rejected batch. The default policy is
unchanged: G2 was amended twice after results and needs confirmation on
documents not used to choose it, and the review was delegated to an agent.

## Decision (2026-09-09)

The user accepted the candidate as the default (`DEFAULT_CATALOG_POLICY =
CATALOG_POLICY_V1`) on the evidence above, with the three caveats stated in
`docs/research/catalog-policy-v1.md`: the amended G2 is unconfirmed outside
the study, the tier-1 review was delegated to an agent, and the deployment
acceptance run on the full Beier catalogue is the verification still to be
done. The per-record policy remains reachable through `FREE_CATALOG_POLICY`.

## Acceptance run (2026-09-09)

`run.ts --schema beier-schema-revision-6.json --arm acceptance-v1` on the
full prepared Beier catalogue over the Spark route, compared with the
production run `5c2e6fbc` by `acceptance_compare.py` (`ACCEPTANCE.md`,
`docs/validation/2026-09-09-catalog-policy-v1-acceptance.md`): 213 calls
against 885, 420 records, complete, no cross-entry link, 92 against 106
minutes. The `--schema` flag now also accepts a saved Studio schema
revision file, so this file's hash and the run's are in its manifest.

## Revision 3: cite and verify

Pre-registered 2026-09-09 before the first run, after the brainstorm in
`REVIEW-cite-verify-brainstorm.md`. The observation: after the values call
the record slice a value came from is certain; the grounding call locates
the block inside the slice and checks that the value is stated at all. On
the acceptance run 91% of claims were found verbatim in exactly one block
of their slice.

Policy keys (`packages/extraction/src/catalog.ts`): `citations` renders each
record slice as the grounder's labelled blocks (the document's E labels)
and asks the values call for `_citations`, one label per scalar and one per
list item; `citationLinks` links a cited block in code when the value occurs
in it as a bounded token inside the claim's own record, with
`linkedBy: citation_lexical`, and sends every other claim to the grounder;
`groundAlways` names fields whose claims always go to the grounder;
`groundMultiHit` sends cited values found in several candidate blocks to
the grounder. A citation that resolves outside the record, or to a block
that does not contain the value, is ignored and the claim is grounded.

Arms on the 29-entry Beier excerpt, local `qwen3.8:latest`, one repetition
(discovery and values of C, D and E are replayed from B request for
request, so those arms differ from B only in linking):

| Arm | extraction | linking |
|---|---|---|
| A `batch-group-field` (existing runs) | current prompt | full grounding |
| B `cite-full` | labelled slices, citations requested | full grounding, citations ignored |
| C `cite-verify` | B's outputs | verified citations linked in code, the rest grounded |
| D `cite-verify-routed` | B's outputs | C plus the frozen routing: `burial_axis` and `find_type` always grounded, multi-hit values grounded |
| E `lexical-on-cite` | B's outputs | unique lexical hit linked in code, the rest grounded |

Frozen routing rule for D, chosen from the known traps before any run:
Beier `groundAlways = [burial_axis, find_type]`; Danish
`groundAlways = [burial_axis]`; `groundMultiHit` on. Comparisons: A to B
measures the prompt change; B to C the skipped calls; C to D the
mitigation; C to E whether choosing a block beats finding one.

Gate for D (and C) to advance, per Astra's design: `evaluate.py` recovers
203 of 203 values and 164 of 164 supported fields at precision 1.000 on
the excerpt with no incorrectly accepted link; no regression against each
Danish report's fixed-denominator reference; no missed known trap, no
wrong-record link, no rise in incorrect NONE; and a predeclared efficiency
gain: at least 20% fewer grounding input tokens and at least 20% lower
grounding time on the excerpt, with total cost not higher. If C or D does
not beat E on adjudicated support, citations have not earned their output
tokens. Passing leads to a shadow run on the full catalogue, not to a
default change.

Roots: `artifacts/catalog-lab/policy-v2-cite/beier` and
`policy-v2-cite/transfer/<doc>`, frozen per root.
