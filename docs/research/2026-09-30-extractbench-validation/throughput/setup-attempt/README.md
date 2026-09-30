# Discarded setup attempt

2026-09-30. This attempt is preserved for audit and excluded from the final
three-condition comparison.

The direct request builder initially retained `x-free-type` annotations in the
JSON schema. The harness's `ResearchChat` strips those annotations with `_plain`
before sending. The first harness attempt completed its HTTP request, then the
request-equality assertion detected the difference. No measured harness result
was accepted. The adapter's production behavior was unchanged.

Eight direct calls completed (one warmup plus three measured for each of
existing and clean servers): 4,240 prompt tokens and 3,432 generated tokens.
One additional synthetic harness HTTP call completed before the assertion;
its response/usage was not saved. Its input was the same 530-token prompt and
its output was capped at 512 tokens. No study or benchmark dataset was used.

The automatic cleanup removed the experimental container and restarted every
stopped original container. Its final inspect check failed because an unrelated
temporary test container, present in the initial all-container snapshot, had
been removed by another process. That container was never stopped or otherwise
modified by the benchmark. `restoration.json` independently verifies the
original stable deployment's IDs, images, arguments, mounts, restart policies
and restored running state. The inspect error's unfiltered partial stdout was
removed from `run.log` because Docker environment fields can contain credentials.

The corrected benchmark uses `_plain` for direct requests and first captures
the full runner's payload offline, before sending any inference request. The
HTTP-boundary equality assertion now executes **before** the real POST. Its
deployment snapshot includes only known original containers. The complete
comparison is rerun with one warmup and three measured calls per condition;
these setup measurements are not pooled into it.
