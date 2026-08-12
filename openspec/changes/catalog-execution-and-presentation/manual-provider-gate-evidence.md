# Task 5.4 configured-provider smoke

Run date: 2026-08-12. Reproducible command from the worktree:

```powershell
$env:FREE_LIVE_TASK6B='1'
$env:FREE_LIVE_CODEX_MODEL='gpt-5.6-luna'
& '.\prototypes\studio\node_modules\.bin\vitest.CMD' run prototypes/studio/api/task6b.provider.live.test.ts --reporter=verbose
```

Harness: `prototypes/studio/api/task6b.provider.live.test.ts`. It is opt-in,
reads the retained `prototypes/studio/src/assets/document.md` artifact, and
constructs a strict in-memory `parsed_document.v2` with the seven exact H2
headings `Grav 8`, `Grav 13`, `Grav 24`, `Grav 26`, `Grav 28`, `Grav 30`, and
`Grav 31`. Each heading has a stable canonical block ID and each section's
retained non-empty source text is represented by one following canonical block.
The harness injects each configured connection route without changing saved
configuration and emits no source text or model output. The final green gate
run executes exactly four smokes: Article and Catalog through each configured
connection.

## Results

| Provider/model | Strategy | Calls | Retries | Outcome | Complete | Reviewable | Finish | Input/output tokens | Duration |
|---|---|---:|---:|---|---|---|---|---:|---:|
| Ollama / `gemma4:12b` | Article | 2 | 0 | SUCCEEDED | yes | yes | stop | 14,344 / 52 | 5,612 ms |
| Ollama / `gemma4:12b` | Catalog | 15 | 0 | SUCCEEDED | yes | yes | stop | 65,980 / 385 | 30,066 ms |
| Codex CLI / `gpt-5.6-luna` | Article | 8 | 0 | SUCCEEDED | yes | yes | stop | 223,597 / 149 | 36,865 ms |
| Codex CLI / `gpt-5.6-luna` | Catalog | 15 | 0 | SUCCEEDED | yes | yes | stop | 379,712 / 246 | 62,012 ms |

The `Retries` column is derived from durable diagnostics as actual
`modelCalls` minus the scheduled stage calls: Article values (one) plus its
grounding batches, or Catalog document/discovery/record/grounding stage calls.
Every row computed zero extra calls.

### Ollama Article

Values: succeeded, 1 call, `stop`, 7,062/29 tokens, 2,946 ms. Grounding: one
batch for `records[0]`, succeeded, `stop`, 7,282/23 tokens, 2,640 ms. The
visible record was populated as `title = Grav 8`; `records[0].title` was
grounded, with no ungrounded paths or issue codes.

### Ollama Catalog

Stages: document-values not attempted (0 calls); discovery succeeded (1 call,
`stop`, 7,064/68 tokens, 3,108 ms); record-values succeeded (7 calls,
`stop`, 7,936/209 tokens, 10,424 ms); grounding succeeded (7 calls, `stop`,
50,980/108 tokens, 16,523 ms). All seven records succeeded with one call each
and resolved source-order boundaries:
`beretning-grav-8` `[0,2)`, `beretning-grav-13` `[2,4)`,
`beretning-grav-24` `[4,6)`, `beretning-grav-26` `[6,8)`,
`beretning-grav-28` `[8,10)`, `beretning-grav-30` `[10,12)`, and
`beretning-grav-31` `[12,14)`. The seven visible identities were exactly
`Grav 8`, `Grav 13`, `Grav 24`, `Grav 26`, `Grav 28`, `Grav 30`, and `Grav 31`.
Grounding covered `records[0..6].title`; all were grounded with no issue codes.

### Codex CLI Article

Values succeeded in one call with `stop` (27,779/58 tokens, 7,220 ms) and
returned seven visible records beginning with `title = Grav 8`. Grounding
succeeded in seven batches with `stop` (195,818/91 aggregate grounding tokens,
29,634 ms); all seven populated title paths were grounded, with no ungrounded
paths or issue codes. The Article operation therefore retained the one-values-
call contract while the model returned the seven source records.

### Codex CLI Catalog

Discovery succeeded in one call with `stop` (27,783/43 tokens, 4,534 ms).
All seven record calls succeeded (156,111/112 aggregate tokens, 28,265 ms),
with the same seven exact boundaries and identities listed above. Seven
grounding batches succeeded with `stop` (195,818/91 aggregate tokens,
29,207 ms); all seven populated title paths were grounded with no issue codes.
Document values were not requested.

All configured-provider Article and Catalog smokes passed without retries or
saved-config mutation, and the harness emitted no raw source or model output
logs. The grounding implementation reports its existing per-batch
`fallback: true` diagnostic while the model calls themselves all succeeded;
this is not a provider retry or alternate-provider path. Task 5.4 passed.
