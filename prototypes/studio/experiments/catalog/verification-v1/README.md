# Local burial-axis verification experiment — 2026-09-08

Status: completed diagnostic comparison. Production requires open-source local
models; Luna is only a historical baseline and is never invoked by these scripts.

The experiment reuses only NuExtract values from desktop-b3-r3 and recomputes all
lexical evidence with the frozen original linker. It verifies every non-null
burial_axis: seven claims, without looking up reference answers to select them.
Both backends receive the header, matching blocks and immediate neighbouring
blocks within the same record. This is bounded evidence context, not the full PDF.

Candidates: a second raw NuExtract request per claim, and local GLiNER 2.5 Multi
classification plus native source spans. Both must identify the oriented object
and return a supported/unsupported/uncertain judgment. A supported result also
requires an exact quote containing the object and direction within one canonical
block. Invalid or ambiguous support abstains. Proposed original values and review
flags are retained. This is a prototype abstention policy, not a production review
implementation. A positive classifier decision and exact offsets still do not
guarantee semantic correctness; measured reference scoring remains necessary.

Run two repetitions per backend, serially. Record model load time separately from
verification latency; count GLiNER forwards separately from LLM requests. No
threshold tuning or prompt revision after inspecting outputs within a frozen run.
The whole excerpt and the error at 225 are already known: this is an unblinded
diagnostic, not held-out validation. Check false rejection of the six correct
orientations, not only removal of the one known false positive. Null claims are
not revisited, so this experiment cannot establish missing-value recall.

From Studio, prepare inputs into a fresh artifact directory:

```powershell
node --import tsx experiments/catalog/verification-v1/prepare.ts --document ../../artifacts/catalog-lab/beier/parsed_document.json --baseline ../../artifacts/catalog-lab/beier/desktop-b3-r3/result.json --out ../../artifacts/catalog-lab/beier/verification-v1
```

From the repository root, run tests and freeze before model comparisons:

```powershell
python -m unittest discover -s prototypes/studio/experiments/catalog/verification-v1 -p 'test_*.py'
python prototypes/studio/experiments/catalog/verification-v1/run.py --input-dir artifacts/catalog-lab/beier/verification-v1 --freeze
python prototypes/studio/experiments/catalog/verification-v1/run.py --input-dir artifacts/catalog-lab/beier/verification-v1 --backend nuextract --repetition 1
```

For GLiNER use the isolated environment, `--backend gliner` and `--model-path` to a
local snapshot of revision aaecfe45db1d828c963717054ccb868e8ad1f1d5. Install the
official runtime with AutoExtractor; no remote model Python code is executed.
Artifact runtime metadata and dependency locks record the actual installation.
Use `--repetition 2` for the second run. An existing output is never overwritten.

Score completed result.json files using the original evaluate.py. Its durations
combine reused extraction durations with newly measured verification time; these
are estimated pipeline totals, not newly measured end-to-end runs. All seven-field
scores start with local-only evidence, so the locality correction previously made
by Luna is not inherited.

## Results

The useful signal came from NuExtract's semantic judgment, not GLiNER. With the
object/quote/uncertainty schema, NuExtract classified all six correct axes as
supported and entry 225 as uncertain in both repetitions. Requiring a full exact
support quote then unnecessarily withheld entries 206, 214 and 227. GLiNER
classified all seven claims as uncertain in all three completed runs.

| Policy | Correct values / 203 | Supported fields / 164 | Correct axes retained / 6 | Entry 225 | Verification only |
| --- | ---: | ---: | ---: | --- | --- |
| Local lexical baseline, derived from saved extraction | 202 | 161 | 6 | False axis remains | — |
| NuExtract semantic verdict + strict quote gate, 2 runs | 200 | 160 | 3 | Abstains | 3.496–6.464 s |
| NuExtract verdict + block-label output, 2 supplemental runs | 200–201 | 161 | 4 | False positive in one run; invalid label in the other | 1.738–2.315 s |
| GLiNER classification + spans, 3 completed runs | 197 | 157 | 0 | Abstains on everything | 1.874–7.106 s |
| Post-hoc semantic-only policy from the 2 original NuExtract runs | 203 | 161 | 6 | Abstains | Reuses 3.496–6.464 s above |

The last row is a derived replay, not a new measured run. It uses the same rich
NuExtract response schema but applies only the semantic verdict to values,
retains existing local evidence and leaves missing evidence missing. It was
chosen after observing strict quote failures. No reference is read by that policy;
reference scoring happens afterward. Its three ungrounded fields are locality
225 and axes 214 and 223. Thus 203/203 values does not establish complete grounding.
The ambiguous original value and review-required flag remain in the result.

The block-label protocol (`labels.py`) was frozen separately after observing v1
quote failures. It sometimes returned an orientation in place of an E label, and
lost the semantic distinction at 225. Removing object/uncertainty outputs also
changed the task packaging; these runs do not isolate labels as the causal factor.

GLiNER's first attempt failed before inference because protobuf was missing. The
successful runs used gliner2 2.0.0, transformers 4.57.6, torch 2.8.0+cu128, FP32,
offline inference and an automatic SDPA-to-eager fallback. The initially attempted
top-level forward counter did not intercept GLiNER's inference path: its zero is
not a zero-compute measurement. `measure_gliner.py` repeated the same frozen
protocol and recorded seven actual encoder forwards in gliner-r4. The repeated
decisions were unchanged. Model load time is recorded separately.

The NuExtract pipelines use ten reused extraction requests plus seven verifier
requests. GLiNER uses the same ten extraction requests plus seven encoder forwards,
with no verifier LLM requests. In this experiment there were 28 newly executed
NuExtract requests and 21 GLiNER extraction API invocations (the last seven have
direct encoder-forward instrumentation). The derived policies add no model calls.

[Interactive comparison and per-entry contexts](../../../../../artifacts/catalog-lab/beier/verification-v1/report.html)
and raw requests, responses, decisions, freezes, checkpoint hashes and dependency
lock are under `artifacts/catalog-lab/beier/verification-v1/` (gitignored).

Rebuild the report and post-hoc projections from the repository root:

```powershell
python prototypes/studio/experiments/catalog/verification-v1/report.py --input-dir artifacts/catalog-lab/beier/verification-v1 --document artifacts/catalog-lab/beier/parsed_document.json
```

The next useful validation is an independent set of ambiguous and explicit grave
descriptions, with source-reviewed answers fixed before inference. These seven
known claims do not justify a production accuracy claim or rejecting GLiNER for
all extraction tasks. No production code or original frozen file was changed.
