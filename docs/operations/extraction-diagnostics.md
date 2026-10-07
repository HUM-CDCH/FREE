# Read-only Extraction diagnostics

For an authorized support case, use this operator command before writing ad hoc
SQL or fetching an entire history. It uses Studio's ownership gate and requires
the Researcher Account UUID. The credential is the operator's existing database
access, supplied through `DATABASE_URL`; no researcher API key is needed.

```sh
pnpm --filter extraction diagnose --owner <account-uuid> --extraction <extraction-uuid>
pnpm --filter extraction diagnose --owner <account-uuid> --extraction <new-uuid> --compare <previous-uuid>
```

Studio's container already has database configuration and the TypeScript runner:

```sh
docker exec -w /workspace free-studio-1 ./prototypes/studio/node_modules/.bin/tsx \
  packages/extraction/src/durable-diagnostics-cli.ts --owner <account-uuid> --extraction <extraction-uuid>
```

The command opens a short repeatable, read-only transaction, validates both
owners before details, and invokes no model, workflow or publisher. Another
owner's or deleted Extraction is not found. Database errors use a fixed message.

## Metadata and differences

Output includes status, source revision/generation, selection digests, retained
value/group counts, stage capture/checkpoint counts and sampled input/reply
metadata. `records` counts groups in retained values; it does not measure recall.
Discovery `places` includes record and non-record boundaries. Failed responses
from the current attempt are visible too.

Source, prompt, provider and option differences use SHA-256 fingerprints rather
than text or URLs. Comparison pairs saved unit keys; unmatched sampled calls are
listed. `sampledRequests` also compares sets of request fingerprints when keys
differ. Its `complete` flag says whether both samples cover their entire stage.
Differences can reflect windowing and sampling as well as changed guidance;
the pinned source comparison remains separate. Samples default to three discovery calls. Use `--stage` and
`--limit 1..5` to select and bound the sample. `sample.truncated` distinguishes
it from the full stage. Stdout is limited to 16 KiB; oversized metadata asks for
a smaller limit.

## Private debug files

Add `--payload-dir <existing-directory>` to inspect sampled requests and replies.
The command creates a new 0700 subdirectory and exclusive 0600 files. Source text
stays there, separate from stdout. Credential fields, URL credentials and provider
errors are redacted. Files retain the original input digest and capture identity.
They are sanitized debug copies, not extraction inputs. Keep them out of Git and
remove them after the support case.

Module ownership: `packages/extraction/src/durable-diagnostics*.ts` reads and
formats diagnostics; `prototypes/parsing_service/src/kei_exp/kie/extract/durable.py`
composes exact inputs; `discovery.py` finds boundaries; and
`prototypes/parsing_service/src/kei_exp/workflows/durable_extract.py` invokes saved
requests and checkpoints responses.
