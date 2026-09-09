# Additional local models — 2026-09-08

Continuation of [HANDOFF.md](../HANDOFF.md), on Windows and one RTX 4090 (24 GB).
This is a diagnostic extension of the same three-page Beier excerpt, 29 records
and seven fields. No production code changes and no Luna calls.

Status: **completed** for all seven models. The new OCR pipelines do not beat the
historical local baseline on value accuracy. EVIE is the strongest measured
visual locator, but this does not establish semantic evidence verification.

Artifacts are gitignored under `artifacts/catalog-lab/beier/models-v1/`.
`report.html` contains the tables and an image/raw-OCR comparison; `summary.json`
contains the same table data. Raw outputs, manifests, logs and checkpoints remain
beside them. The original experiment's frozen files are unchanged.

## Results

All OCR rows below use the desktop protocol. CER covers only the four reviewed
samples, not the entire transcription.

| OCR | Full starts / 29 | Full sample CER | Full seconds | Column starts / 29 | Column sample CER | Column seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Nanonets | 29; duplicate 215 | 1.20% | 850.5 | 29 | 1.20% | 590.3 |
| NaviDC | 2 | 52.02% | 1245.9 | 29 | 0.55% | 576.2 |
| Hunyuan | 27 | 26.61% | 1032.0 | 29 | 1.96% | 840.5 |
| Nemotron Parse | 27; duplicate 212 | 2.73% | 223.4 | 29 | 3.16% | 246.6 |

NaviDC full pages 1 and 2 and Hunyuan full page 1 reached the 600-second
generation limit. All other desktop images terminated before that limit; none
reached its token cap. NaviDC full page 3 terminated early with only a portion
of the spread. Successful termination therefore does not imply completeness.

After all inference, inspection of the shared 228 discrepancy found a reference
typo: the PDF says **Fdpl. 1. Gleinaer Berg**, not **4.** The original reference,
inference outputs and original scores remain unchanged. The arrows below show
frozen-reference score → separately rescored, corrected-reference score.
`reference-correction.json` records the source region; the 6× PDF detail is saved
as `reference-228-detail.png`. This is explicitly a post-hoc source correction.

| Extraction run | Values / 203 | Correct + localized / 164 | Unique IDs / returned | LLM calls | Extraction seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Historical local baseline, reused | 202 → 201 | 161 → 160 | 29/29 | 10 reused | 11.05 reused |
| GLiNER, two runs | 77 → 77 | 59 → 59 | 28/29 | 0 | 1.65–1.70 |
| Nanonets columns | 197 → 198 | 158 → 159 | 29/29 | 10 | 12.31 |
| NaviDC columns | 198 → 199 | 159 → 160 | 29/29 | 10 | 12.00 |
| Hunyuan columns | 199 → 200 | 160 → 161 | 29/29 | 10 | 16.80 |
| Nemotron columns | 189 → 190 | 131 → 132 | 29/29 | 10 | 11.90 |
| Nanonets full | 186 → 185 | 149 → 148 | 28/30 | 10 | 12.27 |
| NaviDC full | 14 → 14 | 10 → 10 | 2/4 | 2 | 3.95 |
| Hunyuan full | 185 → 186 | 144 → 145 | 28/28 | 9 | 11.91 |
| Nemotron full | 155 → 155 | 105 → 105 | 26/28 | 10 | 11.56 |

Every new OCR extraction that returns entry 225 still assigns the pavement's
NW–SO direction as a burial axis. Better OCR did not resolve that semantic error.
The localization column is coarser for new OCR, so Hunyuan's 161 versus the
corrected baseline's 160 is not a measured improvement in paragraph grounding.
Nemotron's `FdpI.`, `FdpJ.` and `Fdp.` OCR variants also cause the frozen linker's
strict `Fdpl.` header filter to reject otherwise correct header values.

| Retriever | Hit@1 | Hit@3 | MRR | Encode + score seconds | Load seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| NeoMME multi-vector | 76.22% | 93.29% | 0.855 | 12.80 shared | 4.38 |
| NeoMME dense | 20.12% | 53.66% | 0.419 | same execution | same execution |
| EVIE 2048D | 96.34% | 99.39% | 0.979 | 29.15 | 14.69 |

