# Grounding lab: design notes

Status: explanation only. This document changes no code. It gives the reason
for each part of the grounding lab, the other options, and their effects. It
also says which parts reached production and why the other parts must stay in
the lab. The text follows ASD-STE100.

Sources: `prototypes/grounding_lab` on branch `experiment/radical-context-prune`
(`AUDIT.md`, `HANDOFF.md`, `README.md`, `experiments/2026-09-05/EVALUATION.md`,
`experiments/2026-09-05-bounded/RESULTS.md`), and the production code in
`packages/extraction/src/grounding.ts` and `lexical.ts`. The lab code is not on
`dev`.

Diagrams: [`docs/architecture/grounding.c4`](../architecture/grounding.c4).
Run `pnpm architecture:dev` and open the views `grounding_boundary`,
`evidence_linking_vs_validation`, `grounding_lab_policies`, and
`grounding_lab_policy_e`.

## 1. Two steps: evidence linking and validation

FREE has two steps after extraction. They have different owners. Do not mix
them.

**Evidence linking** is a model step. The Extraction module makes one claim
for each populated value. It selects the candidate anchors. For an Article
run, the candidates are all canonical anchors. For a Catalog run, the
candidates are the anchors inside the record slice. The pinned model then
proposes one candidate anchor for each claim, or none. After that, the lexical
check adds two facts to each link without a model: `verbatim` (the value is a
bounded token of the linked passage) and `lexicalHits` (how many candidate
anchors contain the value). A value without a link makes the extraction
"incomplete". Nothing is accepted at this step.

**Validation** is the researcher's step. Studio shows each value, its linked
passage, and a "Check" badge when a doubt exists. The researcher approves,
edits, or rejects each value. Finalization needs an explicit decision for each
eligible value. No score is shown and no link is accepted automatically.

The lab policies decide three outcomes for each claim: link, review, or
abstain. "Review" sends the link to the validation step with a flag. "Abstain"
gives no link. Production has no such routing. A lab policy can enter
production only as a badge reason, never as a decision.

## 2. The question and the verdict

The lab asked one question: can a tiered grounder without a model (lexical
containment, then a small cross-encoder inside the lexical hit set) replace
model evidence linking, when the aim is to catch extractor errors for a
reviewer?

The verdict of the audit: no production replacement is established. Keep
links as reviewer suggestions. Do not accept links automatically. The lexical
tier is the only part that reached production, and it reached production as a
doubt, not as a decision.

## 3. Parts of the lab

Each part gives the reason, the other options, and the effects.

### 3.1 Anchor dump with row and column context

- Reason: The policies and the labelers must see the same anchor texts as the
  production grounder. Table cells need their row and column headers, or a
  bare number has no meaning.
- Other options: Use the production `anchorText()` directly. It gives the
  scorer only the cell text and cuts a cell at ` | `.
- Effects: The lab gives the scorer more context than production. The first
  dump gave header cells the whole row as context. This bug caused 28 of the
  33 wrong links of the first LLM baseline. The dump is corrected.

### 3.2 Claims from the real extractor with blind labels

- Reason: The first datasets copied each claim value out of an anchor by hand.
  Then 248 of 283 linkable claims could not produce a wrong link, and policy E
  showed 372 of 382 correct. The number measured the labels, not the pipeline.
- What the lab does now: It runs the real extractor with a realistic schema,
  samples 60 emitted leaves per document, and gives them to a labeler who
  does not see the pipeline, its reports, or earlier labels. Each claim keeps
  the other scalar values of its record as siblings.
- Other options: Keep the hand-written claims (regression fixtures only).
  Constructed trap sets (kept as a diagnostic: 40 single-hit traps).
- Effects: The headline set has 360 claims, 256 supported and 104
  unsupported. The first blind set moved policy E from 97 percent to 55
  percent. Labels of the frozen experiments are model-generated and are not
  human ground truth.

### 3.3 Lexical tier: normalization and bounded containment

- Reason: A value that occurs once in the document as a bounded token is a
  strong location signal. A value that occurs many times needs a scorer. A
  value that occurs never is absent or paraphrased.
