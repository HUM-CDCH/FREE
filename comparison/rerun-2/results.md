# PR #267 Article resolution, rerun 2: results

Protocol: `protocol.md` (sealed in `seal.json` before any call; code `d21f99e6`, resolver blob `5a284de0`, the same
blob confirmed in the source tree the run loaded on Baratheon). Harness, schema, scorer, corpus and criteria unchanged
from the first execution (`../protocol.md`, `../amendment-1.md`); every sealed hash re-checked after the run and
matching. Run 2026-10-14 11:04:51-11:32:28 UTC on Baratheon's live vLLM servers. 24 executions, one per paper and
condition, every one exited 0; no deviations. Captures in `captures/`, scores in `report.json` (`../score.py`).

## Verdict: every criterion holds in both conditions. The hold stays until the maintainer decides.

| Criterion | N (fields NuExtract3, reasoning Qwen) | Q (both Qwen) |
| --- | --- | --- |
| A1 valid-item deletion ≤ 5% of covered gold rows | 0 of 14: pass | 0 of 15: pass |
| A2 own scalar values not reduced; ≤ 1 loss | 27 → 31 of 36, 0 losses: pass | 20 → 31 of 36, 0 losses: pass |
| A3 multi-part own rows kept; ≤ 1 repeated own scalar lost | 2 of 2 kept, 0 lost: pass | 2 of 2 kept, 0 lost: pass |
| A4 no own unopposed scalar set to null by NONE | 0 (17 unopposed kept): pass | 0 (9 unopposed kept): pass |

Earlier executions on the same papers: the first (`e4516d3c`) failed A1 in Q; rerun 1 (`6b4a2b9b`) failed A1 and A3
in N. Under the protocol's decision rule this result goes to the maintainer; it does not lift the hold by itself.

## Measures

- Parts: N 42, Q 40. Resolution calls: 12 per condition, none failed. UNSURE: 0. Null list answers (the model
  abstained on the whole list, so assembly kept every item): N 1 (H4), Q 1 (Baltic cod, "Isolation and some
  properties"). One N part call was cut off at the length limit (Correlation of proline, as in rerun 1); the paper
  was still resolved and scored.
- Value retention (title, DOI, year; 36 places): resolution gained N 4 (2 titles, 1 DOI, 1 year) and Q 11 (6 titles,
  3 DOIs, 2 years) own values and lost none. Unopposed scalars removed by NONE: 0 in both.
- Items: N 77 → 66 (11 dropped), Q 53 → 53 (none dropped). Gold rows covered by the deterministic matcher: N 14 → 14,
  Q 15 → 15 of 43.

## Adjudication of every dropped item

Q dropped no item. N dropped 11:

- Baltic cod ("Isolation and some properties"), 8 cited species from the discussion (Alaska pollock 16.8 °C, Baltic
  cod skin 14 °C lyophilized, skate wing muscle, grass carp skin, brownstripe red snapper, Nile perch skins, bigeye
  snapper skin and bone). Foreign, correctly removed (the same 8 as rerun 1).
- Correlation of proline, grass carp skin acid-soluble collagen from the reference list. Foreign, correctly removed.
- H2 (carp swim bladder), 2 own items labelled OTHER: Catla catla swim bladder ASC and PSC, read from the methods
  part with no value. **Own samples mislabelled.** No gold row and no numeric value is lost: the kept copies (species
  "catla", parts 2-3) carry Tmax 38.88 and 39.38 °C and the enthalpies. **Printed own method context is lost**: only
  the dropped copies held the DSC medium and ratio, which the source prints ("The extracted ASC and PSC samples were
  dissolved in 0.05 M acetic acid at a ratio of 1:40 (w/v)"), and the ASC extraction as acid-soluble (the kept ASC
  copy reads it as "pepsin"). The criteria count rows and values, not these fields. Rerun 1 kept all four items.

## What else the results show

- **N's A1 pass on H4 rests on an abstention.** On H4 (barracuda), whose 12 own items rerun 1 dropped, the reasoning
  model answered the list with null, so all 12 were kept unjudged. The new label form did not show here that the model
  labels these items correctly; it shows that an abstaining answer changes nothing.
- **Values lost in rerun 1 are kept.** Q kept the redfish imino totals 16.5% and 16.0%, the raw-skin hydroxyproline
  67.3 mg/g and the Baltic cod backbone hydroxyproline 6.4%.
- **Contamination kept.** Both conditions kept the Baltic cod skin item with hydroxyproline 6.8% cited from Sadowska
  et al. 2003 (N labelled it OWN; Q abstained on that list). Q had removed it in rerun 1. Q removed no item anywhere,
  so in this run its list resolution only ever kept or abstained.

## Limits

As declared in `protocol.md`: this is the third execution on the same 12 papers, and both fixes were designed from
what earlier executions on them dropped. Passing here shows the observed failures did not recur in this execution; it
is not evidence from unseen papers, and a confirmation on papers outside this corpus is recommended before default-on
release. The servers are not deterministic at temperature 0, so differences from rerun 1 mix reading variance with the
code change (for example, the H2 mislabel and the H4 abstention are new in this execution).