NeoMME encoded the twelve images in 2.81 s and the 164 queries in 9.39 s;
scoring took 0.60 s. EVIE took 6.37 s, 21.95 s and 0.83 s respectively.
EVIE used the reference PyTorch implementations for its optional causal-conv1d
and gated-delta kernels; optimized extensions were not installed.

The execution produced 60 desktop OCR image outputs plus the retained page from
the interrupted 200-DPI attempt, 58 GLiNER encoder forwards, 352 retrieval forwards
and 71 new NuExtract requests (174,583 reported prompt and 13,356 output tokens). The empty
Ollama load/unload requests generated no text. There were no new Luna requests.
NuExtract was preloaded with the same 32,768-token context before timing, then
unloaded after all eight runs. Its temperature remained the frozen 0.2.

`execution-accounting.json` records actual response token totals and effective
downstream settings. The generic frozen scorer receives a minimal run object,
so its default `fewShot=false`, `fieldAware=false`, `batchSize=null` and zero token
counts are not execution measurements. The actual frozen downstream script and
saved requests use few-shot examples, field-aware linking and batches of three.

These timings describe direct native APIs on this Windows host, without an
optimized serving comparison. GLiNER's two outputs were identical; the other
complete protocols have one run each. No production replacement is established.

Validation passed: six unit checks, all 60 OCR outputs and image/source hashes,
71 matched request/response pairs with the frozen NuExtract prompt and options,
352 retrieval forwards, the original six-file freeze (normalizing Windows CRLF),
and report table structure plus embedded JavaScript compilation. The correction
scorer also verifies that every other field's scores remain unchanged.
Run `python prototypes/studio/experiments/catalog/models-v1/validate.py` from the
repository root to repeat the artifact contract checks. See `validation.json`.

## Protocol

### Semantic verification follow-up (2026-09-08)

Completed: `semantic-v1/report.md` in the artifact directory reports two fresh
NuExtract verification repetitions for all eight saved OCR extraction outputs:
98 requests, 135,398 input tokens and 5,402 output tokens. The four column pipelines
all retain their six correct axes but also retain the false axis at 225 in both
repetitions. Their value scores therefore do not improve. Verification adds
2.79–3.56 seconds per seven-claim column run, excluding model warmup.

Full-page outputs show inconsistent gains: Hunyuan catches 225 only in the first
repetition; Nemotron catches two incorrect claims in the first and one in the
second, while rejecting one correct axis in both. Other full-page outputs gain
nothing. This does not reproduce the historical semantic-only benefit.

The unchanged rich verifier prompt from `verification-v1/run.py` receives the
entire same-record OCR context. Context selection therefore differs from the
historical header/matching-block/neighbor protocol. All non-null axes are selected
before scoring, including duplicates; source binding reproduces the original
extraction batch's first matching ID, and projection uses row indexes. Only a
`supported` semantic verdict retains the proposed value and its existing links.
Other verdicts withhold it in a separate result and require review. Original
values, links, raw requests/responses and strict quote-gate diagnostics are saved.
The strict gate does not control this semantic projection and image-level quotes
are not equivalent to the historical paragraph-level gate.

One inspected Hunyuan response calls 225 supported while naming `Pflaster` as the
oriented object; its quote does not even contain the direction. The source context
still includes the uncertain grave interpretation. A positive semantic label is
therefore not sufficient evidence of correctness. No prompt tuning followed these
results and no production behavior changes.

The follow-up freezes input/code hashes before inference. Scoring uses the already
documented corrected reference 228 and checks unchanged scores for all six other
fields. This remains a diagnostic on a known excerpt, not independent validation.
Run from the repository root with `PYTHONUTF8=1` (required by the reused reference
reader on Windows): `python prototypes/studio/experiments/catalog/models-v1/verify_semantic.py check`.
The execution commands are `freeze`, `run`, then `report`, each in place of `check`;
use a new artifact revision for another execution. Twelve existing verifier tests
and the duplicate-safe projection check passed. Saved inference and original OCR
outputs are unchanged by report generation.

