# Brainstorm on G2 and the human review queue (gpt-6-astra via omp, 2026-09-09)

Verbatim reply to the second brief; adopted in PROTOCOL.md, "G2 reformulated".

## G2: correct the scope, retain the failures

**Choose B’s denominator correction. Do not treat it as evidence that the candidate passes.** Excluding discovery and document-level values calls is defensible: the policy does not change them. Because this change follows inspection of results, it remains a **post-hoc protocol amendment**, requiring fresh confirmation.

For document/schema pair \(i\), define:

\[
B_i=V_{b,i}+G_{b,i},\qquad C_i=V_{c,i}+G_{c,i}
\]

Count **every attempted call**, including rejected batches and fallback singles. G2 is:

\[
C_i\le0.40B_i
\]

Retain the existing evaluation unit. If G2 was per-pair, do not silently replace it with an aggregate gate.

The successful pairs give:

| Pair | Scoped candidate/baseline |
|---|---:|
| Danish Herredsvejen | 2/6 = 33.3% |
| Danish Hojbakkegaard | 4/18 = 22.2% |
| Danish Hvissinge | 6/24 = 25.0% |
| Danish Katrinesminde | **4/4 = 100%** |
| Beier Herredsvejen | 1/3 = 33.3% |
| Beier Hojbakkegaard | 4/13 = 30.8% |
| Beier Hvissinge | **3/6 = 50.0%** |
| Beier excerpt | 12/58 = 20.7% |

Thus B has **two per-pair failures**, not just the fallback case. The descriptive aggregate is \(36/132=27.3\%\); that cannot override them.

### Structural assumptions and fallback

The expression \(2\lceil n/5\rceil\) assumes both stages process all \(n\) records with compatible grouping. Grounding is claim-dependent; the table explicitly violates that assumption. Beier Hvissinge has zero baseline grounding calls and one candidate grounding call. Beier Herredsvejen has one versus zero. Audit these eligibility differences: fewer claims must not masquerade as batching efficiency.

Reject C as written. A structural diagnostic should instead use:

\[
C_{\mathrm{ideal}}=\lceil n/5\rceil+
\text{number of legal grounding groups for the eligible claims}
\]

Reject A’s rationale: document-level cost is invariant, rounding depends on stage eligibility, and the proposed allowance does not follow from either.

Katrinesminde is a **G2 failure**: the failed batch consumed a call. It also fails G1 **if** G1’s 5% fallback ceiling applies per pair: \(2/2=100\%\). If G1 is pooled, use its prespecified denominator; one local fallback episode does not establish pooled failure. Reliability and efficiency may legitimately fail together.

### Threshold and protocol

Keep 40% only as a declared requirement: **at least 60% fewer policy-sensitive calls**. Full five-record batches suggest 20% under ideal shared eligibility; 40% allows twice that ideal cost. This is a budget rationale, not a universal batching guarantee. Two-record workloads can fail even without fallback.

Record: amendment timing and rationale; old and revised results; unchanged evaluation unit; attempt accounting; eligibility rules; fallback denominator; treatment of failures and zero denominators; quality gates; frozen confirmation workload and repetitions. A thrown run is not an efficiency pass. Report total calls separately; scoped savings are not equivalent to runtime savings.

## Human-review queue

### Mechanical routing

Auto-finalize only when **all** conditions hold:

- Value matches a versioned, schema-approved exact alias or field-safe punctuation normalization.
- Record binding is explicit.
- Linked evidence directly supports that field/value **for that record**.
- No conflicting evidence, OCR ambiguity, inference, or agent disagreement exists.

Otherwise enqueue. Exact value matching alone cannot validate a link. Existing reason strings are routing inputs, not proof that these conditions hold.

Include all listed judgment examples, wrong-record/wrong-passage decisions, unbound records, unsupported decisions, and overlapping-agent disagreements. Missing reasons or unverifiable automatic checks also route to review. Never equate “not independently reviewed” with agreement.

### Sheet and workflow

Merge the 485 and 66 decision logs, retaining provenance privately. Deduplicate identical judgments using schema version, document, record, field, value, and evidence location; preserve every affected output mapping. Include disputed omissions, not only emitted values.

Each randomized, opaque-ID item shows:

- Field definition and applicable schema rule.
- Proposed value and neutral record identity.
- Linked passage highlighted within surrounding context, with page/image access.
- Relevant reference evidence, clearly distinguished from source text.
- Separate choices for **value**, **record binding**, and **evidence link**: supported, unsupported, unresolved.
- Reason code, rationale, and optional corrected value/link.

Hide arm, model, prior decisions, confidence, and gate impact—not archaeological context. No agent suggestions initially: they anchor judgment.

Store human identity, timestamp, rule version, and immutable decision history. Apply shared decisions to both arms; rule changes trigger symmetric rescoring and requeueing. Unresolved items remain human-owned.

## Reporting

**Review-dependent gates: pending human adjudication.** Existing agent scores: provisional diagnostics. Numerically established G2 failures: **failed**, not pending. Overall release: **not approved** while mandatory gates fail or remain pending.
