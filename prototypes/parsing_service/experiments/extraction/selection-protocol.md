# Record-specific value-context selection — registered 2026-09-27

Status: protocol fixed before inspecting comparative selector results. This is a
separate, conditional replay experiment following the frozen R1 live matrix.

Use all 15 Article sources in `20260927-r1-manifest.json`, including failures and
single-unit documents. Use each source's completed `bounded` cell, repeat 0. A
missing or failed bounded cell is unavailable, never silently excluded. No new
human labels or unseen documents are available.

The treatment keeps whole bounded value-extraction units owning inventory support,
the immediately preceding/following canonical passages, and at most one additional
unit with positive schema-term relevance. The lexical score and tie-break are
versioned in `selection.py`. This is a transparent selection hypothesis, not a
replication of hybrid retrieval. Inventory and document-field extraction still
visit all units. Ordinary semantic verification remains unchanged in the product.

The controlled comparison holds upstream inventory and each retained unit's model
reply fixed using R1 captures. Compare all units versus selected units, both with
grounding disabled, using the same code revision. This measures the effect of
omitting value contexts and reconciling the retained candidates, conditional on
one captured inventory and one response per request. It does not estimate fresh
model variability, selector effects on semantic verification, or full end-to-end
latency. Never count replay as an independent repetition or fresh inference.

Before the pair, replay the original bounded method and require exact equality of
requests and stable output against R1 (excluding top-level timing). This validates
that introducing the selector leaves the control intact. Replay accepts only a
monotone subsequence of exact captured requests; any unseen request is an explicit
failure, with no live-generation fallback. Live `/tokenize` calls may reconstruct
partition decisions, but counts must match captured actual calls; persist their
request hashes and counts for subsequent offline replay. Pin source captures,
canonical inputs, schema, selector code and protocol before evaluation.

Replay audit amendment (R2a): a repeated identical request with different captured
replies is ambiguous when earlier calls are omitted, so refuse that source rather
than choose a response. The initial R2 implementation canary is
superseded and excluded from the R2a report. This integrity guard does not change
the selector, outcome definitions or source set.

Primary outcome: paired per-document populated-field accuracy difference on the
six development collagen papers, with the frozen scorer and document bootstrap
(10,000 samples; seed 20260927). Also report empty-gold contradictions, all extra
records/array observations, selected/omitted canonical passages, conflicts, and
call/input/output-token differences. Saved model calls/tokens are counterfactual
under the recorded responses, not measured runtime savings. On nine unannotated
examples report those structural/cost diagnostics without semantic accuracy.

Report all 15 source dispositions and the number with any omitted value unit.
Do not remove single-unit/no-omission cases to enlarge the apparent effect. Any
qualitative review of omissions is descriptive; it is not independent gold and
must not tune this registered selector. No p-values or multiplicity claims.