Four native OCR models process the same three full spreads and twelve automatic
column crops: HunyuanOCR 1.5, Nanonets-OCR-s, NaviDC-OCR and Nemotron-Parse-2.0.
Images come from the original PDF at 200 DPI, using the existing column detector.
The separate desktop wrapper limits the longest edge to 2,000 pixels before the
native processor, uses BF16, deterministic generation, and a 600-second generation
limit per image. Limits are reported, not treated as successful full transcripts.
The model-specific prompts are recorded verbatim in `ocr.py` and run manifests.

The desktop variant was chosen after the initial Nanonets full-resolution run
took 563.7 seconds for its first image and approached the GPU memory limit.
That partial attempt is retained separately. This operational choice is post hoc.

`normalize_ocr_v2.py` unwraps Nemotron layout tokens and removes Markdown heading
and emphasis markers. It never repairs OCR letters using the reference. This
revision was added after Nanonets exposed a format-only header-counting defect,
before any new-OCR downstream extraction. Original raw and first-normalization
outputs are retained. The shared frozen OCR scorer then counts parent starts and
measures substring CER on four PDF-reviewed samples (917 characters) at entries
213, 214 and 225. This is **not whole-document OCR accuracy**.

Each complete OCR variant feeds the original NuExtract prompt, examples, batch
size of three and field-aware lexical linker. Full-page and column runs are
separate. The new evidence locations are source images, not the old parser's
paragraph anchors; supported-value counts therefore have coarser granularity.
Value references stay unchanged. NuExtract runs only through local Ollama.

GLiNER uses its native seven-field entity-span API on the existing 29 record
boundaries, preserves native offsets, selects the first offset-valid span in
source order, and rejects it if numeric validation fails. Two identical-input runs count actual encoder
forwards separately from LLM calls. This tests this particular schema/selection
protocol, not every possible GLiNER configuration.

EVIE and NeoMME encode a fixed inventory of twelve original column images and
164 queries grouped into 29 catalog records. Each query gives the record number
and field description, but no other answer value. The 29 catalog-number queries
therefore already contain that field's answer as the identifying number; this
is a location task, not unknown-value recovery. The earlier freeze's shorthand
"answer-free" should be read with that qualification. Relevant columns were
reviewed against the PDF before retrieval inference. The initial automatic
binding and its eight corrected links remain available for audit. Rankings use
the source-reviewed binding. EVIE uses its native ColPali code, bidirectional
attention and the 2,048-dimensional head; NeoMME reports dense cosine and
multi-vector MeanMaxSim separately. Ranking does not establish semantic support
for an extracted answer.

## Reproduce

Run Python commands from the repository root. Use Python 3.12 and the per-runtime
lock files in the artifact directory. Set `PYTHONUTF8=1`, `HF_HUB_OFFLINE=1`,
`HF_HOME` to the absolute artifact `hf-cache` directory and `HF_MODULES_CACHE` to
its `modules` child **before importing Transformers**. Use one GPU model at a time.

```text
python prepare.py                         # paths below assume this script directory
python ocr_desktop.py nanonets --run desktop2000-r1
python ocr_desktop.py navidc --run desktop2000-r1
python ocr_desktop.py hunyuan --run desktop2000-r1
python ocr_nemotron.py nemotron --run desktop2000-r1
python normalize_ocr_v2.py ARTIFACT_RUN_DIRECTORY
python score_ocr.py ARTIFACT_RUN_DIRECTORY/plain-v2
python retrieval.py neomme --run r1
python retrieval.py evie --run r1
python score_models.py ARTIFACT_RUN_DIRECTORY
python score_corrected_reference.py       # once, after scoring all saved runs
python report.py
```

Prefix Python script names above with
`prototypes/studio/experiments/catalog/models-v1/` from the repository root.
Always choose a fresh output run name. Run downstream from `prototypes/studio`:

