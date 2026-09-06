# Reproducibility audit — 2026-09-05

Snapshot: **2026-09-05 10:47:49 UTC**. Read-only inspection of source inputs,
prepared requests, run metadata, and scoring code. No holdout labels,
predictions, outcome dumps, or transport response contents were opened. No
model requests were started or restarted.

The **11:38:38 UTC final extraction refresh** below supersedes the earlier
pending-status snapshots while preserving their audit provenance.

## Verified bindings

`python -X utf8 -m grounding_lab.holdout_evaluation experiments/2026-09-05 verify`
passed. This rehashed all **17 frozen files and all four original PDFs**,
rather than trusting their filenames. Freeze time: 09:08:10 UTC, before every
prepared holdout request inspected here.

| Artifact | SHA-256 |
|---|---|
| [freeze.json](freeze.json) | `e469ea9f639eb5d1f351c438547e7e45923e437993304f44fcb06253a4501cf9` |
| [review-order.json](review-order.json) | `2d5ad39c71bdbba84d256bb8d0ad2fb9705cfa0dda440304f97d99d176c63738` |
| Frozen risk parameters, `JSON.stringify(freeze.riskModel)` | `e303111425dbb04ed5ddd0898d5149ef3b5517783a53d7701f936517e94f4a80` |

For **all six prepared requests**, reconstructed the exact prompt from the
complete current parsed document, frozen typed schema, source instruction,
and frozen baseline/quote instructions. Every comparison passed:

- Request and prompt hashes match `prepared.json`; terminal metadata, when
  present, agrees on PDF, parsed-document, canonical-text, schema and
  instruction hashes.
- Both arms of each prepared family use identical parsed input, canonical
  text, source instructions and underlying typed template. The quote arm
  adds only its verbatim-quote instruction and scalar wrappers. Its output
  JSON Schema was checked against those wrappers.
- `canonical_source.txt` exactly matches the complete canonical projection.
  No page subset or gold-dependent input is used: `windowed` is null,
  `documentSource` is `canonicalSource`, and the full reconstructed source is
  present in the request. The parsing script passes the original PDF to the
  Parsing Service without selecting pages.
- Every request uses `qwen3.8:27b`, context **262144**, output budget **32768**,
  temperature **0**, seed **0**, `think:false`, `truncate:false`, and
  `shift:false`. Prepared metadata pins digest
  `22130167c4c20e20c7b71454612966ca8e8171e9b3cc8ab6ce8aa6cbfec79643`.
  All five terminal metadata records report Ollama **0.32.14**; the running
  request has no terminal version/usage record yet.

| Family | Complete canonical UTF-16 characters | Canonical text SHA-256 |
|---|---:|---|
| Beier | 520965 | `03435207873697d3300bcb1bf26b667f664c72fcc2372a1b15e0904a3041776e` |
| Bosch | 443663 | `9e41c75b6c80ca19cb8d6af710b8584b53dd32e72176c908cd4e948da9c27e43` |
| Wiermann | 205055 | `3ff630303d2f5c94eaa1d03b8f49aab5f3b69d19c3c32bceec33a2c3b0a36557` |
| Kirsch | 297588 | `c7d6ba07ac595f369e55f2730a6c950f8030cbd226250168d7a7481dab787741` |

## Attempt snapshot

| Family / arm | Extraction status | Input / output tokens | E replay metadata |
|---|---|---:|---|
| Beier / baseline | Complete, stop | 226661 / 10030 | Complete |
| Beier / quote | Failed: more than 20 records; stop | 226969 / 32490 | Complete; diagnostic recovery does not change failure status |
| Bosch / baseline | Not prepared | unavailable | Not started |
| Bosch / quote | Not prepared | unavailable | Not started |
| Wiermann / baseline | Complete, stop | 93180 / 10591 | Complete |
| Wiermann / quote | Failed: incomplete generation, length | 93528 / 32768 | No replay metadata; incomplete output remains excluded |
| Kirsch / baseline | Complete, stop | 122430 / 7353 | Pending |
| Kirsch / quote | Running; prepared 10:36:00 UTC | unavailable | Pending |

Request SHA-256 values, independently recomputed from each `request.json`:

