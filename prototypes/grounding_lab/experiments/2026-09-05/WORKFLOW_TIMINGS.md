# Observed workflow timing supplement

Generation elapsed plus observed grounding span from final write of claims_unlabelled.json to final write of grounding_meta.json; quote-only uses native generation/mapping elapsed. Post-run file-boundary reconstruction, not an integrated monotonic timer.

The core E timer excludes risk inference and outcome serialization. These archived file timestamps include those operations and loading the prepared unlabeled claims. They exclude earlier input preparation, model loading/warmup, one-time parsing and artificial scheduling gaps between generation and replay. File-clock reconstruction is less precise than a single instrumented request; none of these small-sample tails establishes production latency. Original core timers remain unchanged.

| family | arm | diagnostic | generation s | core phase sum s | workflow span sum s |
|---|---|---|---:|---:|---:|
| beier | baseline/E | False | 946.632 | 2144.313 | 2180.910 |
| bosch | baseline/E | True | 760.305 | 1372.308 | 1412.391 |
| kirsch | baseline/E | False | 476.899 | 722.075 | 736.968 |
| wiermann | baseline/E | False | 512.440 | 670.488 | 690.775 |
| beier | quote/E | True | 2007.475 | 3117.749 | 3153.171 |
| beier | quote/quote-only | True | 2007.475 | 2007.475 | 2007.475 |
| kirsch | quote/E | False | 1051.645 | 1296.962 | 1309.639 |
| kirsch | quote/quote-only | False | 1051.645 | 1051.645 | 1051.645 |

Nearest-rank quantiles of summed workflow spans. Recompute from the archived timestamps in `workflow-timings.json`; cloning files can change filesystem modification times. Failed truncated calls have no usable grounding span and remain in the main report's attempt-duration ledger.

| cohort | arm | n | p50 s | p95 s | p99 s |
|---|---|---:|---:|---:|---:|
| all outputs | baseline/E | 4 | 736.968 | 2180.910 | 2180.910 |
| all outputs | quote/E | 2 | 1309.639 | 3153.171 | 3153.171 |
| all outputs | quote/quote-only | 2 | 1051.645 | 2007.475 | 2007.475 |
| conforming | baseline/E | 3 | 736.968 | 2180.910 | 2180.910 |
| conforming | quote/E | 1 | 1309.639 | 1309.639 | 1309.639 |
| conforming | quote/quote-only | 1 | 1051.645 | 1051.645 | 1051.645 |
| untouched all outputs | baseline/E | 3 | 736.968 | 1412.391 | 1412.391 |
| untouched all outputs | quote/E | 1 | 1309.639 | 1309.639 | 1309.639 |
| untouched all outputs | quote/quote-only | 1 | 1051.645 | 1051.645 | 1051.645 |
| untouched conforming | baseline/E | 2 | 690.775 | 736.968 | 736.968 |
| untouched conforming | quote/E | 1 | 1309.639 | 1309.639 | 1309.639 |
| untouched conforming | quote/quote-only | 1 | 1051.645 | 1051.645 | 1051.645 |
