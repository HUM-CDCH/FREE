# Harvey grounding micro-pilot results — 2026-09-28

Status: **12 cells complete and exactly replayed; full matrix deferred**.
This is the registered [selected-claim diagnostic](../plans/2026-09-28-harvey-grounding-micro.md),
using one previously inspected document. It is development evidence, not an
estimate of full-document accuracy or generalization.

Compact span labels admit all 16 selected decisions that original span labels
refused across two repeats. They select the same claim paths and canonical table
cells as quoted verification, but use twice as many calls and 2.31 times the input
tokens. Both methods accept a proof that covers only part of a conditions claim.
The result supports budget admission and provenance contracts for these cases;
it does not establish lower cost or better semantic accuracy generally.

## Complete outcome accounting

Each arm receives four existing scalar claims from each of two complete source
units, repeated twice: 16 decisions per arm, 48 total. Record JSON, source text,
table structure, schema, model and the 12,288-token study budget are pinned.
The cases were registered before new model replies. All original-span refusals
remain outcomes rather than being removed from the denominator.

| Arm | Calls | Attempted / selected | Budget refusals | Linked decisions | Input tokens | Output tokens | Sum of call seconds |
|---|---:|---:|---:|---:|---:|---:|---:|
| Generated quotes | 4 | 16/16 | 0 | 8 | 34,910 | 656 | 115.14 |
| Original spans, v1 | 0 | 0/16 | 16 | 0 | 0 | 0 | 0 |
| Compact spans, v2 | 8 | 16/16 | 0 | 8 | 80,806 | 450 | 84.75 |

The table batch takes three compact-span calls versus one quoted call per repeat;
the prose batch takes one in either admitted arm. Generation finished in 103.53
wall seconds with two workers, 12 actual HTTP generation calls, no failed calls,
no retries/fallback attempts and no unstarted cells. All responses finished normally.
The sum of overlapping call times is not wall time; provider scheduling/cache
effects prevent treating these timings as a reproducible speed comparison.

The supervised process was PID 1972821 in
`free-ablation-harvey-micro-20260928.service`, finished at 08:58:19 UTC. The unit
is inactive after normal completion. No further inference is scheduled here.

## Evidence selections and their limits

Both repeats agree within each arm. The six identical request pairs contain 16
paired model decisions, with zero differences in parsed decisions, accepted links
or proofs. The 16 v1 refusals are deterministic budget outcomes, not model samples.
Two repeats do not establish determinism or a reliable population disagreement rate.

For the amberjack table case, both admitted arms select `p3_s2/r4_c1` for
*Seriola quinqueradiata* and `p3_s2/r4_c7` for 18.6. Both reject the fixed record's
separate measured-composition basis and value 15.6. Assistant inspection of the
canonical table places 15.6 in the cod row and labels the composition as calculated
using Mega-X. This is a selected attribution challenge, not independent gold.
The parent table, its caption, headers and all 48 cells remain available.

For the cod prose case, both admitted arms reject sequence-derived composition
basis and the full TGA-condition string in this selected unit. Both link the
126 °C peak and DSC conditions to `p4_s16`. A NONE in one unit does not establish
absence elsewhere in the document.

The DSC-condition claim also says **10 °C/min**, which is absent from the accepted
quote, span and containing paragraph. The paragraph supports the roughly 110–145 °C
transition, but not the entire compound claim. Thus both methods accept partial
support here. The full record contains the heating rate, so copying a value from
record context cannot be treated as independent evidence. No runtime policy was
tuned in response to this result.

Mechanical validation passes for all 16 retained proofs: exact canonical text,
eight span offsets, eight cell references with exact canonical cell geometry,
and eight prose links with the original parent geometry. These checks preserve
source identity and do not certify entailment, subject attribution or completeness.

## Reproduction and remaining gates

Artifact root:
`/home/gennaro/projects/FREE/artifacts/extraction-ablation/harvey-grounding-micro-20260928/`.
`registration.json` pins the pre-generation protocol, configuration, helpers and
preflight counts. The cells retain requests, replies, provider records, results,
seals and process receipts. All 12 cells exactly replay with HTTP blocked and no
fresh tokenizer/model calls. The separate analysis verifies 297 input/artifact pins.

| Artifact | SHA-256 |
|---|---|
| `registration.json` | `0e226e6d7a78d8e2a1454d32d608bf41d849074d4d7c52e2f28a1116874a9026` |
| `analysis.json` | `055416bddf7ce3d79eae25241b94fff870d28403850142c06f6f273b0d80d24d` |
| `analyze.py` | `ef4c2d995370b63dcb99bf5de026ca9fdfe3f052d1da926fbb68d20b1c4146fa` |
| `finished.json` | `530f676603e79dbed7237ad48c019d84176d9f378ade292679f5698012d42aed` |

Recheck without inference, using a new output filename:

```sh
python3 /home/gennaro/projects/FREE/artifacts/extraction-ablation/harvey-grounding-micro-20260928/analyze.py /tmp/harvey-micro-check-new.json
```

The frozen v1 and v2 runtimes precede the #145/#146 architecture integration,
since merged as `2ce78e4c`; this is not a live evaluation of the merged code (see
the [merged replay](2026-09-28-merged-grounding-replay.md)). Source-unit selection
is diagnostic, so no whole-document recall, independent accuracy or v2 semantic
equivalence claim follows. Original R5 remains six completed cells and 84 deferred;
this separate diagnostic does not complete additional registered R5 cells.

A later [merged-code regression check](2026-09-28-merged-grounding-replay.md)
reproduces all eight quoted/v2 cells exactly on merge `2ce78e4c`, with network
blocked. It checks the refactor against those recorded results without adding fresh
inference or changing the semantic limits above.

The [study plan's independent evaluation gate](../plans/2026-09-27-modular-extraction-ablation-study.md#m7--independent-evaluation-after-policy-freeze)
requires frozen policies and untouched document families. Existing examples and
validation documents remain development data. The full study is still unfinished.
