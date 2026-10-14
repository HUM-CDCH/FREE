# FREE PR #267 follow-up review

Reviewed follow-up commit: `632206f47bf843893ad4801d4b11665e30446a0f`.
Baseline: `30a6448f9a3d221e38dd454a08a7d81ff3e68131`.

The `resolution.py` snapshots have been verified with Git blob SHA-1:
- Follow-up: `7dece74fe49c66253e3e01f5f15de41ffcc84908`.
- Baseline in `pr267-review/resolution.py`: `e89bb663ca8a313636899afe0aa3ae4efce125d7`.

## Scope

These are isolated review probes. They execute the actual resolver after replacing
external `kei_exp` imports with fixtures, a controlled token counter, and a scripted
model-call boundary. They do not run the repository's pytest suite, HTTP provider
implementation, full extraction pipeline, database, browser, or a live model.
Successful scripted responses are validated against their generated JSON schema.
The source snapshots are unmodified; external import substitution happens in memory.

## Run

Dependencies: Python, jsonschema, requests; pytest for the desired regressions.

```
python probes.py
python probes.py --baseline
python -m pytest -q test_numeric_tokens.py
```

The first command passes all ten checks of the reported fixes at 632206f4. The
same checks pass four and fail six at 30a6448f. The last command intentionally
has five FAILURES at 632206f4: it specifies the desired numeric-token behavior
for a remaining snippet-selection defect, rather than asserting buggy behavior.

## Remaining defect

`resolution.py:100-104` still matches positive `10` inside `-10`, Unicode-minus
`−10`, exponent `1e-10`, and leading-dot decimal `.10`. Three such false hits can
consume all three displayed snippets and exclude a later genuine `10` occurrence.
This is a deterministic prompt-input defect. No live-model misclassification
rate was measured.

## Release gate (static review, not exercised here)

The current `article.py` production caller does not pass `resolve_parts`, while
`document_root` defaults it to True. `ArticleOptions` has no resolution opt-in.
The annotated comparison acknowledged as outstanding therefore still needs to
block activation, or resolution needs an explicit default-off opt-in.

`results.txt` and `baseline-results.txt` record the isolated probes.
`numeric-regressions.txt` records the five deliberately failing desired regressions.
