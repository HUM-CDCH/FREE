# Grounding pilot: model audit and capture recheck

Status: independent model review received and its mechanical findings verified
2026-09-28. The initial integration used saved captures only; the addendum below
incorporates Opus's separately authorized 35 fresh calls. This updates interpretation
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
interaction cannot establish policy/scheduling effects. The repeated-call
addendum supersedes the initial interpretation of one routed loss; it does not
establish semantic equivalence or routing's general effect.

## Addendum: repeated requests expose one batch-sensitive loss

Opus separately ran seven saved requests five times each: 35 fresh calls,
353,095 input tokens and 6,995 output tokens. The run's source request hashes,
runner, replies and reported label counts were checked without new inference.
All replies stopped normally and matched their originals' input-token counts.
The runner passes the saved system, user, schema and output budget unchanged;
equal token counts alone would not establish request identity.

The record 0 notes and basis claims continue to vary. For record 1's compound
notes, the policy/combined request selects the incomplete dialysis paragraph
in 6/7 samples; the fuller results proof occurs only in the original combined
reply. That better proof is not an established method advantage.

The routed request returns NONE for record 1's notes in 6/6 samples, whereas
the policy/combined request links it in 7/7. These counts include the original
pilot replies plus five new replies per request. The prompt comparison preserves
system, record prefix, evidence and output budget, but changes the other claims,
claim numbering and corresponding schema. This is a repeatable difference
between these two request forms; composition and renumbering were not separately
isolated. It corrects the earlier claim that both routed losses were within the
observed identical-request variation. It does not show routing is generally harmful,
nor does retaining a partial proof establish better semantic grounding.

Four of 38 eligible claim slots differ across originals and fresh replies; three
differ among the five fresh replies alone. Both controls, covering 11 claims,
remain stable. The divergent requests were deliberately selected from known
failures, so these numbers cannot estimate a population disagreement rate.

The updated audit is archived separately as
`pilot-audit-integration-20260928/flip-addendum/opus-audit-updated.zip`
(SHA-256 `ecc0d07aed3ec0bab4d6853bf4d1fad56da9eb4f0ed51e51626fcc2b7db3aab2`).
Its sibling `recheck.json` verifies 73 pins and the per-claim labels
(SHA-256 `7ce5cebe24280d77d7c4bd79d7c0615cbe6a7dfa4922fd433115a1aee492f028`).
The original snapshot and pilot results remain unchanged. Fresh repeat artifacts
are in `artifacts/extraction-ablation/flip-rate-20260928/`.

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

## Development scope and next acceptance gate

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
That separately registered [Harvey micro-pilot](2026-09-28-harvey-grounding-micro.md)
is now complete. Compact spans remove its selected budget refusals but cost more
input tokens than quotes, and both methods accept one incompletely supported
compound claim. Neither pilot establishes generalization.

The [durable study plan](../plans/2026-09-27-modular-extraction-ablation-study.md#m7--independent-evaluation-after-policy-freeze)
now states the independent gate: freeze baseline/candidate and evaluation rules,
then evaluate untouched document families with human-adjudicated labels. Tuning
on that set would make it development data. General contract repairs and empirical
policy choices require different evidence; model agreement is not human gold.

The separate [singleton diagnosis](2026-09-28-grounding-singleton-overflows.md)
shows why another label-only optimization cannot fully resolve Age/Hamburg.
