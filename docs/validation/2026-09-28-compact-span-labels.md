# Compact span labels: admission check

Status: implemented at `684723f7`, tokenizer check and exact offline replay complete.
The full inference matrix remains deferred. This is a prompt-admission experiment,
not another fresh extraction or a semantic-quality evaluation.

## Change and result

Span grounding now offers short labels such as `E1`. The server resolves them to
the same canonical span IDs, exact text, code-point offsets, table cells and
geometry. Labels are assigned before claim batching and cell eligibility filtering.
Table row/header context, source segmentation, attestation rules and claim policy
are unchanged. `span_grounding_version` is 2; old span fingerprints no longer match.
Quoted and semantic modes retain their prior requests and fingerprints.

The small change removes all budget refusals on Hvissinge and Harvey in the
scripted span-only check. Age improves partly; Hamburg still refuses three units.

| Source | Eligible claim–unit pairs | Refused v1 → v2 | Planned calls v1 → v2 | Input tokens v1 → v2 |
|---|---:|---:|---:|---:|
| Hvissinge | 285 | 285 → 0 | 0 → 32 | 0 → 324,746 |
| Harvey | 1,296 | 472 → 0 | 203 → 128 | 2,017,998 → 1,227,070 |
| Age | 470 | 376 → 328 | 5 → 11 | 29,677 → 89,480 |
| Hamburg | 460 | 345 → 345 | 6 → 6 | 33,240 → 31,212 |
| Zelechowska | 156 | 0 → 0 | 16 → 10 | 141,942 → 77,526 |

The combined schema-policy/unresolved method has the following admission results:

| Source | Eligible claim–unit pairs | Refused v1 → v2 | Planned calls v1 → v2 | Input tokens v1 → v2 |
|---|---:|---:|---:|---:|
| Hvissinge | 285 | 285 → 0 | 0 → 32 | 0 → 324,746 |
| Harvey | 672 | 265 → 0 | 132 → 92 | 1,314,438 → 888,254 |
| Age | 470 | 376 → 328 | 5 → 11 | 29,677 → 89,480 |
| Hamburg | 460 | 345 → 345 | 6 → 6 | 33,240 → 31,212 |
| Zelechowska | 84 | 0 → 0 | 10 → 4 | 91,753 → 30,988 |

Every eligible pair reconciles to an attempted or explicitly refused decision.
Zero input tokens for old Hvissinge mean no requests were admitted, not efficient
verification. Age's higher total cost reflects newly admitted work. All replies in
this check are scripted NONE, so unresolved scheduling never stops early. These
numbers must not be substituted for the measured fresh pilot's costs or links.

## What consumes the budget

Correction to the initial diagnosis: this OpenAI-compatible Qwen adapter does not
render reply-schema enums into the model prompt. Repeated long enum values inflate
the structured request, but do not consume its measured prompt tokens. Shortening
the selectable labels in the evidence text saves the actual input tokens.

All 3,138 revised admission probes match an original probe after removing only
transport-label spelling and the corresponding instruction wording. Claim text,
candidate descriptions, table context and eligible choices are identical. Savings
range from 295 to 1,165 input tokens per matched probe. Serialized schema bytes
across those probes fall from 26,608,273 to 13,377,973 (49.7%); this is a separate
payload-size measurement, not token savings or measured decoding acceleration.

The check used the existing Qwen/Qwen3.8-27B-FP8 tokenizer at loopback port 18012,
served context 32,768 and unchanged study context 12,288 with 2,048 output tokens
reserved. Five unchanged quoted requests retain their original token counts.
Those controls confirm sampled count equivalence, not a cryptographic model or
tokenizer revision pin. No generation endpoint was permitted.

## Scope and verification

Four sources with the largest span-only refusal counts plus the completed pilot
source were selected before probing. Harvey and Zelechowska are development gold;
the other three sources are unannotated examples. No gold values were used to
construct the revised requests. There is no held-out evaluation or independent
semantic annotation in this check.

The frozen original R5 manifest, source inputs, upstream records, probes and six
fresh pilot results remain unchanged. Revised admission artifacts live separately
in `artifacts/extraction-ablation/compact-span-labels-20260928/` under the primary
checkout. Its manifest retains the original method definitions and names the
separate code revision; `config.json` selects exactly ten tokenizer-only cells.
These are not ten additional completed inference cells.

Validation:

- 304 extraction/grounding tests pass; 18 process/database/live tests deselected.
  No database lifecycle or live provider inference test was run for this change.
- Tests retain exact controls, repeated occurrences, cell/parent geometry,
  attribution rejection, filtered-cell labels across batch splits and span-only
  fingerprint invalidation. Reporting tests still reject fabricated proof locations.
- Direct old/new request comparison passes for quoted and semantic modes on
  control-character, table and long-prose fixtures. Span candidate descriptions
  and shared context remain exact.
- Live tokenizer check: ten cells, 3,138 saved probes plus one calibration call,
  zero fresh model calls. Five additional unchanged controls plus their calibration
  use six tokenizer calls.
- Offline replay matches all ten reports exactly, verifies all saved probe pins,
  and makes zero HTTP/model/tokenizer calls. Full input/code validation passes
  before and after the admission check.
- Manual bloat audit: the runtime change removes a labeling branch and adds no
  dependency, option, compatibility path or fallback. OpenSpec validation passes.

Focused test command from `prototypes/parsing_service`:

```sh
PYTHONPATH=src:. PYTHONDONTWRITEBYTECODE=1 \
  /home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python \
  -m pytest tests/test_extract*.py tests/test_grounding*.py \
  -m 'not postgres and not slow and not live_model' -q
```

For another offline replay, start in the artifact directory's `frozen/` and choose
a new receipt path (the verifier refuses to replace an existing receipt):

```sh
PYTHONPATH=src:. PYTHONDONTWRITEBYTECODE=1 \
  /home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python \
  ../verify.py /tmp/compact-span-replay-new.json
```

| Artifact | SHA-256 |
|---|---|
| `manifest.json` | `f35afe17350c66359924b5415ed2ce5337121ec8df832f365553e116b27e0f93` |
| `code.zip` | `7640cec765aa949c14fd51d28978de623f02101c2b627b5ec34330d88f78317a` |
| `summary.json` | `e923936c46fd52a1b958efaf4d1251cdb058328f19aad318b0883673a3f429fd` |
| `preflight.json` | `c362b7766abc2011e66543502e51e1754155e079cc9aea4ef93017a7db47b6d8` |
| `probe-pins.json` | `8836c73d24314f8983d1381ca1125edf3b9a23d9f6b84060324265d65a2c98de` |
| `paired-probes.json` | `0d3ee5673d841de30665e6d808bdc3db87d1eab940f2fdc3428436261d7f15f8` |
| `verify.py` | `4b61b82dc74f46ddf2f40a3a24bfb924e4e2c51776b50077d4d4bbaa1ea6bbd6` |

## Remaining gates

The prompt change can alter model choices even though every offered source choice
is preserved. Fresh grounding quality, output tokens and wall time for version 2
are unmeasured. The independent pilot audit requested for Opus is complementary;
it reviews version 1 evidence and cannot establish version 2 equivalence.

Before a broader experiment, diagnose the remaining Age/Hamburg singleton
overflows and retain their refused comparisons in every denominator. A small
fresh comparison should then include a previously refused source and actual
canonical tables, with the same upstream records and a separate revision.
Do not auto-resume the full matrix or reuse the old R5 launcher against retained
pilot cells. The original full study and its final report remain unfinished.

Implementation plan: `openspec/changes/compact-span-labels/`.
