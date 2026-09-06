# Bounded extraction: development first

This follows the completed frozen 2026-09-05 experiment. Conrad is existing
development data. No claim labels select source regions or records. The
independent source-only scope inventory is an evaluation check, not runner input.
No additional family is opened until a candidate passes development scope,
completion and evidence checks. Mathias is only a candidate pending provenance
inventory; the prior four families can no longer be called untouched.

The runner imports existing canonical-source slicing and frozen quote helpers.
It discovers individual records over the full parsed source, renders complete
overlapping source regions, extracts metadata separately, and requests two
records per batch. Both arms share that discovered manifest and original typed
schema. Routing IDs must return exactly once in requested order. Missing values
remain null. Incomplete generation, incorrect shape, repeated identities, and
scope errors are failures. There is no automatic retry; each development retry
uses a new directory. No prefix salvage or silent source/output truncation.

Spark uses the same pinned qwen3.8:27b digest/runtime, temperature 0, seed 0,
thinking disabled, context 262144, output budget 8192 per call. Every request
and raw response is retained. Whole workflow and each arm have monotonic timers;
generation, mapping, model loading/warmup, E replay, risk and artifact writing
are included. Discovery is shared and separately measured. Policy timelines
must disclose shared work; full E replay is not a measured selective-fallback
implementation. Physical calls/tokens must be counted once. Interrupted calls
retain unknown usage rather than zero. The final timer bookkeeping write is
outside its own measured interval.

Compare baseline values with E, quote values with quote-only, and quote values
with quote/E candidate fallback. Also retain full E replay on quote values.
Fallback applies to every quote status other than uniquely mapped, retains the
status, and proposes E's best candidate without automatic acceptance. Exact
quote occurrence establishes location only. Every result requires review.
Existing frozen development risk parameters are reused without fitting; quote
status priority is ordinal and must not be advertised as a probability.

Promotion requires all first-20 identities and complete supporting regions to
agree with independent source review, both arms to finish, and blinded value
and evidence evaluation to justify any quality/latency tradeoff. Two independent
labelers and a fresh adjudicator are used when comparison outputs are available.
Report semantic support, correct/wrong/missing evidence, unsupported proposals,
review depths 1/3/5 and explicit failures. One source cannot validate calibration
or production latency. Preserve failed attempts, including failed discovery.

Run from the lab:

```powershell
node --experimental-strip-types scripts/bounded-extraction.mts --source final_dataset_3/conrad-2011-bbc-graves-de --output experiments/2026-09-05-bounded/NEW-ATTEMPT
```

Initial validation: 96 Python and 11 Node tests pass; the previous experiment's
freeze verification passes. No production code, push or merge is included.

Completed validation: 98 Python and 12 Node checks pass; the previous freeze
remains unchanged. See RESULTS.md for the finished experiment and limitations.
