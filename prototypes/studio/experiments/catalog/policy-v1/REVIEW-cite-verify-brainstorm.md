# Brainstorm on the cite-and-verify strategy (gpt-6-astra via omp, 2026-09-09)

## Brief

# Brainstorm: "cite and verify" as the next Catalog policy

Context as in the previous two briefs (FREE Catalog mode, policy v1 now default: five records per values call, five per field-aware grounding call; acceptance run on the full Beier catalogue: 213 calls, 92 min, grounding 84 calls, 379k input and 54k output tokens, 31.6 min). Answer in under 1,000 words. Design the strategy with me, name its failure modes, and specify the experiment and gate. Disagree where warranted.

## The observation

After the values call the record slice a value came from is certain by construction: the executor scopes evidence to that slice and validates every link against it. So the separate grounding call is not establishing the record. It does two things: locate the block inside the slice (a Beier entry is about ten blocks; links and doubt flags are per block), and check that the value is stated at all (NONE for inferred, normalised or borrowed values).

On the acceptance run, of 3,481 claims: 3,162 (91%) were found verbatim in exactly one block of their slice, 289 (8%) in no block, 30 in several. For the 91% the model call adds only the "same string, other meaning" trap check. For the 8% it does real work.

## What was already measured

- `policy-v1` arm on the 29-entry excerpt (lexical single-hit links in code, grounder only for the rest, grouped, field-aware): 156/164 supported against 164/164 for full grounding. Two trap links (an axis value present verbatim in a pavement sentence; a similar short code) and six NONE answers from the grounder on the leftover claims once it saw only hard ones.
- Your "Luna batches of 5 · joint evidence" arm (value plus evidence label in one call, no verification): 9 calls, 201–202/203 values, 160–163/164 supported, precision 98.2–99.4%.

## The proposed strategy

1. Values call as today, but each field value is accompanied by a citation of the block it was taken from. Open question: how the slice is rendered. Today it is plain markdown under `### Record R<n>`; citations need labels, so either render the slice as `[E<n>] text` lines (as the grounding prompt does) or cite by a block ordinal within the record, or by quoting the block's first words. Which, and does labelling the blocks hurt extraction?
2. Code verifies each citation: the cited block must belong to the claim's record and must contain the value as a bounded token (the existing `lexicalCheck`). Verified claims get an evidence link with `verbatim: true` and `lexicalHits` computed over the slice, and no model call. A code-verified link would be a new kind of evidence for the reviewer; should the link carry a `linkedBy: citation | model` marker?
3. Unverified claims (no citation, citation outside the record, value not verbatim in the cited block) go to the existing field-aware grounder with the full slice, grouped as today, which can still answer NONE. On this run that is roughly 9% of claims: perhaps 10 grounding calls instead of 84.
4. Doubt flags unchanged: `verbatim`, `lexicalHits`, ungrounded paths, NONE.

Expected on the acceptance run: about 25 of 92 minutes and about 340k of 925k input tokens saved; a few tokens per value added to the values output.

## Failure modes I see

- Trap acceptance: a value verbatim in exactly one block of its slice but under another meaning is accepted silently. Two of 164 on the excerpt. Mitigations: route short or coded values (under N characters, `allowedValues` fields, or specific field types such as axis codes) to the grounder always; or audit a random sample of verified links with the grounder; or verify the citation against the field's own sentence rather than the block.
- Citation drift: the model cites the wrong block while the value happens to be verbatim there too (repeated passages). The `lexicalHits > 1` flag already marks these.
- Values output cost and format: citations per field in JSON, and how to represent citations for list fields (one per item).
- Extraction regression from labelled blocks in the values prompt, if that rendering is used.
- The NONE cascade seen before: a grounder that only sees hard claims abstains more. Is that a defect or the right behaviour on values that are in fact not stated?

## Questions

1. Is the strategy sound, and what would you change? In particular the rendering for citations and the verification rule (block-level bounded token match; anything stricter or looser?).
2. Which failure mode is the real one and what is the cheapest mitigation that keeps NONE and the doubt flags intact?
3. Experimental design on the excerpt (reference: 203 values, 164 supported fields, precision 1.000, known traps) and on the three Danish reports (fixed-denominator references and adjudications exist): arms, metrics, gate. What must be identical to policy v1 to attribute differences to the strategy?
4. Should a citation-verified link be distinguished from a model-judged link in the reviewer UI and the persisted data, or is `verbatim: true` already that distinction?
5. Is there an even simpler variant: skip citations, and for each value do the lexical search over the slice in code; if exactly one block contains it, link; otherwise ground. That is the rejected `policy-v1` arm. What would make the cited version better than it, in your view, beyond the model having chosen the block?


## Reply (verbatim)

## Decision: promising experiment, not yet a safe default

The strategy is sound as **citation-assisted linking**, not semantic verification. A bounded match proves that the value occurs in the cited block; it does not prove that the block supports the field. Having the extractor choose that block adds useful information, but not an independent check.

Your measurements justify testing it. They do not yet justify accepting every lexically valid citation: the joint-evidence arm already showed imperfect support, and the lexical arm exposed precisely the semantic error this verifier cannot detect.

