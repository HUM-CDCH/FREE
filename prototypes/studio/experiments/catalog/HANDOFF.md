# RTX 4090 experiment handoff — 2026-09-08

Status: the NuExtract/Luna prototype and all seven additional local model tests
are complete. See [models-v1/README.md](models-v1/README.md) for the RTX 4090
protocol and results: four OCR models, two visual retrievers, native GLiNER span
extraction and eight downstream NuExtract runs. A separately scored PDF reference
correction for entry 228 preserves the original reference and scores.
The reconnaissance section below records
the earlier handoff state, not the current installation/inference status.
Branch: `codex/catalog-strategy-prototype`. Production baseline: `3b7ad81`.

Update 2026-09-09: the production executor now carries a `CatalogPolicy`
(five records per values call, grouped field-aware grounding, no lexical
auto-linking), measured with [policy-v1](policy-v1/PROTOCOL.md) on this
excerpt and the Danish transfer set: 15 calls instead of 61 with identical
values and links. Rationale and rejected variants:
`docs/research/catalog-policy-v1.md`.

Start with [RESULTS.md](RESULTS.md) and [README.md](README.md). The best measured
compromise on this excerpt was code boundaries → NuExtract batches of three →
code evidence selection → one selective Luna fallback: **11 calls, 40–51 seconds,
201–202/203 values, 163–164/164 supported populated fields**. Parsing added about
99 seconds. Entry 225 still acquired a false burial axis. This is one catalog,
seven fields and agent-reviewed references, not a blind or general accuracy test.

## Restore the exact inputs

Git contains the benchmark code, reference answers and results summary. The PDF,
parser snapshot, full run traces and interactive report remain gitignored.
Transfer `artifacts/catalog-lab/beier-desktop-handoff.tar.gz` and its `.sha256`
sidecar from this machine to the desktop. The archive contains the complete
`artifacts/catalog-lab/beier/` directory plus the supplied PDF as
`artifacts/catalog-lab/beier/source.pdf`; it contains no installed models or app
credentials. From the desktop repository root, with the archive in that root:

```bash
git switch codex/catalog-strategy-prototype
sha256sum -c beier-desktop-handoff.tar.gz.sha256
tar -xzf beier-desktop-handoff.tar.gz
pnpm install --frozen-lockfile
```

Open `artifacts/catalog-lab/beier/report.html` directly. Reuse
`parsed_document.json` for extraction-only comparisons; no Parsing Service is
needed for those runs. Original absolute paths in manifests are provenance.
The source and parser hashes are recorded in `input-manifest.json` and RESULTS.

For a fresh run of the current candidate, configure an authenticated Codex CLI
Model Connection in desktop Studio, then run from `prototypes/studio`:

```bash
node node_modules/tsx/dist/cli.mjs experiments/catalog/run.ts \
  --input ../../artifacts/catalog-lab/beier/parsed_document.json \
  --out ../../artifacts/catalog-lab/beier/desktop-b3-r1 \
  --strategy rule-grouped-lexical --model nuextract --batch-size 3 \
  --few-shot --field-aware --fallback-model luna \
  --ollama-url http://spark.cdch-dgxspark.lan.ku.dk:11434
```

Use `http://127.0.0.1:11434` instead after installing the exact NuExtract model in
desktop Ollama. The runner currently accepts only `luna` and `nuextract`.
Scoring, report generation and suite commands are in README. Never reuse an
existing output directory. The six execution/reference/scoring files listed in
`freeze.json` are frozen: create a new experiment revision before modifying them.

## Additional models: original reconnaissance

At the original handoff, five repositories were accessible and their cards/configs were saved under
`model-extension/` in the archive. **At that time, no weights had been downloaded,
adapters written, or accuracy/latency measurements made for these models.** The roles below come
from their repository metadata/configs, not our benchmark results.

| Requested model | Stage to test | Inspected revision |
| --- | --- | --- |
| `tencent/HunyuanOCR` | OCR/parsing; root is currently HunyuanOCR 1.5 | `47644ecc4fc854efa4f505155158831f36773ee4` |
| `tencent/EVIE-4.5B` | Visual evidence retrieval/ranking; produces embeddings | `8aecfa955e5e7d56a251291942f6f0717badb238` |
| `nvidia/NVIDIA-Nemotron-Parse-2.0` | OCR, layout and bounding boxes | `b6742064f4a8cf22a10383ece5e7fbead355ac04` |
| `nanonets/Nanonets-OCR-s` | OCR/parsing | `3baad182cc87c65a1861f0c30357d3467e978172` |
| `fastino/gliner2.5-multi-v1` | Structured span extraction; native offsets for evidence | `aaecfe45db1d828c963717054ccb868e8ad1f1d5` |
| [StarDoc-AI/NaviDC-OCR](https://huggingface.co/StarDoc-AI/NaviDC-OCR) | OCR/document parsing for digital and camera-captured documents (~1.2B parameters) | Subsequently inspected and tested locally: `710ea2e26d794fe89cbf3ece0402707c332a8671` |
| [Hcompany/NeoMME-260M-Retriever](https://huggingface.co/Hcompany/NeoMME-260M-Retriever) | Text and visual document retrieval; produces dense and multi-vector embeddings (263M parameters) | Subsequently inspected and tested locally: `0dcb6c924435bd0bf5d504dba9ba2bb63acd8595` |

Continue with isolated Python environments and one model at a time; pin runtime
versions and checkpoints. Follow each model's native API and inspect its custom
code. GLiNER's card requires `AutoExtractor`; EVIE uses its ColPali implementation.
Do not assume Ollama supports these architectures.

For OCR, compare full spreads and the existing automatic four-column crops.
Check all 29 parent starts and visually review the known defects at entries 213,
214 and 225. Build source-reviewed transcription samples for OCR scoring; the
existing parser output is not OCR ground truth. Rebind and visually check evidence
annotations whenever the parser changes. Test downstream extraction with the same
seven-field schema. Keep OCR quality, value accuracy, evidence accuracy, calls and
latency separate. For EVIE and NeoMME, measure retrieval against a fixed candidate inventory;
for GLiNER, preserve native spans and count model forwards separately from LLM calls.

The original local CLI error was reproduced with a table at
`features.context_management` on installed Codex 0.148.0. Normal calls later
worked after the saved config changed outside this experiment. See
`probe-cli-config.ts` and RESULTS; do not copy that incompatible config. Prior
verification passed 7 Python tests, 4 Vitest tests, strict TypeScript, ESLint and
interactive Chromium checks. The unrelated local Studio dependency-manifest edit
was excluded from this experiment commit; measured installed versions are in
`runtime-versions.json`.
