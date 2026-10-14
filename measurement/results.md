# PR #275 Article resolution P2 fixes: paired measurement results

Protocol: `protocol.md`, sealed 2026-10-14 14:37:23 UTC (`seal.json`) before any counted model call. Code under test
`1181e93e`, fix resolver blob `e7037b17`, baseline (accepted on PR #267, `dev` `811bb9f2`) blob `5a284de0`. PR head
`358fdde0` keeps resolver blob `e7037b17`, so these results apply to it.

## Verdict

**Not accepted under the sealed protocol: C1 fails in both conditions. C2, S1, S2 and S3 hold in both.** Per the
decision rule, PR #275 stays draft and no fix-and-rerun cycle follows without the maintainer.

| Criterion | N (NuExtract fields, Qwen reasoning) | Q (Qwen both) |
| --- | --- | --- |
| C1, A1 (rows lost ≤ 5% of covered) | **fail**: 1 of 14 covered gold rows lost | **fail**: 1 of 13 lost |
| C1, A2 (own title/DOI/year not fewer, ≤ 1 loss) | pass: 27 → 31 of 36, 0 lost | pass: 22 → 31 of 36, 0 lost |
| C1, A3 (multi-part rows, printed-several values) | pass | pass |
| C1, A4 (no unopposed own scalar removed) | pass: 0 removed | pass: 0 removed |
| C2 (corpus results differ only by P2-1) | holds: 12 of 12 papers | holds: 12 of 12 papers |
| S1 (no list left unresolved for length) | pass: 0 budget refusals, 0 calls over budget | pass |
| S2 (own objects deleted ≤ 5%) | pass: 0 of 265 | pass: 0 of 265 |
| S3 (no own object lost to REPEAT beside OTHER) | pass (no such event occurred) | pass (no such event occurred) |

**The C1 failure is not caused by this PR.** The baseline fails A1 identically on the same readings: in every corpus
run it sent only requests the fix sent (all 24 reused), refused no list for budget, and produced the same result
(0 items differing, no scalar differing). No corpus list part held two equal items, and no run used the REPEAT label.
The loss is the accepted rule, now on `dev`, applied to this execution's labels.

## Execution

- 32 runs (12 papers + 4 synthetic documents, × N and Q), queues started 14:37:41 UTC on Baratheon, last run
  finished 15:48 UTC. All 32 exited 0. No reruns, no exclusions, no deviations from the protocol.
- Seals rechecked after the runs: every file hash in `seal.json` matches locally and on Baratheon (harness, launch
  scripts, schemas). Baratheon's mounted `src` tree is identical to `1181e93e` (91 files, by git blob hash). The two
  resolver blobs are `e7037b17` (fix) and `5a284de0` (baseline, `harness/resolution_b.py`).
- Failures: one N part call cut off at the length limit (Correlation of proline, as in reruns 1 and 2); the paper was
  resolved from its other parts and scored. No resolution call failed. UNSURE answers: 0. Null list answers: N 1 (H4,
  as in rerun 2), Q 1 (Experimental taphonomy).

## Corpus (12 annotated papers)

- Items: N 75 → 59, Q 53 → 50. Gold rows covered by the deterministic matcher: N 14 → 13, Q 13 → 12 of 43.
- **The A1 loss: Baltic cod ("Isolation and some properties of collagen from the backbone of Baltic cod", 2010).**
  In both conditions the reasoning model labelled every item of the list OTHER, including the paper's own backbone
  collagen, although the request opens with that title. The list went N 11 → 0 and Q 3 → 0, and gold row 0
  (*Gadus morhua* backbone) was lost in both. On this paper the model's labels have not been stable across
  executions: N kept 5, 4, 4 and now 0 of 12; Q kept 1, 1, 3 (an abstention) and now 0 of 3 (run 1, rerun 1,
  rerun 2, this run). Rerun 2 passed here only because N labelled the own items OWN and Q abstained.
- A1 counts this as 1 row because the paper has one covered gold row; the paper's whole own data went with it (see
  below).

### Adjudication of every dropped item

Each item the fix dropped, checked against the source text shown in the request (and the earlier adjudications of
the same papers). N dropped 16, Q dropped 3.

N, foreign, correctly removed (9):
- Baltic cod discussion, 8 cited items: cod skin with hydroxyproline 6.8% (cited from Sadowska et al. 2003), Alaska
  pollock 16.8 °C (Kimura et al. 1987), skate wing muscle, grass carp skin, brownstripe red snapper, Nile perch skin,
  bigeye snapper skin and bone.
- Correlation of proline: grass carp skin acid-soluble collagen, from the reference list.

N, own, mislabelled OTHER (7):
- Baltic cod, 3 own items: backbone ossein collagen with viscosity Td 14.4 °C (gold row 0); backbone raw material with
  its storage condition; backbone collagen with hydroxyproline 6.4 ± 0.13% of dry weight and Td 14.4 ± 0.17 °C.
  **All of the paper's own samples and printed values are lost.**