```text
node --import tsx experiments/catalog/models-v1/downstream.ts --ocr ../../artifacts/catalog-lab/beier/models-v1/MODEL-RUN/plain-v2 --out ../../artifacts/catalog-lab/beier/models-v1/MODEL-downstream-columns-r1 --mode columns
```

Repeat with `--mode full` and a new output directory, then run `score_models.py`
on each output. The exact NuExtract request template comes from the archived
`desktop-b3-r3/call-001-actual-ollama-request.json`.

Checkpoint repository IDs, immutable revisions and files are recorded under
`sources/` and `checkpoints/*/verified-metadata.json`. The downloader verifies
Content-Range and full LFS SHA-256 before accepting a checkpoint. Custom Python
was inspected before use. Nemotron's C-RADIO dependency is pinned to
`0d8f4c18c877166eda07ddae1386bcad256b7a6a` in the offline cache, because its loader
otherwise requests an unpinned revision. The Nemotron wrapper preserves its
native attention configuration rather than forcing top-level SDPA.
For Nemotron, `native-attention.json` supersedes the generic manifest's SDPA label.

Nanonets/NaviDC runtime: Transformers 4.57.6. The modern runtime uses Transformers
commit `bd05a4b2baf8b37b8f64c0c2c70d2628583f7c2a` (5.17.0.dev0), because the tested
5.16.1 release did not expose NeoMME. Both use PyTorch 2.8.0+cu128. Earlier lock
files remain historical; use `runtime-*-final.lock.txt` for the final snapshots.

## Limits

One known catalog, agent-reviewed references, no blind holdout, no model tuning
or aggregate production claim. Queries share records and are not 164 independent
examples. All retrieval queries have a relevant candidate: this inventory does
not measure abstention on unsupported claims or controlled wrong-object traps.
GPU inference is serial, but downloads and CPU preparation may overlap;
host timing is not an isolated benchmark. Loading, OCR, extraction and retrieval
timings are reported separately. Original paragraph grounding and new image-level
localization must not be presented as equivalent measurements.

## Interpretation alongside grounding_lab

The parallel review of `grounding_lab` at commit `a9fd0bbc` reinforces the
separation between value correctness, evidence localization, OCR fidelity and
record identity. A unique lexical occurrence under the wrong object or field can
still be wrong evidence. In entry 225, NW–SO describes the pavement; its proposed
interpretation as a grave floor is uncertain. Finding its column does not resolve
that ambiguity. Nemotron **Parse** here is not the lab's Nemotron reranker.

The earlier [verification revision](../verification-v1/README.md) is a separate
experiment: its semantic-derived result is a post-hoc replay of two NuExtract
responses, not fresh inference or a blind evaluation. Its original prompt still
requested oriented-object, support and uncertainty information. Changing to a
block-label prompt does not isolate the causal effect of anchor IDs.

Missing evidence must be diagnosed as missing/corrupt text, failed quote matching,
or support spanning multiple blocks before attributing it to OCR or retrieval.
The current image-level metric cannot isolate these cases and does not run a
multi-anchor verification ablation. Retrieval outputs are candidate locations,
not calibrated confidence or automatic approval. No lexical fallback is added to
fill every gap. Nanonets image descriptions remain model-generated text, not
authoritative transcription. This source contains no new blind validation set.

A read-only replay of the frozen linker against the three historical missing
links gives the following diagnostic; it does not change that experiment:

| Historical missing field | Observed cause |
| --- | --- |
| Locality 225 | Original parser header says `Groβkorbetha` (Greek beta), while the value says `Großkorbetha`. The lexical match fails. |
| Axis 214 | `O-W` matches two original anchors: the main chamber and a passage about a different structure. The unique-hit gate abstains. |
| Axis 223 | Original value is `0-W`. The linker normalizes the source to `O-W`, but not the value, yielding zero hits. Passing canonical `O-W` yields one hit. |

These are distinct from the verifier's exact-quote and single-block restrictions.
The new OCR runs may change their occurrence, but retrieval accuracy alone cannot
show that any of these semantic or matching issues has been resolved.
