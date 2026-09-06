# Execution notes — 2026-09-05

- Three warmed rotated repetitions of each pruning policy completed. See
  `pruning/SUMMARY.md`; the negative result retains E.
- The development quote pilot first failed after 307.106 seconds at Node
  fetch's response-header timeout. Its attempt is retained at
  `pilot/conrad-quote`. The native-HTTP retry completed at
  `pilot/conrad-quote-02`. The baseline pilot is `pilot/conrad-baseline`.
- Original PDFs and parser code were frozen before extraction; each request
  records its final parsed-document and canonical-source hashes. Parsing was
  allowed to finish before source-specific extraction began.
- The original serial parser coordinator reached Kirsch while a separate
  Kirsch parse was active. Both exited successfully. The shared `parse.log`
  contains interleaved final output; it is retained rather than cleaned up.
  The final parsed JSON is valid. Regenerated anchors are byte-identical to
  the first completed inventory retained as `anchors-first-parse.json`:
  SHA-256 `5f9f15b67d5fe31fac8bbd8f3bc132dcfe2fe3e78aa8ab5ac59ebfbcea629036`.
  This verification occurred before either Kirsch extraction request.
- An automatic approval review rejected stopping the parsing coordinator
  and Bosch processes because it could discard work beyond Bosch. No process
  was stopped; all parser attempts completed. This was an operational review
  rejection, not a failed extraction.
- Paired holdout calls run sequentially on Spark. No production integration,
  automatic acceptance, push or merge is performed.
- Beier's quote arm finished normally but emitted 25 records instead of the
  requested 20. Its original metadata remains failed. The separate diagnostic
  exporter validates and preserves all typed emissions and quote mappings;
  no records are trimmed. Every diagnostic value is included in blind
  labeling, while conforming-run summaries exclude this failed attempt.
- Beier's blind packet was prepared while frozen E scoring continued. It has
  1,116 anonymized claims. The background coordinator's later duplicate
  `prepare` is expected to be refused by the existing-packet guard; the first
  packet and claim IDs must be preserved. No labeler had seen an earlier
  packet, and no packet was rebuilt or reshuffled.
- All eight holdout generation calls finished. Beier quote (25 records) and
  Bosch baseline (21 records) failed the record limit; all their complete typed
  emissions were recovered in diagnostic-only sidecars. Wiermann quote and
  Bosch quote exhausted the 32,768-token output budget and remain incomplete;
  their raw responses are retained without salvaging a JSON prefix. There were
  four runner-valid completions and four failures. No holdout request was retried.
- Every usable output was packaged once for blind labeling. Frozen E replay
  reads only `claims_unlabelled.json`, so labeling and GPU scoring may proceed
  concurrently without sharing gold evidence with candidate selection.
- All six E replays and all four labeling/adjudication rounds completed. The
  completion audit is `validation.json`; all 2,709 populated values from
  usable typed outputs are accounted for. Five blind judgments remain unresolved.
- Post-run timing inspection found that core E timers exclude risk inference
  and outcome-file serialization. `workflow-timings.json` archives the original
  file-boundary timestamps and hashes; `WORKFLOW_TIMINGS.md` reports broader
  observed spans alongside unchanged core timings. This reconstruction is
  disclosed rather than presented as a single integrated monotonic timer.
