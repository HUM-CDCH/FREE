# Grounding pilot: model audit and capture recheck

Status: independent model review received and its mechanical findings verified
2026-09-28. No additional model inference was run. This updates interpretation
of the [completed pilot](2026-09-28-grounding-pilot.md), not its frozen results.

## Identical requests vary

Across 101 saved requests, 76 are unique and 20 groups contain byte-identical
requests from multiple arms. Four groups return different decisions. The new
`extraction_grounding_variation.py` reproduces this directly from captures.

| Claim | Identical requests | Different decisions |
|---|---|---|
| Record 0 hydroxyproline notes | spans / unresolved, call 0003 | results span / NONE |
| Record 0 composition basis | policy / combined / routed, call 0002 | results span / NONE |
| Record 1 sample scope | policy / combined, call 0006 | section heading / title |
| Record 1 hydroxyproline notes | policy / combined, call 0008 | dialysis paragraph / results span |

The helper compares all unordered pairs and all requested claims: 5 differing
decisions in 170 comparisons. The basis group has three members, so its one
different response contributes two differing pairs. The audit instead compares
each group's first response with the rest and excludes derived fields: 4 in 109.
These are different explicit denominators for the same four divergent groups;
neither is an independent-sample rate or an estimate of semantic accuracy.

The model runs used temperature zero. Captured request equality includes system,
user, reply schema and max_tokens. The model name and provider are pinned, but
an immutable model-weights digest and server execution state are unavailable.
The captures establish repeat disagreement; they do not identify its infrastructure
cause or justify claiming that greedy decoding is deterministic.

Observed cost savings remain valid. Small link changes and the linked-claim
interaction cannot establish policy/scheduling/routing effects. The routed loss
of record 1's notes uses a different batch, but that claim also varies under
identical requests. No semantic equivalence or harm conclusion follows.

## Corrected quote failure accounting

All six quoted-arm substring rejections were rechecked against offered source
text. Five become exact substrings after removing only canonical U+000E from
the candidate: three in call 0002 and thermal-condition decisions in calls 0006
and 0026. Both thermal-condition claims remain ungrounded in the final artifact.
The other three claims later acquire links; the audit rates those later proofs
weak. The sixth failure is the normalized phrase `% dry weight`.

This supersedes the earlier checkpoint's three-case diagnosis. Canonical source
text is unchanged. The span approach reconstructs literal text server-side; it
does not normalize OCR or establish semantic support by location alone.

## Model judgments and disagreement

The user-assigned Opus review covers 69 distinct pairs and 14 claims unlinked by
at least one arm. The primary reviewer saw method labels; a second model pass
received opaque pair IDs without method names, although proof form reveals the
quote/span family. These are model judgments, not human gold or held-out labels.

Fully supported links at the containing-segment level, out of 42 eligible claims:

| Arm | Primary review | Second model pass |
|---|---:|---:|
| Quoted | 24 | 20 |
| Spans | 32 | 28 |
| Unresolved | 31 | 27 |
| Policy | 31 | 27 |
| Combined | 32 | 28 |
| Routed | 30 | 26 |

Both reviews favor the observed span proofs over quoted proofs here. They agree
on selected-proof support for 60/69 pairs, containing-segment support for 61/69,
and record attribution for only 43/69. Most attribution disagreement concerns a
merged record label and whether a single measurement belongs to that preparation.
The SD-labeling disagreements concern whether ± alone establishes standard deviation.
Do not collapse these disagreements into a single validated quality score.

The two links lost by all span arms are not clear recall losses: the ASC proof
is partial for an arm-unspecified record, and the NaOH-P proof mentions pepsin.
The primary review rates seven gained paths fully supported. Human review should
prioritize preparation-arm ownership, the compound 15.7 notes claim, Type I scope,
and whether title/heading evidence supports a derived sample-scope classification.
The audit's inference about undefined extraction-code meanings remains an inference.

## Provenance and reproduction

External review directory:
`/home/gennaro/Documents/Codex/2026-09-28/grounding-pilot-independent-audit/`.
Its report, judgments, missing-support review, provenance and supporting second-pass
files are preserved in `opus-audit.zip` under
`/home/gennaro/projects/FREE/artifacts/extraction-ablation/pilot-audit-integration-20260928/`.
At integration, all 34 input/source/result hashes, six capture-directory aggregates
and all audit output hashes matched. The original report/plan and operational
pointer are mutable; their audited snapshots predate this correction.

The integration directory contains `provenance-check.json`, `variation-v2.json` and
`quoted-control-character-recheck.json`. The last checks five literal omissions
and the two final missing paths without accepting semantic labels as truth.

| Artifact | SHA-256 |
|---|---|
| `opus-audit.zip` | `fb55df1c75fcb0908c810e85339154a82c7782f6c4586594c0597b2f622cfd77` |
| `variation-v2.json` | `47e78a77f6224daf40ccdf77c74a8a8d1025d42bf01ab2321dfb7057c4977621` |
| `quoted-control-character-recheck.json` | `c82bcea539383c1e65bc7579cc352c812b13b39dd57a5b75b4c78aae3d7c29a6` |

To reproduce the request comparison from this checkout, choose a new output path:

```sh
python3 docs/validation/extraction_grounding_variation.py \
  /home/gennaro/projects/FREE/artifacts/extraction-ablation/20260928-r5-grounding \
  Zelechowska /tmp/grounding-variation-new.json
```

The helper records input hashes and fails instead of replacing an existing output.
Tests cover all unordered pairs, missing decisions, JSON formatting, changed output
budgets and incomplete/truncated replies. No network or model client is used.

## Next experiment

Keep the full matrix deferred. A larger repeat-only experiment is not necessary
to establish that disagreement exists: the saved captures already show it. Future
small comparisons should include repeated identical control requests, preserve
every response and distinguish method changes from this variation.

Harvey supplies both a previously refused case and one canonical table with 48
cells. A bounded, separately registered claim-level comparison on its table and
prose would test version 2 more directly than another full six-arm Zelechowska run.
Choose claims from the fixed schema/source structure before inspecting new answers;
include ambiguous subjects and missing support, not only easy positive matches.
Such a micro-pilot would measure those selected claims, not whole-document recall.
No new generation has been registered or scheduled by this audit integration.

The separate [singleton diagnosis](2026-09-28-grounding-singleton-overflows.md)
shows why another label-only optimization cannot fully resolve Age/Hamburg.