- What it does: `normalize` folds case, Unicode, dashes, dates in six
  languages, digit grouping, decimal commas, currency glue, and digit-to-unit
  splitting. `bounded_contains` matches whole tokens. One hit links, zero
  strict hits fall back to whitespace-tolerant hits, no hits abstain.
- Other options: Plain substring search (matches `18` inside `1834`). Fuzzy
  matching (turns wrong links into "verbatim" ones).
- Effects: 27 of 256 supported values have no lexical hit: soft hyphens in the
  OCR, values composed from two cells, expanded abbreviations, a year inside a
  date. No scorer can find them. This tier is ported to production as
  `lexical.ts`; the lab test cases are replayed in `grounding.test.ts`.

### 3.4 Policy E: a cross-encoder inside the hit set

- Reason: When several anchors contain the value, a small scorer can select
  the correct one with the field name and the sibling values. It is cheaper
  than a large model.
- What it does: Nemotron 1B scores each hit. The clipped margin between the
  two best scores decides: above the accept threshold, link; between the
  thresholds, review; below the abstain threshold, abstain.
- Other options: More rerankers (the audit forbids new sweeps). A bi-encoder
  shortlist over all anchors (the hit set already limits the candidates).
- Effects: On the 360-claim set, E links 160 of 256 supported values and makes
  61 wrong links. Its confidence is not a confidence: a single hit gets 1.0
  and a neural link gets a clipped margin, so correct and wrong links share the
  maximum. On full catalogues, E gave wrong evidence for 939 of 1,852 values.
  The median latency is 28 ms per claim; the p95 is about 1 s.

### 3.5 Sibling gate and bare-number narrowing

- Reason: A single hit under the wrong field is the trap that E links at 1.0.
  A bare number (four characters or less, no unit) has hit sets up to 174
  anchors.
- What it does: A single hit whose page neighbourhood (three anchors on each
  side) and table row hold no sibling value goes to review. A bare number
  links only through a sibling-supported hit, and its hit set is narrowed to
  those hits.
- Other options: Policy H (score every single hit): it caught 20 more traps
  but sent 65 correct links to review. Dropped.
- Effects: Errors caught go from 77 to 84 of 104 at frozen thresholds; wrong
  links go from 61 to 52; the p95 latency halves. The gate cannot see
  top-level fields: 32 of the 40 traps have no sibling.

### 3.6 Row-pruning ablations

- Reason: Test whether candidate narrowing alone improves E.
- What they do: Keep exact-value cells whose own row contains a sibling; fall
  back to the full hit set; always score a pruned singleton.
- Effects: Both variants keep all recoverable gold anchors but pass six fewer
  correct values, and they improve the p95 in one of three repetitions only.
  Rejected. Retain E.

### 3.7 LLM as scorer under the same contract

- Reason: Compare a large model with the cross-encoder when both see the same
  input: field name, siblings, and the hit set.
- Effects: 251 of 360 correct and 36 wrong links, the best scorer, at 5.2 s
  per claim. This was never compared with the production grounder, which sees
  all candidates and not only the hit set.

### 3.8 Quote-only evidence and the quote/E hybrid

- Reason: If the extractor emits the source quote with each value, a
  deterministic search can locate the evidence without a scorer.
- What it does: The quote arm asks for one quote per value. The lab locates
  the quote with whitespace normalization only and keeps every occurrence.
- Other options: The hybrid: when the quote is not unique, propose E's best
  candidate.
- Effects: On the same Conrad values, quote-only gives 210 correct evidence
  selections against 185 for E, with 18 against 81 wrong anchors, but 40
  against 2 missing selections. It is slower. Three of the four holdout quote
  attempts failed on the output budget. The hybrid adds 17 correct links and
  26 wrong suggestions: do not promote it. Quote-only stays the evidence
  candidate; harden it on development data first.

### 3.9 Review risk scores

- Reason: Order the review queue by the probability of an error.
- What it does: `review_risk` fits separate value risk and evidence risk
  scores with leave-one-document-out, and combines them.
- Effects: The joint queue has an error precision of 1.000, 0.944, and 0.967
  at review depths 1, 3, and 5, but its Brier scores are near 0.14 and the
  training families overlap the test families. These are development
  diagnostics, not production confidence. They must not authorize acceptance.

### 3.10 Latency measurement