| Family / arm | SHA-256 |
|---|---|
| Beier / baseline | `9b79e836a5027e4e08c885fcfd18bea3ea4899b93ac1808adda73db93b7f6da2` |
| Beier / quote | `709d61fe75c4ca23fa4ad3be7456e37184ceacf432b06689c7458814a52de405` |
| Wiermann / baseline | `92a0da7542f56f50ddd6e3c5843ae47ea5893e7a3975de0e9056ef8988baa710` |
| Wiermann / quote | `ee0f0561d77cf3dbad6acf5ec9e028ccb50bf64947cba233617c5d58dad5ba65` |
| Kirsch / baseline | `9c0fd832e93930eae861ffe5bc7b1268c416b5be7632db7496966ad749a3540d` |
| Kirsch / quote | `3b1bb6ec1c5e4ee2add8a2854792e8c4670e5299b9b34cefab3037c3a8dd11c6` |

## Separation from gold labels

The normal `holdout_evaluation.score` entrypoint regenerates
`claims_unlabelled.json` from typed extraction values using `labeling_sheet`,
which sets `goldAnchorIds:null`. It loads only that claims filename: it does
not load `claims_extracted.json` or blind-label files. `load_dataset` turns
those null golds into empty tuples; it has no fallback to labeled claims.

E uses the frozen hit-set/rich-hitset/zero-hit-abstain settings. Candidate
selection and `_score_entries` do not consult gold anchors. Frozen thresholds
are passed directly to the outcome dump, rather than refit on these sources.
The dump's temporary label-dependent outcome names are removed before risk
inference. `score_frozen` uses only frozen parameters and label-free candidate,
route, value and sibling features; it contains no training step and rejects
document names present in its development training set.

The frozen risk training documents are the six existing development sources:
both Buchvaldek sets, Conrad, Dobeš, Durankulak and Shbat. Existing E replay
metadata matches
`nvidia/llama-nemotron-rerank-1b-v2@828765652b05bd439c9789d2a6d093db1caa1443`
and records `autoAccept:false`.

## Limits of this audit

- This verifies the ordinary entrypoint and artifact bindings, not an
  adversarial guarantee against manually altered intermediate files.
  No claim-level or outcome-level numerical results were audited.
- The original PDFs, main policy code, schemas and instructions are frozen;
  parsed representations were produced later and bound at extraction time.
  Supporting modules such as the canonical-source package, harness,
  `raw_claims`, and experiment orchestration are not all listed in the
  original freeze. Exact prompt reconstruction provides a present-state
  check; it is not a complete environment or dependency lockfile.
- The model tag is checked against its pinned digest before inference, but
  saved metadata is not cryptographic attestation of a remote model process.
  Token counts and completion status are provider-reported. No independent
  tokenizer or server trace was inspected.
- Full canonical input does not prove complete OCR, correct page reading
  order, or correct first-20 record selection. Those remain separate source
  and scope checks. A document-family name disjoint from training also does
  not prove record-level independence; Beier remains a transfer family per
  the separate source-overlap audit.
- Bosch and the pending Kirsch work require a later metadata audit. Timing
  excludes one-time PDF parsing and warmed reranker loading; E replay timing
  is measured separately from extraction.

## Refresh — 2026-09-05 11:12:03 UTC

All **eight holdout requests are now prepared and verified**. Repeated the
same exact prompt reconstruction and every binding/configuration check for
all eight requests; every check passed, including both Bosch arms. Both arms
of every family bind the same full canonical source, parsed document, typed
schema meaning and source instruction. No gold-selected windows were used.
The canonical-text hashes in the initial table remain unchanged.

The existing `verify` command again passed all **17 frozen files and four
original PDF hashes**. `freeze.json` remains
`e469ea9f639eb5d1f351c438547e7e45923e437993304f44fcb06253a4501cf9`.
All seven terminal metadata records report Ollama 0.32.14; every prepared
request retains the same pinned model digest, 262144/32768 budgets and
non-truncating configuration documented above. No terminal claim is made
for the still-running Bosch quote request.

| Newly audited request | Request SHA-256 |
|---|---|
| Bosch / baseline | `ecc0ab3932bde4abf35fda7d9ef54f61c13fb8354935d8ff0623863652b0f9b2` |
| Bosch / quote | `8ec23b4a8c6f98e9ec69c18ebadc4addc5ec6e7118d1b94bc3f33d673f7403b9` |

The other six independently recomputed request hashes remain identical to
the initial audit. Current statuses are **four complete, three failed, one
running**; failed record-limit outputs remain failed even when available
for diagnostic labeling.

