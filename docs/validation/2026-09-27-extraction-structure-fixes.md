# Extraction structure and grounding fixes — 2026-09-27

Status: implemented and locally verified on `fix/extraction-structure-and-grounding`.
The user requested implementation without waiting for the entire ablation batch.
This branch includes the prior selector and structured input renderer. The frozen
R1/R2a/R3 checkouts and artifacts remain unchanged; these fixes are a separate
protocol revision, not replacement predictions in those comparisons.

## Changes

- Quoted grounding now requests one consistent object shape. A quote must occur
  literally in the cited canonical candidate; case folding, Unicode normalization
  and whitespace rewriting cannot manufacture a match. Attribution still comes
  from the model and is not independent semantic verification.
- Reply decoding permits literal control characters inside strings, retaining
  their exact value. Other malformed syntax and length-cut replies still fail.
  Only a leading thinking envelope is removed; source text containing literal
  `<think>` tags survives. Article/generic Catalog uses protocol v12; recipe
  Catalog uses v5, so result fingerprints distinguish the decoder change.
- `grouping=structural` is a bounded Article factor. It keeps headings with their
  first body block and tables with immediately adjacent captions/footnotes,
  including intervening page furniture. Continuation units carry the latest
  heading, separately from primary ownership. Admission counts this context;
  oversized groups are refused intact. Every passage still has one primary owner.
- `rendering=structured` exposes the canonical block labels and existing cell
  row/column spans. It remains independently selectable from grouping. Neither
  stage rewrites canonical source text, invents table cells or changes evidence IDs.

The grouping adapts [BLOCKIE's linked-block decomposition](https://arxiv.org/html/2505.13535v1)
using existing layout labels. Literal source checking follows
[LMDX Algorithm 2](https://arxiv.org/html/2309.10952v2). These are adaptations,
without BLOCKIE's learned/example-based creator, LMDX coordinate training, or
sampling/voting. Group independence and extraction accuracy still need measurement.
The decoder correction is our response to observed failures, not a paper replication.

## Verification

From `prototypes/parsing_service` in the fix checkout, using the root's locked
Python environment with `PYTHONPATH=src`:

```sh
/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python -m pytest -q -m 'not postgres and not live_model'
```

Result: **1043 passed, 72 skipped, 68 deselected**. New regressions cover source
control characters, malformed/truncated replies, exact quote checks, source tags,
heading/table/qualifier ownership, page furniture, assembled prompt admission and
oversized-group refusal before any model call. No workflow or lifecycle code changed;
this record does not claim a new authenticated HTTP/DBOS or deployed-model test.

Artifacts under `artifacts/extraction-ablation/structure-fixes-20260927/`:

- `verify.py` / `offline-verification.json`: all 33 saved malformed quoted replies
  decode without changing their string values. Six prior reference sources and
  all 88 requests replay exactly; output differences are only clocks, protocol
  version and fingerprint. This does not accept those historical failures into R1
  or establish that their quotes support the claims.
- `preflight.py` / `inventory-preflight.json`: the actual serving tokenizer admits
  all 54 structural inventory units across the 15 Article sources, with a 4096-token
  output reserve under 12288. Largest input: 8190. No response generation. Record
  and verification prompts must still pass their own runtime admission checks.

The full-source structured Harvey refusal remains in the original R3 registration.
The bounded grouping preflight is a different configuration, not a replacement arm.

## Review and remaining work

Bloat audit: automated scan and manual review passed. No dependencies, services,
compatibility wrappers or inference retries were added. The grouping choice and
plain reference path are justified by the user's independently measurable ablations.
The decoder uses the standard library's explicit literal-control extension, not a
second parser or a broad exception-based repair path.

Source labels do not provide a reliable heading hierarchy or arbitrary multi-page
table association. Only the latest heading and adjacent typed qualifiers are used.
Identity collisions, selector omissions and semantic attribution remain measurable
limitations. Fresh accuracy results for these fixes are not available yet. The
registered studies continue separately; final analysis and integration remain open
in the durable plan and OpenSpec change.
