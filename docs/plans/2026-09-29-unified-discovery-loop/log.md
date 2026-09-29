# Loop log

Every row comes from `measure.py` (a run, or `--rescore` of a saved result).

| Tick | Commit | Case | found / false / dup / unresolved | Discovery wall s / model s / cut-offs / tok per place | Whole s | site, fundart right / wrong | Kept? | Why |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | `578ebd08` | `big` | 200 / 51 / 0 / 3 | not recorded / 5,004 / 5 / 50.6 | 5,556 | 196, 200 / 0 | baseline | Spark run of 2026-09-29, rescored |

## Tick 1 (2026-09-29, setup and offline analysis)

Commits: `1901e6a0` (live test, Spark evidence, this folder), `6909892a` (holdout
`holdout.py:holdout`: 160 `Nr. 301 –` entries, 1-4 item nested find lists,
`Landkreis`/`Gemarkung` headings, 10 lines per column so entries cross columns
and pages; `measure.py` takes the spec's `label` key function), `40183878`
(`raw_reply.py`).

**Where the 51 false entries came from** (`big-default.json`, windows in queue
order; every window's context shown in full, none omitted):

| Window | Input tok | Depth | Places | Entries | False | Other |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 2,962 | 2 | 56 | 50 | 0 | |
| 2 | 1,622 | 3 | 51 | 50 | 25 | every `1. Scherben.` a record |
| 3 | 1,656 | 3 | 59 | 51 | 26 | same |
| 4 | 3,033 | 2 | 52 | 50 | 0 | |
| 5 | 1,621 | 3 | 58 | 25 | 0 | all 25 `Mus. Halle` lines `other` (a boundary error `measure.py` does not count) |
| 6 | 1,628 | 3 | 26 | 25 | 0 | |

All false entries are from two of the four depth-3 windows; the other two,
same size and depth, have none. Window size does not explain them: each window
reads the nested list its own way. Smaller windows are not ruled out for G1,
but every extra window is another independent reading.

**One raw reply** (`/out/raw-reply-40.json` on the Spark: first 40 lines of
`big`, 903 in, 691 out, 88.4 s = 7.8 tok/s, 17 places, no false starts):
pretty-printed JSON, ≈ 40 tokens per place: ≈ 12 whitespace (newline +
indent per key and brace; 213 of 691 tokens are pure whitespace), ≈ 12 keys
(`Ġ"` key `":` × 4), ≈ 13 values, 2 braces. `text` was null in every place.
vLLM 0.29.1 has a per-request `structured_outputs.disable_any_whitespace`, but
its xgrammar and guidance backends read only the server's config
(`backend_xgrammar.py:39`), so compact replies must come from the prompt or the
shape; a server flag would be a production change.

**Ranking**

1. H1 fewer tokens per place: ask for one-line JSON and drop `kind` as a key
   (separate `records` / `other` arrays; `_observe` sorts places itself).
   Expected ≈ 40 → ≈ 20 tokens per place.
2. H3 reply-aware windows: today's plan puts all of `big` in one window, so
   there is nothing to run in parallel and the first reply is certain to be
   cut off. Needed before H2 pays.
3. H2 parallel discovery: ≈ 240 places × 20 tokens ≈ 4.8k tokens ≈ 615 s
   sequential; G2's 300 s needs parallel windows too (`--max-num-seqs 4`).
4. H4 keep a cut-off reply's prefix: a safety net once H1 and H3 hold.
5. H5 consistent starts: the G1 lever, but passing a document-derived
   convention needs the user's word (hard rule), and chaining windows
   conflicts with H2. Ask when G1 is the last open gate.

Plan for H1 (after review): single-token keys already, so only whitespace and
whole keys count. Keep one source-ordered array (two arrays make the model scan
twice, and a missed `other` hides in the previous entry unseen by G1): try
positional tuples (`prefixItems`, `["L4",null,"record","40"]`) or an `anyOf`
item; check with one raw call on a 1.6-3k-token window that xgrammar accepts it
and what it costs (count places through `_observe`, not a `places` key). Change
only `discovery.py`; grep for `PROMPT_VERSION` and for TS pins on the discovery
`version` before bumping. One cut-off on the whole-`big` first window is
expected even with H1 (≈ 268 places); log tok/place per window. On holdout rows
note `verbleib:empty` beside `WRONG`.