| Family / arm | Extraction status | Input / output tokens | E replay metadata |
|---|---|---:|---|
| Beier / baseline | Complete, stop | 226661 / 10030 | Complete |
| Beier / quote | Failed: record limit; stop | 226969 / 32490 | Complete; diagnostic |
| Bosch / baseline | Failed: record limit; stop | 193008 / 8740 | Pending |
| Bosch / quote | Running; prepared 11:06:13 UTC | unavailable | Pending |
| Wiermann / baseline | Complete, stop | 93180 / 10591 | Complete |
| Wiermann / quote | Failed: incomplete generation, length | 93528 / 32768 | Not applicable to excluded incomplete output |
| Kirsch / baseline | Complete, stop | 122430 / 7353 | Complete |
| Kirsch / quote | Complete, stop; finished 10:53:32 UTC | 122778 / 22684 | Complete |

All five available E replay metadata records match the frozen Nemotron
revision and `autoAccept:false`. This refresh again read no labels,
predictions, outcome dumps, or transport response contents, and started no
requests. The last Bosch terminal status and any later replay metadata
require a final refresh; all other original audit limitations remain.

## Final extraction refresh — 2026-09-05 11:38:38 UTC

All **eight extraction calls are terminal: four complete and four failed**.
The last call, Bosch quote, ended at **11:36:34 UTC** with `finishReason:length`
and the complete 32768-token output budget consumed. It remains an incomplete
failure. Both record-limit failures also remain failed despite diagnostic
recovery; no attempt was silently omitted or converted to a successful run.

Rechecked all eight final metadata records against their prepared bindings,
recomputed request/prompt/canonical-copy hashes, and verified the pinned
digest, version and non-truncating configuration. **Every check passed**.
The existing `verify` command again passed all 17 frozen files and all four
original PDF hashes. The freeze hash is unchanged. All eight terminal
records report Ollama 0.32.14 and one extraction model call.

| Family / arm | Final status | Input tokens | Output tokens | Recorded extraction seconds |
|---|---|---:|---:|---:|
| Beier / baseline | Complete, stop | 226661 | 10030 | 946.632 |
| Beier / quote | Failed: record limit; stop | 226969 | 32490 | 2007.475 |
| Bosch / baseline | Failed: record limit; stop | 193008 | 8740 | 760.305 |
| Bosch / quote | Failed: length | 193308 | 32768 | 1821.344 |
| Wiermann / baseline | Complete, stop | 93180 | 10591 | 512.440 |
| Wiermann / quote | Failed: length | 93528 | 32768 | 1294.061 |
| Kirsch / baseline | Complete, stop | 122430 | 7353 | 476.899 |
| Kirsch / quote | Complete, stop | 122778 | 22684 | 1051.645 |
| **Physical extraction totals** | **8 calls; 4 complete / 4 failed** | **1271862** | **157424** | **8870.801** |

Total provider-reported tokens: **1429286**. Summed provider
`totalDurationNs` equals **8863.197733 seconds**, distinct from the sum of
local recorded extraction durations above. These physical holdout totals
include failed calls but exclude pilots, labeling/adjudication, parsing,
reranker replay and later diagnostic-recovery work; quote/E and quote-only
do not create additional extraction calls. No token/call counts are unknown
for these eight terminal extraction attempts.

Only the **Bosch baseline E replay remains pending** among the six complete
typed outputs eligible for replay (four runner-valid outputs and two
record-limit diagnostics). The five existing E replay metadata records are
complete; the two length-truncated quote outputs are not eligible for
replay. This audit did not inspect their predictions. A later replay-status
update must not alter these final physical extraction totals.

No labels, outcome dumps, predictions or transport response contents were
read during this final refresh. No requests or policy edits were made.

## Coordinator completion note — 2026-09-05

Bosch baseline E replay subsequently completed: core scoring 612.003 seconds,
395 neural claim-scoring calls, the same pinned Nemotron revision, and
`autoAccept:false`. All six eligible typed outputs now have completed replays;
the eight physical extraction totals above are unchanged.

The coordinator's final `validation.json` verifies all frozen hashes, original
PDFs, blind packet hashes, label coverage, unlabelled scoring inputs and the
four-failure ledger. Unlike the independent source/request auditor, the
coordinator reads finalized labels to assemble the report. No frozen policy
or input was changed. Broader observed workflow spans and original timestamp
hashes are retained separately in `WORKFLOW_TIMINGS.md` and
`workflow-timings.json` because core timers exclude risk and audit-file work.
