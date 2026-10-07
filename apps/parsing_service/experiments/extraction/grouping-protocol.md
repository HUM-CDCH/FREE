# Structural grouping — R4 protocol, 2026-09-27

Declared before R4 response generation, after observing R1 development failures.
The hypothesis is that keeping nearby typed qualifiers and inherited headings in
bounded units improves extraction relative to token-only boundaries. This is a
post-audit development comparison, not a preregistered R1 or held-out hypothesis.

Use all six annotated collagen sources, with the exact R1 source generations,
PDFs, schemas, identity dimensions, gold/scorer, providers and greedy decoding.
Both arms use protocol v12, structured rendering, conservative identity handling,
schema prompts, bounded 12288-token contexts, no overlap, no value selection and
no grounding calls. The only factor is `article.grouping`: omitted (`token`) or
`structural`. Both arms decode source control characters identically. R4 does not
estimate the decoder fix, rendering effect, or quoted-grounding accuracy.

Twelve fresh cells, one per source/arm, seeded order 20260927, at most two cells
concurrently. Run after R1 and R3 generation ends, on the same observed provider
configuration. Pin code/protocol before preflight and generation. Record source
units, required heading context, every refusal/failed call, captures and costs.
Do not remove a difficult source, tune the grouping after seeing its result, or
replace an output failure with a better rerun. Only verified infrastructure
interruption permits exact capture resumption. No further matrix expansion is
planned for this implementation milestone.

Primary measure: each paper's populated sample-field correctness under the frozen
scorer, then the mean paired structural-minus-token difference and the existing
10000-draw document bootstrap (seed 20260927). Report all six papers, empty-field
fills, document-field scores, matched/extra identities, observation extras,
conflicts, unit/call/token counts, refusals and shared-provider durations. No
p-values or field-level independent-sample claims. Unscored extras stay visible.

The layout labels are imperfect and do not prove semantic block independence.
A table's distant unlabelled footnotes may still be separated. No heading depth,
new cell structure, cross-page table identity or human labels are inferred.
Grouping changes upstream prompts and may change inventories and record counts;
those are part of its pipeline effect. Existing replies cannot evaluate changed
prompts. Report the independent fresh runs honestly, including serving variability.
