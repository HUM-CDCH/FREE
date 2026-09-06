# Blind labeling protocol — 2026-09-05

Defined before any holdout label is opened. Labels are model-generated, not
human ground truth. Each source receives two independent Codex agent contexts
(`fork_turns: none`) and a separate fresh adjudicator for disagreements.
Using the same agent platform does not make their errors statistically
independent; disagreement and unresolved counts must remain visible.

## Inputs and blinding

Each labeler receives only its original source PDF, canonical `document.md`
and `anchors.json`, parsed source coordinates, frozen schema/instructions,
and shuffled anonymized claims.
It may not inspect other experiment directories, sibling label files, policy
outputs, risk scores, extraction metadata, generated quotes or arm identities.
`recordContext` and scalar siblings are extracted assertions that locate the
intended burial, not trusted evidence. No earlier labels are supplied.

Every populated emitted scalar is included. Identical path/value/context
claims may be shared across outputs; nested inventory claims also require an
identical burial context to be deduplicated. The arm mapping stays outside
the blind directories. A family packet cannot be reshuffled after creation.

## Judgments

Write one object per claim ID, exactly once:

```json
{"claimId":"c0001","valueSupported":true,"goldAnchorSets":[["anchor_a"],["anchor_b","anchor_c"]],"note":"Source-backed rationale with page/record identity","status":"resolved"}
```

- Judge whether the original source supports the typed value for its intended
  field and record. Lexical occurrence alone is insufficient. Wrong records,
  wrong fields, negated assertions and inferred/computed values are errors.
  Numeric type rendering (for example decimal comma versus decimal point)
  does not change the number; suffixes, qualified values and units matter.
- Respect explicit local units and any source-declared default. Do not infer
  individual counts, sex, chronology or dimensions from illustrations or
  archaeological expectations. Metadata must be stated in the source.
- Record selection/eligibility is reported separately from attribute support.
  A source-stated site does not become false solely because its record was
  incorrectly selected; explain the distinction in the rationale when needed.
- Use the smallest acceptable canonical anchor set. A single passage in its
  local source context can support a value. Require multiple anchors when the
  claim actually needs their combined evidence. Do not mechanically append
  every nearby heading, and do not accept unrelated repeated occurrences.
- Outer lists are alternative acceptable evidence; inner lists contain anchors
  that must jointly support the claim. Include alternative acceptable locations
  where found. Do not select a location just because it is the first match.
- `valueSupported: false` requires `goldAnchorSets: []`. When the PDF supports
  a value but damaged/missing canonical text provides no acceptable anchor,
  use `valueSupported: true`, empty gold sets and explain the source evidence
  loss. Inspect the original PDF when parsing order or OCR is ambiguous.
- Use `status: unresolved` for judgments that cannot be settled; support may
  then be null. Do not silently convert uncertainty into an unsupported label.

## Adjudication and validation

Disagreements include support, acceptable anchor alternatives/sets and unresolved
status. A separate fresh agent receives the source, schema and disagreement
claims with both rationales, but no experimental outputs. It writes exactly
those claim IDs to `adjudicated.json`; agreements are preserved. Unresolved
adjudications remain visible and are excluded from scored denominators.

Validation rejects missing/duplicate labels, invalid anchor IDs, inconsistent
support/evidence and incomplete generation. The prevalence of unsupported
claims with lexical hits is a natural-output distribution statistic, not a
selection condition. No labels may change frozen policy features, parameters,
prompts, schemas, candidate selection or quote matching.
