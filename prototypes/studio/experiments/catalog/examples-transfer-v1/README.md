# Transfer to examples/graves — 2026-09-08

The later production-executor comparison is in `comparison.md` and
`comparison.json` under the same artifact directory. `compare.ts` invokes the
real production executor with Qwen 3.8 27B or Gemma 4 12B on Spark for Discovery
and grounding, and local NuExtract for values. The original batch-3 runner reuses
each production run's boundaries. Its prompt and examples remain frozen.
The two Catalog modes differ in prompting and grounding as well as batch size.
No application configuration or database is changed.

From Studio, `node --import tsx experiments/catalog/examples-transfer-v1/compare.ts
--check` performs a local contract check. Without `--check`, the command sends
the five parsed source documents to the Spark endpoint explicitly authorized for
this experiment. Existing r2 result files are skipped; other existing output
directories are never overwritten. The preliminary r1 transport runs are
excluded from the comparison. From the repository root, regenerate and audit
the comparison with
`python prototypes/studio/experiments/catalog/examples-transfer-v1/compare-report.py`.

The following describes the earlier NuExtract-only Discovery diagnostic.

Completed diagnostic. Five full PDFs (96 pages) were parsed afresh through the
local Parsing Service, which reports Docling 2.120.3 and `parsed_document.v2`.
All source snapshots, renderings, requests, responses and scores are under
`artifacts/catalog-lab/examples-transfer-v1/`.

The unchanged Beier rule pipeline finds **zero records on all five PDFs**. At the
user's request, a separate Discovery stage then attempts one local NuExtract call
per full document, with a fixed generic instruction to select individual grave
record openings. It uses the existing canonical block labels and boundary
resolver. This Discovery prompt is new and is not the production chunked
Discovery protocol. The extraction prompt, schema, examples, field-aware linker,
model and options remain unchanged; extraction batches still contain up to three
records. No Luna calls, manual boundary repairs or prompt tuning were used.

| Document | Selected openings | Expected opening groups | Correct openings found | Intact record slices | Extracted rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| Brøndbylund 3 | Invalid labels | 0 | 0 | 0 | Not run |
| Herredsvejen | 13 | 3 | 3 | 2 | 3 |
| Højbakkegård | 110 | 9 | 9 | 0 | 0 |
| Hvissinge Øst | 166 | 7 | 7 | 0 | 0 |
| Katrinesminde | 40 | 1 | 1 | 1 | 0 |

Discovery includes every reference opening in the four valid responses, but also
309 extra openings. Most record descriptions are consequently fragmented. A
valid block label is not a correct semantic boundary. The reference concerns
opening groups, not every grave mentioned: joint descriptions count once and
collective cemetery summaries do not become individual records. It was fixed
before inference after source inspection; it is agent-reviewed, not a blind
human-labeled benchmark.

The three extracted rows all come from Herredsvejen. Their IDs are 38, 240 and
225. Two `find_type` values use Danish descriptions instead of the requested
literal FA codes. `burial_axis=SV-NØ` comes from the K5 pyre-support structure,
not a main KAK grave. No field receives an evidence link. Independently of model
quality, the original linker's row-to-boundary binding assumes headings beginning
with an integer followed by a period; Danish `Grav` and `A` headings do not match.

No literal copies of eight distinctive example values were emitted. This does
**not** show the examples are unbiased: there are only three emitted rows and no
comparison without examples. The test exposes transfer failures involving
Discovery, language, schema and linking, and cannot isolate the causal effect of
examples. No overall field-accuracy percentage is assigned to these documents
under the incompatible Beier schema. Some Hvissinge parser text is also corrupted.

Execution: **5 Discovery + 112 extraction = 117 new local requests**, 189,364 input
tokens and 2,347 output tokens. Most extraction responses contain an empty records
array. Discovery timing includes model load; parsing is separate. The initially
considered page-based prompt probe was not executed and its script was removed
when the user requested Discovery.

## Reproduce and audit

Use fresh output directories. The original `../prepare.py` parses and renders
each PDF. The original `../run.ts` with `--strategy rule-grouped-lexical --model
nuextract --batch-size 3 --few-shot --field-aware --ollama-url
http://127.0.0.1:11434` performs the rule baseline. From Studio, prepare a Discovery
request without inference:

```text
node --import tsx experiments/catalog/examples-transfer-v1/discover.ts --input ABSOLUTE_PARSED_DOCUMENT --out FRESH_DISCOVERY_DIRECTORY --prepare
```

Freeze source references and hashes before inference, then repeat the command
without `--prepare`. For valid nonempty Discovery, run the original runner with
`--strategy grouped-lexical --discovery-from DISCOVERY_DIRECTORY/result.json` and
the same extraction options. Invalid Discovery is retained as a failure; empty
Discovery is not supplied to a runner that requires nonempty boundaries.

From the repository root:

```text
python prototypes/studio/experiments/catalog/examples-transfer-v1/report.py
```

This runnable audit checks all frozen hashes, actual extraction prompt prefixes
and suffixes, examples, model/options, Discovery reuse and response completeness.
The only allowed prompt variation is the original runner's final-batch count;
source text changes as expected. It rebuilds `report.md`, `summary.json` and
`details.json`. Original benchmark and production files are unchanged.
