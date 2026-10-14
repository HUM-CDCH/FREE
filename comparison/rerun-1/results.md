# PR #267 Article resolution, rerun 1: results

Protocol: `protocol.md` (sealed in `seal.json` before any call; code `6b4a2b9b`, resolver blob `7a343e26`).
Harness, schema, scorer, corpus and criteria unchanged from the first execution (`../protocol.md`, `../amendment-1.md`).
Run 2026-10-14 10:26-11:03 UTC on Baratheon's live vLLM servers. 24 executions, one per paper and condition, none
failed; no deviations. Captures in `captures/`, scores in `report.json` (`../score.py`).

## Verdict: not accepted. The hold stays.

| Criterion | N (fields NuExtract3, reasoning Qwen) | Q (both Qwen) |
| --- | --- | --- |
| A1 valid-item deletion ≤ 5% of covered gold rows | 5 of 14 (36%): **fail** | 0 of 13: pass |
| A2 own scalar values not reduced; ≤ 1 loss | 27 → 31 of 36, 0 losses: pass | 19 → 31 of 36, 0 losses: pass |
| A3 multi-part own rows kept; ≤ 1 repeated own scalar lost | 2 of 2 lost: **fail** | 0 multi-part rows; 0 lost: pass |
| A4 no own unopposed scalar set to null by NONE | 0 (17 kept): pass | 0 (9 kept): pass |

First execution, for comparison: N passed every criterion; Q failed A1 (1 of 13).

## Cause of the N failures: the leave-out answer was read as its opposite

The list answer of `6b4a2b9b` names the items to leave out. On two N papers the reasoning model named exactly the
items its first-execution answer had named to keep:

- H4 (barracuda): first execution kept I1-I12; rerun labelled I1-I12 OTHER. All 12 own items left, 3 gold rows lost.
- H1 (clown featherback): first execution kept I1, I2 (Chitala ornata ASC and PSC with Tmax 36.28 and 35.23 °C);
  rerun labelled the same two OTHER. The kept I3, I4 carry the same Tmax under the common name, so no printed value
  is lost, but the matcher's species rule no longer covers the 2 gold rows; the gold count stands.

The fix that followed (`d21f99e6`) requires a label on every item, OWN, OTHER or REPEAT, so a list of the items that
belong cannot be read as a list to remove.

## Adjudication of every dropped item

Q, 4 dropped:
- Wang 2007 redfish, ASC and PSC copies with the printed imino totals 16.5% and 16.0%, read with the species misread
  as "Sebastes mentaster". **Two printed own values lost.** (The raw-skin sample with hydroxyproline 67.3 mg/g, lost
  in the first execution, is kept.)
- Baltic cod backbone, part-2 copy with the paper's own hydroxyproline 6.4% of dry weight. **One printed own value
  lost** (as in the first execution).
- Baltic cod skin (hydroxyproline 6.8%, cited from Sadowska et al. 2003). Foreign, correctly removed.

N, 30 dropped:
- H4, 12 own items (above). **Own samples lost.**
- H1, 2 own items (above). Own duplicates; nothing printed lost.
- Sturgeon (molecular species), 7 items read from the methods section with no value (I1-I7), labelled OTHER. They
  are own samples, duplicated with values by the kept I8-I13 under the common name; nothing printed lost.
- Baltic cod discussion, 8 cited species (Alaska pollock, Baltic cod skin from Sadowska et al. 2003, skate, grass
  carp, brownstripe red snapper, Nile perch, bigeye snapper skin and bone). Foreign, correctly removed.
- Correlation of proline, grass carp from the reference list. Foreign, correctly removed.

Not removed (contamination kept): N kept the cited Baltic cod skin item with hydroxyproline 6.8% (Sadowska et al.
2003); the first execution kept it and a second cited one (Tylingo, unpublished).

## Limits

As declared in `protocol.md`: the fix was designed from the first execution on this corpus, and the servers are not
deterministic at temperature 0, so differences from the first execution mix reading variance with the code change.
