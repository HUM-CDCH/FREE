# Catalog strategy results — 2026-09-08

Status: completed prototype experiment on branch `codex/catalog-strategy-prototype`,
production baseline commit `3b7ad81`. The production pipeline is unchanged.

For this catalog and these seven fields, the strongest measured compromise is
Beier-format boundaries in code, NuExtract extraction in batches of three,
field-aware evidence selection in code, and one selective Luna grounding request.
It used **11 calls and 40.4–50.7 seconds** across two completed
runs, with **201–202/203 correct values** and
**163–164/164 correctly supported populated fields**.
Both runs still extracted an unsupported burial orientation for entry 225;
100% coverage of populated reference fields is not 100% accuracy of all claims.
The second run also omitted the findspot's leading number in entry 214.

The five-record hybrid is a faster option: seven calls, 40.1–44.4 seconds,
200–201/203 values and 162–163/164 supported fields across three completed runs.
This is a measured tradeoff, not proof of a globally optimal strategy.

[Open the interactive report](../../../../artifacts/catalog-lab/beier/report.html)
for pipeline diagrams, prompts by stage, every completed/failed comparison, and
field-by-field PDF evidence inspection. [Run the prototype](README.md).

## Comparison

| Strategy | Completed runs | Calls | Time after parsing (s) | Correct values / 203 | Correct + supported / 164 | Evidence precision | Unique expected / returned |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Current pipeline · Luna | 2 | 61 | 329.3–329.8 | 198–200 | 148–160 | 98.7–98.8% | 29 / 29 |
| Rule boundaries · NuExtract batches of 3 · code + Luna | 2 | 11 | 40.4–50.7 | 201–202 | 163–164 | 98.8–99.4% | 29 / 29 |
| Rule boundaries · NuExtract batches of 5 · code + Luna | 3 | 7 | 40.1–44.4 | 200–201 | 162–163 | 98.8–99.4% | 29 / 29 |
| Rule boundaries · NuExtract one record · code + Luna | 3 | 30 | 53.2–62.1 | 202 | 164 | 99.4% | 29 / 29 |
| Rule boundaries · NuExtract batches of 5 · code only | 1 | 6 | 35.8 | 200 | 161 | 98.8% | 29 / 29 |
| Luna discovery · NuExtract batches of 5 · code + Luna* | 3 | 10 | 55.7–57.0 | 200–201 | 162–163 | 98.8–99.4% | 29 / 29 |
| Luna discovery · NuExtract one record · joint evidence* | 1 | 32 | 97.6 | 202 | 160 | 98.8% | 29 / 29 |
| Luna discovery · NuExtract batches of 5 · joint evidence* | 1 | 9 | 85.4 | 202 | 155 | 95.1% | 29 / 29 |
| Luna discovery · Luna batches of 5 · joint evidence* | 3 | 9 | 92.0–98.9 | 201–202 | 160–163 | 98.2–99.4% | 29 / 29 |
| Luna discovery · NuExtract separate grounding* | 1 | 61 | 114.4 | 202 | 118 | 92.9% | 29 / 29 |
| Combined discovery/extraction/evidence · Luna | 1 | 3 | 66.0 | 182 | 148 | 81.3% | 27 / 31 |
| Combined discovery/extraction/evidence · NuExtract | 1 | 3 | 127.5 | 146 | 94 | 34.9% | 23 / 54 |

An asterisk means discovery was reused from the first Luna baseline. Its three
calls and 17.266 seconds are included in the displayed full-pipeline estimates.
The report separately shows executed calls and measured wall time. Such totals
are estimates, not newly measured end-to-end runs. All other displayed times are
measured after parsing. Ranges show observed repetitions, not confidence intervals.
Luna and NuExtract run on different infrastructure; shared-server load and model
variability were not controlled.

There were 22 completed full-excerpt runs, 5 failed runs, and
1 deliberately interrupted supplemental run, in addition to development
experiments and minimal CLI diagnostic probes. A completed call sequence can
still fail the accuracy test, as the combined-chunk rows demonstrate. Successful
execution sequences above made 399 actual application-level model calls;
reused discovery is not counted again in that number. Hidden provider requests are
not measured.

## What the code and runs establish

The current Catalog pipeline makes three discovery calls, 29 value-extraction
calls and 29 grounding calls on this input/schema. The first Luna run spent
17.266 seconds in discovery, 155.022 in extraction and 157.077 in grounding.
It saves a value checkpoint before grounding. Grounding groups populated claims
by record and receives `C label → value` pairs plus `E label → passage` pairs.
The request does **not** include claim field names, result paths or schema
definitions. See [`module.ts`](../../../../packages/extraction/src/module.ts),
[`grounding.ts`](../../../../packages/extraction/src/grounding.ts) and
[`_provider.ts`](../../api/_provider.ts).

Joint extraction and evidence is feasible: the NuExtract one-record version
reduced the estimated pipeline from 61 to 32 calls, with 202/203 values and
160/164 supported fields. Its separate-grounding counterpart had the same value
score but only 118/164 supported fields. This comparison changes prompting and
evidence packaging; it does not isolate one causal factor.

