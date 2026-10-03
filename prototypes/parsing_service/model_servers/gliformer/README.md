# Optional GLiFormer fields backend

Status: development integration, October 3, 2026. No production default change
and no claim of improved extraction accuracy. This is an encoder model service;
the existing Parsing Service worker still owns admission, cancellation, durable
retries, canonical source identities, and write-once artifacts.

The optional `gliformer` registry key fills fields in **unified Catalog** runs.
Qwen continues to discover entries. The native path reads only each settled
entry's source ranges, with token-counted windows inside long entries. Entries
with unresolved ends are reported as unprocessed. The record description must
say which entries are wanted; for the grave task, use “Only numbered catalogue
entries, excluding narrative summaries.” This remains a model discovery decision.

Supported schemas contain unconstrained strings / verbatim strings and nested
arrays of objects. Article, generic/recipe Catalog, enums, derived fields,
booleans, numbers, dates, scalar arrays, singleton objects, document fields and
filename fields are refused before inference. FREE does not turn a skin mention
into `leather_material: true`, normalize identifiers, assign sex/age categories,
fill absent keys, or join predictions. Use string fields for sex/age and a nested
list for material mentions. Put skins/hides/fur guidance in field descriptions.
The pinned library does not automatically encode descriptor descriptions; this
service supplies them through the native processor's `item.prompt` for both
counting and inference. The descriptions reach the model, but compliance is not assured.

Raw records, nulls, empty lists, duplicates and missing fields survive unchanged.
Each native output window retains its exact input, canonical source ranges,
model identity, decoder output, and confidence diagnostics. Result records are
the window outputs concatenated in source order, with `record_start` and
`record_count` locating each output. Multiple records from one discovered entry
remain multiple records. Every populated value is marked ungrounded; source
ranges alone do not prove a field's attribution. Studio exposes native inputs,
outputs and scores under Catalog review. Decoder `effective_score: 1` with no
`raw_score` is not a learned confidence. These are not calibrated probabilities.

Heading context and verification resolve to off for this backend. Explicit `true`
is refused; Qwen does not rewrite GLiFormer values. The input ceiling includes
the native schema prompt and source tokens, counted by the pinned framework's
own processor without truncation. The service independently checks the actual
collator count and retained word count before inference. The operational ceiling
is 2048 input tokens; output reserve is zero. An explicit input budget above that
is refused. Reply settings still apply to Qwen discovery.

## Deployment

The model/framework revisions are pinned in `server.py` and `requirements.txt`.
The service installs its dependencies in its own image, never in the worker.
The tested ARM64/GB10 base is:

```sh
export GLIFORMER_BASE_IMAGE=vllm/vllm-openai@sha256:8a69ffad015f138d7170c4ddc429e230a3bc1c1719f67e14324749df200a4b90
# Optional. Defaults to 0.5; the live integration probes used 0.05.
export GLIFORMER_THRESHOLD=0.05
```

Add `-f compose.gliformer.yaml` **last** to the deployment's existing Compose
file list, both for build and up. Keep its normal environment, project name,
authentication, migration and worker replacement procedure. The ordinary FREE
launcher does not include this experimental overlay. The overlay adds a private
GPU model service with no published port and registers its URL in the parsing
API and worker. It changes neither Qwen/NuExtract services nor role defaults.
Alternatively, an operator-managed instance of this server can be registered
with `KEI_GLIFORMER_URL` in both parsing processes.

This integration requires a research deployment already using
`FREE_CATALOG_METHOD=unified`; it does not waive that method's release gates or
enable it automatically. Once the updated Studio, API and worker are deployed,
select **Model configuration → Models → Extracting data → Field values →
knowledgator/gliformer-large-v1**. Keep **Reasoning** on the instruction model.

The equivalent extraction options are:

```json
{"strategy":"catalog","models":{"fields":"gliformer","reasoning":"instruct"},"unified":{"defaults":1}}
```

Changing weights, framework, threshold, prompt version or decoding protocol changes the execution's
pinned identity. Resuming against a different identity fails explicitly; submit
a new extraction. Transient backend failures use the existing worker retry;
completed entries are reused. A permanent native-service refusal fails the run
without publishing a fabricated or partial reply. No DBOS workflow sequence or
new queue is introduced.

To remove the option, first finish/cancel runs pinned to it, restore affected
researchers' field choices, then remove its URL and optional service. Existing
artifacts retain their predictions and identity.

## Validation

`tests/test_gliformer_fields.py` covers schema/method refusals, role defaults,
boundary isolation, long Unicode inputs, raw values/duplicates/scores, interrupted
entry recovery and identity changes. `extract.gliformer.json` is produced by that
test and accepted by the TypeScript artifact test, including native diagnostics
and explicit ungrounded accounting. Studio tests cover the confidence display.

`KEI_GLIFORMER_TEST_URL=http://host:port uv run --no-sync pytest -q tests/test_gliformer_fields_live.py`
explicitly tests a running native service: schema instructions must enter the
token count and actual collator; oversized inputs and changed identities must fail.

The October 3 live probe used three supplied grave excerpts (200, 204, 10,031)
and a separate narrative summary, assembled as canonical test evidence. Qwen
discovered three entries and marked the summary `other`; GLiFormer received
three isolated requests. Token counts, including instructions, matched its
collator. Oversized input was refused with HTTP 413; a foreign identity with
HTTP 409. Native output still contained incorrect grouping and extra records. This is integration
evidence, not a full-document benchmark, held-out evaluation, or human gold.
Production Studio/DBOS end-to-end deployment has not been exercised by this probe.