- Wang 2007 redfish, ASC and PSC copies with the printed imino totals 16.5% and 16.0%. The kept copies carry 165 and
  160 per 1000, which the paper does not print. **Two printed own values lost** (as in run 1, N).
- H2 (carp swim bladder), *Catla catla* ASC and PSC copies read from the methods part with no value. Rows stay covered
  by the kept copies (Tmax 38.88 and 39.38 °C, enthalpies); **the printed DSC medium and ratio are lost** (as in
  rerun 2).

Q, foreign, correctly removed (1): Baltic cod skin, hydroxyproline 6.8% (Sadowska et al. 2003).

Q, own, mislabelled OTHER (2): Baltic cod backbone collagen with viscosity Td 14.4 °C (gold row 0), and backbone
collagen with hydroxyproline 6.4 ± 0.13% and Td 14.4 ± 0.17 °C. **All of the paper's own data is lost.**

### Baseline A1-A4 on the corpus

Identical to the fix in both conditions: A1 fails (1 row lost), A2-A4 pass.

## Synthetic (4 generated long-list documents)

Gold by Object ID (`truth.json`). Own objects 40, 70, 100, 55 (265); cited objects 4, 6, 8, 5, each printed twice
(46 cited copies); own reprints 4, 6, 8, 5 (23 extra own copies).

| Document | Items assembled (N / Q) | Fix list parts (items per part) | Fix: own deleted, cited kept | Baseline budget refusals | Baseline: cited kept |
| --- | --- | --- | --- | --- | --- |
| p2s-a | 52 / 52 | 2 (49 + 3) | 0, 0 | 1 | 8 |
| p2s-b | 88 / 88 | 2 (49 + 39) | 0, 0 | 1 | 12 |
| p2s-c | 124 / 125 | 3 (52 + 52 + 20; Q 52 + 53 + 20) | 0, 0 | 2 | 16 |
| p2s-d | 70 / 70 | 2 (N 46 + 24; Q 47 + 23) | 0, 0 | 1 | 10 |

The same in both conditions:
- **P2-2 works where it applies.** The baseline cut every list into 60-item parts. 5 of them did not fit, so each
  list stayed unresolved (`resolution_exceeds_budget`) with all 46 cited copies kept. The fix resolved every list in
  9 parts that fit (largest request 11,538 counted input + 746 reserved = 12,284 of 12,288 tokens), removed all 46
  cited copies and deleted none of the 265 own objects. Every item it dropped is a cited copy.
- Own reprints: all 23 extra own copies were kept by both resolvers (no own copy was labelled REPEAT).
- Unmatched: Q p2s-c assembled one partial reading with no Object ID (year 1816, box B281); both resolvers kept it.
- UNSURE 0, null list answers 0, failed calls 0.

### P2-1 was not exercised

No counted run labelled any item REPEAT: the list labels over all 32 runs were 672 OWN, 111 OTHER and 0 REPEAT.
There were 5 equal groups per condition, all in p2s-a:
four cited pairs labelled OTHER and OTHER, and one own pair labelled OWN and OWN. In p2s-b to p2s-d the two copies of
each cited object fell in different list parts, so no equal group was shown together. P2-1's rule therefore decided
nothing here, and S3 passes vacuously. P2-1's live evidence is only the uncounted pilot 3, where Q labelled 4 cited
objects OTHER with their second copy REPEAT; otherwise it rests on the unit tests.

## Deferred follow-ups (from the review of `1181e93e`)

Each changes `resolution.py`, which this measurement pins by blob, so they were left for after it:
- P3-2: the halving search's CPU cost.
- P3-3: the other parts of a list that cannot be settled are still sent. This changes which calls go out, so it needs
  its own check.
- P3-4: a comment on `if fitting:`.

## Limits

- The corpus run is the fourth execution on the same 12 papers, and the servers are not deterministic at
  temperature 0; within a run, the fix and baseline resolve the same readings.
- The synthetic documents were generated to make the P2s occur and print clean, regular text, and `p2s-a` was seen
  in three pilots. They show the rules' behavior where the P2s apply, not how often the P2s occur in real papers.
- Where a list fits one 60-item part, the baseline's result is the old rule applied to the fix's reply, not an
  independent call.
- The whole-list OTHER failure on the Baltic cod paper is a property of the accepted, default-on resolver on `dev`.
  A1 counts it as one row; it removed the paper's entire own data in both conditions.

## Withheld

The captures (`captures/`), `report.json` and the corpus gold are not published: the repository is public, captures
hold long excerpts of the papers, and the gold is a held-out set. Their SHA-256 hashes are in `withheld.sha256`.