NuExtract still made incorrect anchor selections when evidence was included in
the extraction response. Grouping five records reduced that approach to nine
estimated calls but supported only 155/164 populated fields. The code linker uses
printed field conventions and abstains on zero/multiple candidates; the Luna
fallback receives only unresolved non-null claims, with field names and the
record definition. It does not repair values or detect omitted values.

The three-call chunk approach returned 31 rows with Luna and 54 with NuExtract,
instead of the expected 29. Duplicate records receive no field-value credit.
Reducing calls this far did not preserve record or evidence accuracy.

The rule boundary detector uses numbered headings containing `Fdpl.`. It found
all 29 visible starts without consulting the reference answers. This is specific
to the Beier format; it does not establish a general discovery replacement.

## Parsing check

The supplied file is three scanned A3 landscape spreads, printed pages 128–133,
with four text columns per PDF page and no embedded text. The running parser
reported 99.013 seconds, 138 canonical blocks, 138 evidence anchors, and 143
location observations. It separated the four columns and restored source-PDF
coordinates. All parent starts 205–233 appear in order; all observation boxes
are within their page bounds.

Visual review against all three rendered source pages found material defects:

- Entry 213 has displaced/interleaved sentence fragments in canonical blocks
  43–47 (zero-based positions).
- Entry 214's continuation includes interleaved fragments in blocks 56–57.
- Entry 225 is printed `Großkorbetha`; its header OCR reads `Groβkorbetha`, using
  Greek beta. Primary scoring follows the PDF, with a separately labelled
  OCR-tolerant diagnostic.
- The evidence anchor containing entry 214's chamber description correctly
  spans PDF spreads 1 and 2. Its multiple original-page boxes were checked in
  the report. Block-level evidence boxes can include several paragraphs.

This supports using the snapshot for the selected-field comparison; it does not
establish clean transcription for detailed archaeological descriptions.
The original opening continuation has no parent start in the supplied excerpt
and is excluded from the 29 expected records. The last entry is evaluated only
on information present in the excerpt.

Parsing remains a shared cost. Adding its recorded time gives approximately
429 seconds for the current Luna baseline versus
145 seconds for the three-record hybrid at their median post-parse times.
Those totals combine one parser measurement with each extraction measurement.

## Reference and runtime provenance

The reference contains 29 parent records × seven fields = 203 values, including
164 populated fields. It was reviewed by the agent against rendered source pages
and has not been independently adjudicated by a researcher. The fields cover
identity, locality, locality part, findspot, map sheet, parent find type and main
burial axis. This benchmark does not cover complete artefact lists or arbitrary
Catalog schemas.

Candidate development used IDs 205–214. The full PDF and initial full-baseline
results were visible before the execution/scoring freeze; IDs 215–233 are an
additional reported subset, not a blind holdout. Batch-size exploration followed
inspection of the initial full-excerpt comparison. Prompts and reference values
remained frozen. No reference answer is read during extraction.

Source SHA-256:
`65b1faf0907e9cfd007514b8c7434a330c852259afa946a5dc0b016e62250c02`.
Parsed snapshot SHA-256:
`73fe4ab398c64ab9f023bae38d8408bf030c8e5afe9a14e6d8f4c76a8f2f06f2`.
NuExtract: `hf.co/numind/NuExtract3-GGUF:Q4_K_M`, Ollama `0.32.14`, digest
`68940ea2c642006cf534fca37d0fc12c675121fc31210d82624082645d865fc4`.
The existing raw adapter uses context 32768, output limit 8192 and temperature
0.2. Luna uses `gpt-5.6-luna` through the installed Codex CLI `0.148.0`, with the
production adapter's `effort: none`. Model metadata and actual prompt bytes are
saved in the artifacts, including NuExtract's native example slot containing two
invented records. There are no Beier answers in that example.
The installed packages observed at final verification were AI SDK `7.0.48`,
`ai-sdk-provider-codex-cli` `2.1.2`, and `ai-sdk-ollama` `4.1.0`. A concurrent
dependency-declaration edit in Studio's `package.json` was outside this prototype;
the installed package files still reported these versions and Codex `0.148.0`.

The original all-NuExtract production baseline failed discovery on chunk 2 after
one correction: its selected catalog end was not after its last record start.
Four supplemental attempts failed because the local Luna CLI could not parse
its current configuration. The isolated probe reproduced the error with
`features.context_management` set to a table containing `experimental_mode=true`;
the `multi_agent_v2` table alone succeeded. The saved configuration subsequently
changed outside this experiment; the normal adapter then worked and trials
resumed. No saved model/Codex configuration was edited by the prototype.

Failed temporary startup-wrapper attempts and the interrupted run remain in the
artifact inventory. Failed sequences are not used as successful latency results.
The report and run directories preserve raw requests/responses, traces, call
metadata, failures, hashes, reused-call provenance and source/evidence overlays.

## Verification

Seven Python scoring tests and four TypeScript linker tests pass. Strict
TypeScript checking and focused ESLint pass. The report was checked in Chromium
for pipeline switching, batch-size controls, all-field/error filtering, failed
and duplicate records, clearing stale selections, multi-page evidence overlays,
and layout at 1600 and 900 pixels. Original PDF pages and report screenshots were
visually reviewed. These checks establish prototype behavior; the live runs
provide the accuracy and latency measurements.