Also, distinguish **current default v1/full grounding** from the **earlier lexical-shortcut arm** in experiment names.

## 1. Rendering and verification

Use explicit, record-scoped block labels, backed by the executor’s block map:

```text
### Record R12
[E1]
<original block, preserving its markdown>

[E2]
<original block, preserving its markdown>
```

Do not flatten blocks into lines or cite opening words. Ordinals are acceptable only when explicitly rendered; asking the model to count blocks introduces avoidable ambiguity. Resolve `(record, label)` to the actual block ID in code.

Keep value semantics and downstream representation unchanged. Return citations separately, keyed by existing atomic claim paths: one nullable citation per scalar or list item. Resolve those paths before transformations that could reorder list items.

Verification should require:

- Citation resolves to a block in the claim’s record.
- Existing bounded `lexicalCheck` succeeds there.
- The claim is eligible for the shortcut under a frozen risk-routing rule.

Do not loosen lexical matching to recover normalised values. Those belong with the grounder. Compute `lexicalHits` over the full slice using the existing definition.

Sentence-level matching is not a general semantic fix: it still needs to determine what the sentence says about the field, and may mishandle tables or heading-dependent text. Avoid adding a second miniature grounder in code.

Whether labels hurt extraction is empirical; preserve formatting and measure it separately.

## 2. Real failure mode and cheapest mitigation

**Wrong-field support is the release-blocking failure.** Citation drift is one mechanism, but even a unique occurrence can mean the wrong thing. `lexicalHits > 1` detects ambiguity, not semantic correctness.

Cheapest plausible mitigation: always ground a small, predefined set of high-risk fields—starting with the known axis/code traps—and initially ground all multi-hit claims. Retain the existing flags regardless of routing.

Prefer field semantics over a universal character threshold. Shortness and `allowedValues` are useful risk indicators, not reliable classifiers. Freeze the routing rule before evaluation; otherwise the excerpt becomes a training set.

A random audit measures residual risk but does not prevent individual bad links. Use it during evaluation, not as the sole safety mechanism.

The NONE cascade is not inherently a defect. Hard-only claims should have lower support rates. It becomes a defect when the grounder rejects genuinely supported claims because its batch context changed. Compare identical claims under full and hard-only grounding, with independent adjudication. Never suppress NONE or add easy claims merely to encourage acceptance.

## 3. Experiment and gate

### Arms

Use cached outputs to avoid confounding extraction changes with linking changes:

| Arm | Extraction | Linking |
|---|---|---|
| A | Current prompt | Current full grounding |
| B | Labels + citations | Full grounding; citations ignored |
| C | Same outputs as B | Citation verification, remainder grounded |
| D | Same outputs as B | C plus frozen risk routing |
| E | Same outputs as B; citations ignored | Unique lexical hit, remainder grounded |

A→B measures the combined extraction intervention. B→C measures skipping verification. C→D measures mitigation. C→E isolates the value of choosing a block rather than merely finding one.

If B regresses, add a labels-only extraction arm to separate rendering from citation-output burden.

Hold identical: model/version, decoding settings, record slices/order, five-record batching, schema, extraction instructions except citation requirements, normalisation, lexical checker, grounder prompt/full-slice access, grouping algorithm, retries, and reference adjudications. Routing necessarily changes grounding batch composition; record it.

### Metrics

On the excerpt and each Danish report separately:

- Recovery against the fixed value reference—not raw output count.
- Supported-field recovery against the fixed support denominator.
- Link precision, wrong-field links, wrong-record links.
- Incorrect NONE versus correct abstention, especially hard-only transitions.
- Missing/invalid citations, shortcut eligibility, fallback calls.
- End-to-end latency, input/output tokens and cost, including retries.

Adjudicate new disagreements blind to arm; retain all known traps. Repeat extraction runs to expose variability. Report pooled and per-report results.

### Gate

For D to advance:

- Recover the excerpt’s 203 reference values and 164 supported fields, with no incorrect accepted links.
- No regression against each Danish report’s fixed-denominator reference.
- No missed known traps, wrong-record links, or increase in incorrect NONE.
- A predeclared material efficiency gain; I suggest at least 20% lower end-to-end latency without increased total cost.

Zero observed errors is an advancement gate, not proof of perfect population precision. After passing, run the full Beier catalogue in shadow mode and adjudicate disagreements before changing the default.

Treat “10 calls” and the projected savings as hypotheses: fallback calls depend on claim distribution across record batches, not just the 9% claim fraction.

## 4. Provenance and the simpler variant

Persist a separate provenance field, for example `linkedBy: citation_lexical | grounder`. `verbatim: true` describes textual occurrence, not who established the link or how. Preserve existing doubt flags.

In the reviewer, expose this as “Citation + text match” versus “Grounder-judged”; do not label the former simply “verified.”

The cited version has two potential advantages over lexical search: selecting the intended block among repetitions, and encouraging source-aware extraction. Neither guarantees semantic support. If C/D does not outperform E on independently adjudicated support, citations have not earned their output cost. The simpler variant remains preferable—but only if it passes the same gate that its earlier version failed.
