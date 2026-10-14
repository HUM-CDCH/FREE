# PR #267 Article resolution: annotated live-model comparison, results

Protocol: `protocol.md` (sha256 `f1ee966a…`, sealed before any call), amendment 1 (`amendment-1.md`, sha256
`0b3f506d…`, sealed after the one uncounted pilot), deviations in `deviations.md`. Code: `e4516d3c`, resolver blob
`df1f4810`. Run 2026-10-14 on the deployment's live vLLM servers. 24 executions, one per paper and condition.
Captures in `captures/`, scores in `report.json` (`score.py`).

## Verdict: not accepted. The hold stays.

| Criterion | N (fields NuExtract3, reasoning Qwen) | Q (both Qwen) |
| --- | --- | --- |
| A1 valid-item deletion ≤ 5% of covered gold rows | 0 of 14: pass | 1 of 13 (7.7%): **fail** |
| A2 own scalar values not reduced; ≤ 1 loss | 27 → 31 of 36, 0 losses: pass | 22 → 31 of 36, 0 losses: pass |
| A3 multi-part own rows kept; ≤ 1 repeated own scalar lost | 2 of 2 kept, 0 lost: pass | 2 of 2 kept, 0 lost: pass |
| A4 no own unopposed scalar set to null by NONE | 0 (17 unopposed kept): pass | 0 (10 unopposed kept): pass |

The protocol requires every criterion in both conditions, so the comparison does not accept default-on resolution.

## Measures

- Parts: N 42, Q 40 (2-6 per paper). Resolution calls: 12 per condition, none failed. UNSURE: 0. Null list answers:
  N 0, Q 1. One N part call failed (Correlation of proline); its paper was still resolved and scored.
- Value retention (title, DOI, year; 36 places): resolution gained N 4 (2 titles, 1 DOI, 1 year) and Q 9 (6 titles,
  2 DOIs, 1 year) own values, every one at a place assembly had left null by a conflict (a title against a section
  heading, a reference-list title or a misread), and lost none. Unopposed scalars removed by NONE: 0 in both.
- Items: N 77 → 65, Q 51 → 44. Gold rows covered by the deterministic matcher under assembly alone: N 14, Q 13 of
  43. The matcher needs a species and a printed value to agree, so most rows are not matched; every dropped item,
  matched or not, was therefore adjudicated against the source text.

## Adjudication of every dropped item

Q, 7 dropped:
- Wang 2007 redfish: the raw-skin sample with hydroxyproline 67.3 mg/g (Table 1, the paper's own). It is eligible
  under the record description and is a gold row. **Own sample lost.** (The A1 failure.)
- Wang 2007 redfish, ASC and PSC copies read in part 2 with the imino totals 16.5% and 16.0% printed in the text.
  The kept copies from part 1 carry hydroxyproline, proline and Td but no imino total. **Two printed own values lost.**
- Baltic cod backbone, part-2 copy carrying the paper's own hydroxyproline 6.4% of dry weight. The kept copy has
  only Td 14.4 °C. **One printed own value lost.**
- H1, ASC and PSC copies read in part 2 with proline and hydroxyproline split from a printed ASC-PSC range
  ("117 - 118", "83 - 85" residues/1000); the per-sample table is a supplement outside the PDF. Own duplicates;
  nothing printed per sample is lost.
- Baltic cod skin (hydroxyproline 6.8%, cited from Sadowska et al. 2003). Foreign, correctly removed.

N, 12 dropped:
- 8 foreign, correctly removed: seven cited species in the Baltic cod discussion (Alaska pollock, skate, grass carp,
  brownstripe red snapper, Nile perch, bigeye snapper skin and bone) and grass carp from the Correlation reference list.
- Wang 2007 redfish ASC and PSC part-2 copies with the printed imino totals 16.5% and 16.0%. The kept copies carry
  165 and 160 per 1000, which the paper does not print (hydroxyproline plus proline, a sum the schema forbids).
  **Two printed own values lost**, replaced by computed equivalents.
- H1 ASC and PSC part-2 copies with range-derived values, as in Q. Own duplicates; nothing printed per sample lost.

Not removed (contamination kept): N kept two cited Baltic cod skin items (Sadowska et al. 2003; Tylingo, unpublished).

## What the failures have in common

Every own value lost is on a copy of an own sample read in another part, which carries values the kept copy lacks
(or, for the raw-skin sample, an own sample the model treated as not belonging). Resolution can keep or drop
whole items, and it treats a second, differently filled reading of the same sample as "the same thing printed
again". Scalar resolution behaved well in both conditions.

## Limits

- 12 papers, one domain (collagen), one schema. Gold is pending human sign-off (dev: blind-corrected; held-out:
  model-drafted by two blind agents).
- 12,288-token parts force more parts than production's 32,768-token fallback would on these papers.
- Strict title normalization counts H1's title as never own: the parse prints "( Chitala ornata )" with inner
  spaces. This lowers both columns equally and does not change any criterion.
- Grounding was not run; it changes no value or item.
