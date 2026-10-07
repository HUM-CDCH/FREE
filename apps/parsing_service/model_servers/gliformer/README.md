# Optional GLiFormer fields backend

Status: experimental and opt-in; never a default role. There is no accuracy
claim, benchmark or held-out evaluation, and a live integration probe still
showed incorrect grouping and extra records.

This encoder service keeps no state. Studio admits Extractions and refuses
incompatible GLiFormer choices; the Parsing Service worker revalidates and owns
durable execution and canonical source identities; results are retained
snapshots in the coordination schema.

The optional `gliformer` registry key fills fields in **unified Catalog** runs;
the instruction model, in the reasoning role, discovers the entries. The native
path reads only each settled entry's source ranges, with token-counted windows
inside long entries. Entries with unresolved ends are reported as unprocessed. The record
description must say which entries are wanted, and which numbered text (such as
discussion sections) is not a record: discovery decides what is an entry.

Supported schemas contain unconstrained strings / verbatim strings and nested
arrays of objects. Article, generic/recipe Catalog, enums, derived fields,
booleans, numbers, dates, scalar arrays, singleton objects, document fields and
filename fields are refused before inference. FREE does not turn a mention into
a boolean, normalize identifiers, assign categories, fill absent keys, or join
predictions: use string fields and nested lists, and put inclusion guidance in
field descriptions. The pinned library does not automatically encode descriptor
descriptions; this service supplies them through the native processor's
`item.prompt` for both counting and inference. The descriptions reach the model,
but compliance is not assured.

Studio checks explicitly selected GLiFormer models before admitting new single
or Batch Extractions. Unsupported fields are named together, and incompatible
methods or explicit heading/verification settings are refused with HTTP 422
(`incompatible_extraction_model`), without creating or queueing an Extraction.
Saved schemas and model choices stay unchanged; already admitted requests replay.
The Parsing Service revalidates requests as a worker-side backstop. Model
availability and runtime token budgets are still checked during execution.

Raw records, nulls, empty lists, duplicates and missing fields survive unchanged.
Each native output window retains its exact input, canonical source ranges,
model identity, decoder output, and confidence diagnostics. Result records are
the window outputs concatenated in source order, with `record_start` and
`record_count` locating each output. Multiple records from one discovered entry
remain multiple records. Every populated value is marked ungrounded; source
ranges alone do not prove a field's attribution. Studio shows each native call's
exact request and output, diagnostics and scores included, under the
Extraction's **Technical details (for audit)** → **Exact producing request and
output**, and the model identity under **Native model protocol and identity**.
Decoder `effective_score: 1` with no `raw_score` is not a learned confidence.
These are not calibrated probabilities.

Heading context and verification resolve to off for this backend. Explicit `true`
is refused; the reasoning model does not rewrite GLiFormer values. The input
ceiling includes the native schema prompt and source tokens, counted by the
pinned framework's own processor without truncation. The service independently
checks the actual collator count and retained word count before inference. The
operational ceiling is 2048 input tokens; output reserve is zero. An explicit
input budget above that is refused. Reply settings still apply to the reasoning
model's discovery.

## Deployment

The model/framework revisions are pinned in `server.py` and `requirements.txt`.
The service installs its dependencies in its own image, never in the worker.
The tested ARM64/GB10 base is:

```sh
export GLIFORMER_BASE_IMAGE=vllm/vllm-openai@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90
# Optional decoder threshold, between 0 and 1; default 0.5.
export GLIFORMER_THRESHOLD=0.5
```

Add `-f compose.gliformer.yaml` **last** to the deployment's existing Compose
file list, both for build and up. Keep its normal environment, project name,
authentication, migration and worker replacement procedure. The FREE launcher
does not include this overlay. The overlay adds a private GPU model service with
no published port and registers its URL in the parsing API and worker. It
changes neither the other model services nor role defaults. Alternatively,
register an operator-managed instance of this server with `KEI_GLIFORMER_URL`
in both parsing processes (API and worker): the API lists it, the worker runs
it.

It requires `FREE_CATALOG_METHOD=unified` in Studio and does not set it. Select
**Model configuration → Models → Extracting data → Field values →
knowledgator/gliformer-large-v1**, and keep **Reasoning** on the instruction
model.

The equivalent extraction options are:

```json
{"strategy":"catalog","models":{"fields":"gliformer","reasoning":"instruct"},"unified":{"defaults":2}}
```

Weights, framework, threshold, prompt version and decoding protocol form the
execution's pinned identity, so changing any of them, `GLIFORMER_THRESHOLD`
included, makes resuming a pinned Extraction fail explicitly; submit a new
extraction. A failed native call, transient or not, fails its capture without
publishing a fabricated or partial reply: the attempt ends `capture_failed`
once its other calls' committed outputs are compiled, and Retry continues the
Extraction and reuses every completed entry.

To remove the option, first finish or stop Extractions pinned to it, restore
affected researchers' field choices, then remove its URL and optional service.
Existing retained snapshots keep their predictions and identity.

## Validation

`tests/test_gliformer_fields.py` covers schema and method refusals (with the
cases Studio's admission shares, `tests/fixtures/contracts/gliformer-compatibility.json`),
role defaults, entry isolation, raw values and scores, long Unicode inputs, and
the golden `extract.gliformer.json`.
`packages/extraction/src/gliformer-compatibility.test.ts` checks Studio's
admission refusals over the same cases.

`KEI_GLIFORMER_TEST_URL=http://host:port uv run --no-sync pytest -q tests/test_gliformer_fields_live.py`
explicitly tests a running native service: schema instructions must enter the
token count and actual collator; oversized inputs and changed identities must fail.

The Studio end-to-end case `native unified retains real provider requests and
saved output` (`apps/studio/e2e/durable-service.spec.ts`) runs against real
servers when `FREE_REAL_EXTRACT_URL` and `FREE_REAL_GLIFORMER_URL` are set.
