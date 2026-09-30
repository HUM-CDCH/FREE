# Proposed baseline versus challenger comparison

This proposal does not authorize or schedule held-out execution. The eight
held-out source groups remain unopened. No challenger is selected from this
screening, and no extraction technique is recommended for production.

Complete the twelve registered development groups before selecting a challenger.
Keep A0 as the reference; candidates are only the already-declared A1, A2 and A3.
Resolve ingestion, annotation interpretation and complete usage accounting on
development data before freezing another execution protocol. An interruption
must retain its charged calls and unknown usage; neither a cache replay nor a new
output directory erases its operational cost. Any future change to those gates
needs a dated protocol amendment before the next run, with the old run preserved.

Select a single challenger using development results only. A concrete proposed
selection rule is the highest mean per-source-group **raw exact value F1** among
candidates whose canonicalized complete repeated-record count is at least A0's and whose source-region
failure count is no greater. Break exact ties by lower measured completion-token
cost. If none meets those conditions, keep A0 as the reference and defer the final
comparison. This is a proposed engineering decision rule, not a significance test.
Report canonicalized scores and annotated grounding alongside the selection
metric; do not substitute them silently after seeing the results.

Before opening held-out annotations, register immutable hashes for both
configurations, code, dataset/group manifest, structural schemas, parser/model
artifacts, evaluator and normalization policies. Register the full request and
recovery policy, a sufficient explicit resource allowance, an elapsed-time limit,
and handling of interruption or native-text ingestion failure. Do not enlarge
the present screening's budget. Any additional allowed spending belongs to that
separate, prospectively bounded study.

Run only A0 and the chosen challenger on the same eight held-out source groups,
once, in a fixed randomized paired order. Keep related source variants in their
registered groups. Use one model/server and matching decoding/recovery settings;
record background load and separate server time from orchestration time. Preserve
failed cells and missed records in the registered population. An incomplete
comparison is reported as incomplete, not restricted to a favorable subset.

The final report should include:

- Per-group and pooled raw/canonical precision, recall and F1, with every
  denominator; mean paired per-group differences are the primary comparison.
- Raw/canonical whole-record completeness, repeated-record misses, extras and
  duplicates, cross-page completeness, and parser/source-region failures.
- Raw passage selections, refined literal locations, and annotated evidence
  metrics separately. With the current native-line adapter, only coarse page
  grounding is available; semantic support and exact geometric localization
  remain unavailable rather than receiving invented labels.
- Completed and failed fresh requests, token usage and any unknown usage;
  separate cache replays and original cost. Include wall time and request
  hashes, without committing source PDFs or source-text excerpts.

Show the eight paired group differences explicitly. Any resampling interval is
descriptive for this small, metadata-selected population; do not claim independent
random sampling of a deployment population or formal LTT/CRC certification.
Retain the custom-harness label: structural schema sanitization, native text input
and leaf/record scoring differ from the official ExtractBench protocol, so these
numbers do not establish leaderboard comparability.

Verifier flagging remains a separate error-detection problem. A later verifier
study must report false positives, false negatives and review workload on fixed
extractions, rather than removing flagged values to improve extraction F1. The
present A0–A3 screen uses no verifier or confidence model. The separate authorized
FREE-catalogue human-gold plan is in the [methods audit](../2026-09-30-extraction-harness-methods.md).