- Reason: A grounder that is accurate but slow does not help the workflow.
- What it does: The lab measures the whole per-claim path after one anchor
  normalization per document, and reports the median and the p95.
- Effects: Timings on the desktop are noisy. Repetitions are repeated inputs,
  not independent observations.

### 3.11 Frozen experiments

- Reason: Numbers that tune thresholds must not evaluate them.
- What it does: The 2026-09-05 experiment freezes code, schemas, prompts, and
  risk parameters before the holdout labels open. Two blind labelers and one
  adjudicator label each family. Failed attempts stay failed.
- Effects: Four of eight full-source extraction calls failed. Only Kirsch has
  two valid arms. Bauer is a transfer case because of prior overlap. The
  labels of this experiment must not tune any reported policy.

## 4. Parts that reached production

### 4.1 `verbatim` and `lexicalHits` on each Evidence link

- Reason: The lab found that one confidence number gives correct and wrong
  links the same maximum. Two separate doubts are more useful to a reviewer.
- What it does: Each link records whether the value is a bounded token of the
  linked passage, and in how many candidate anchors it occurs. Studio shows
  "Value not found in the linked passage" or "Value also appears in N other
  passages", and a "To check" count.
- Other options: A score (rejected by the audit). Routing to a review bucket
  (production has no routing).
- Effects: Booleans get no check. Links stored before the change carry no
  flags. Nothing is accepted automatically.

### 4.2 Full port of the lab normalization

- Reason: The first port folded only case, Unicode, dashes, and decimal commas.
  Dates, digit grouping, and currency rules were the known limit.
- Effects: `normalizeLexical` now matches the lab rule for rule. Change both
  together.

### 4.3 `lexicalHits` counted in the record slice (PR #132)

- Reason: Catalog grounding shows the model only the record slice, but the
  count scanned the whole document. A code repeated in each entry got the
  warning "also appears in N other passages" although no other passage was a
  candidate. The Bauer run had 1,287 such warnings.
- Other options: Keep the document-wide count as a value doubt. Extraction
  works on one slice, so this signal had no action.
- Effects: The count now matches the candidates. Article runs and stored links
  do not change.

## 5. Parts that must stay in the lab

- Automatic acceptance of any link: rule 6 of the audit.
- E as a replacement grounder: no production replacement is established, and
  E gives wrong evidence for about half of the values on full catalogues.
- Row pruning: rejected. Policy H: dropped. Quote/E hybrid: do not promote.
- Quote-only extraction: a candidate, but three of four holdout attempts
  failed, and it changes the extraction prompt, not the linking step.
- Risk scores: not calibrated.
- The production model limited to the lexical hit set: never compared with
  the production grounder, and the paraphrase class would get no link.

## 6. Next steps from the audit

1. Separate the two doubts in the contract: value risk and evidence risk, each
   visible to the reviewer. Neither authorizes acceptance.
2. Instrument first: carry route, candidates, raw scores, structural identity,
   and timings through a production-shaped replay.
3. Preserve the frozen evaluation. Obtain new independent families before any
   calibration.
4. Harden quote emission on development data.
5. Only then test the non-model replacement, with E's routing shape.
6. Do not accept links automatically, compare more rerankers, or tune on the
   fixtures.

## 7. Headline numbers

The 360-claim extractor-output set (256 supported, 104 unsupported). "Errors
caught" are unsupported values that got no link or a review flag.

| Policy | Correct | Supported links | Wrong links | Errors caught | Median ms | p95 ms |
|---|---:|---:|---:|---:|---:|---:|
| E, frozen thresholds | 230/360 | 160/256 | 61 | 77/104 | 28 | 1,053 |
| E + sibling gate, frozen | 233/360 | 155/256 | 52 | 84/104 | 15 | 366 |
| E, blind-tuned | 234/360 | 154/256 | 41 | 86/104 | 27 | 1,116 |
| E + sibling gate, blind-tuned | 224/360 | 145/256 | 39 | 87/104 | 16 | 381 |
| LLM as scorer, same contract | 251/360 | 168/256 | 36 | 83/104 | 5,238 | – |
| Single hits pass, every hit set to review | – | 79/256 | 0 | 94/104 | – | – |

Do not quote the earlier 372 of 382. It measured the labels.
