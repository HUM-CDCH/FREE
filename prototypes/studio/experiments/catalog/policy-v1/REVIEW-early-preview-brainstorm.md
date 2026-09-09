# Brainstorm on showing the extraction before grounding (gpt-6-astra via omp, 2026-09-09)

## Brief

# Brainstorm: show the extraction to the reviewer before grounding

Same system as the previous briefs (FREE Catalog mode; policy v1 default; cite-and-verify measured and left off by default). Answer in under 1,000 words: say whether the idea is sound, design it, name the risks to the review model, and specify what to measure. Disagree where warranted.

## The user's question

"I was thinking about showing the extraction to the user before the grounding. Is it possible? Do we have the evidence linking before the grounding step?"

## Facts about the pipeline as it is

- Phases: discovery (per page chunk) -> values (batched per five records) -> a persisted values checkpoint -> grounding (grouped per five records) -> terminal result. The checkpoint holds `result` (all records with values), `diagnostics` (every record's boundary: start and end block of its slice, page numbers), `modelAttribution`, `complete`. The job worker writes it to Postgres before grounding starts; a worker that dies resumes at grounding from it.
- On the full Beier catalogue: discovery 9.5 min, values 51 min, grounding 32 min (84 calls). The values checkpoint exists at minute 60 of 92.
- Studio's contract: an attempt is `reviewable` only when it carries evidence links. A review decision is bound to a link: it names the value's result path, the linked anchor id, and the anchor's occurrence ids the reviewer looked at; the store validates that every decision's anchor equals the extraction's link for that path. So today there is no review without grounding, by construction.
- What exists for a value before the grounder runs: its record slice (certain by construction: the values call read only that slice), the slice's pages and block boxes, and whatever code can compute: bounded lexical hits of the value across the slice's blocks (`verbatim`, `lexicalHits`), and, with `policy.citations`, the block the extractor cited, verified in code when the value occurs in it. Those code-made links were never wrong on any measured document; their coverage is 86% of values on the catalogue and 26 to 80% on Danish prose reports.
- What only the grounder gives: the block-level link for the remaining values, and the NONE verdict that marks a value as stated nowhere. On the Danish reports NONE and wrong-link detection is where 10 to 35% of populated values were caught.
- Reviewer-facing doubt flags today: `verbatim` false, `lexicalHits` above one, ungrounded paths. "To check" in Studio counts those. Nothing is auto-accepted.

## Options I see

A. Two-stage result. The values checkpoint becomes visible as a "values ready, evidence pending" state: the reviewer sees records and values with slice-level evidence (the record's pages and boxes, highlighted) and the code-made links where they exist; grounding continues in the background and upgrades links in place. Review decisions stay bound to block-level links, so nothing can be approved until its link arrives, but the reviewer can read, navigate, and flag.

B. Reviewer-driven grounding. As A, but grounding is not run for everything: it runs per record when the reviewer opens it (about 20 s for a five-record group on Spark), or in a background queue ordered by the reviewer's navigation; records never opened are grounded later or never. Calls fall with the fraction actually reviewed; the "To check" count and NONE verdicts arrive incrementally.

C. Slice-level evidence as a first-class link. Allow a decision to be bound to the record slice (its anchors as a set) rather than a single block, so a reviewer can approve a value whose passage they found themselves inside the highlighted slice; the grounder's link, when it comes, is a refinement. This changes the review data model.

D. Code links immediately, grounder as audit. Persist verified citations and unique lexical hits at the checkpoint as provisional links with `linkedBy` provenance; the grounder later audits them and grounds the rest; a link the grounder contradicts is flagged, not silently replaced.

## Questions

1. Is showing values before grounding sound, given that the grounder is also the check that catches unsupported values? What must the reviewer be told, and what must they be unable to do, before a value is grounded?
2. Which option, and what is the minimal change to the checkpoint, the attempt contract and the review model? Is slice-level evidence acceptable as a provisional link, or must every decision stay bound to a block?
3. Risks: a reviewer approves a value on slice evidence and the grounder later returns NONE for it; links change under an open review; two sources of truth for "reviewable"; the incremental "To check" count; the job worker's resume semantics.
4. If grounding becomes reviewer-driven (B), what is the expected saving on a 420-entry catalogue where a researcher reviews, say, a third of the entries, and what does it cost in latency per opened record? Is a background queue ordered by navigation better than on-demand?
5. What to measure before building the UI: time to first visible result, share of values with code-made links at the checkpoint, and the rate at which the grounder later contradicts a value the reviewer had already read. What gate would you set?


## Reply (verbatim)

## Recommendation

**Show extraction early; do not represent it as verified early.** Use **A with D’s persisted code-link provenance**, leaving full background grounding enabled. Defer B and reject C for the initial change.

The checkpoint already supports a useful preview: record-local pages and boxes, plus code-made links covering 86% of catalogue values. It does **not** establish that every populated value is supported. The Danish results make that distinction material: grounding catches problems in 10–35% of populated values.

Keep policy v1 and cite-and-verify defaults unchanged. Early visibility is not evidence for enabling citations or removing grounding.

## 1. What the reviewer gets

At the checkpoint, show:

> **Values extracted; evidence checking incomplete. Values may be unsupported or linked incorrectly.**

Use distinct value states:

- **Evidence pending:** show the record slice as navigation context, not as proof.
- **Code-linked, check pending:** show the block, occurrence highlights and provenance.
- **Grounding complete:** show the resulting link or explicit unsupported/NONE outcome.

Permit reading, navigation and provisional flags immediately. **Do not permit approval or other evidence-bound decisions until that record’s grounding completes.** A lexical occurrence is not necessarily support for the field’s meaning; zero observed code-link errors is encouraging, not a guarantee.

Record-level completion is a conservative boundary: one value receiving a link must not accidentally unlock decisions on its pending neighbours. Nothing becomes auto-accepted.

On Beier, this exposes all extracted values at approximately minute **60 rather than 92**: 32 minutes earlier, roughly 35% less waiting for visibility. It does not accelerate extraction or reduce grounding work.

## 2. Minimal contract and data changes

**Checkpoint:** retain the immutable values result and diagnostics; add persisted code-made links, occurrence IDs and `linkedBy` provenance. Associate them with the extraction revision. They must use the same anchor identity scheme as final grounding.

**Attempt:** add a preview-visible state distinct from `reviewable`. Track grounding state per record, distinguishing pending, completed-with-links, completed-with-NONE and failed. Derive decision eligibility centrally from this persisted state; enforce it server-side. The UI must not infer reviewability merely from link presence.

**Review model:** keep block-bound decisions. A slice is acceptable **preview context**, not a provisional approval target. Making it an approval target changes what “reviewed evidence” means; later narrowing the slice to a block is not necessarily a harmless refinement.

Provisional reading flags belong outside the evidence-bound decision store and must never turn into approvals automatically.

Persist grounding outcomes separately from the values checkpoint. Promote them at a record completion boundary. Preserve conflicting code links for inspection rather than silently overwriting them. Reuse current grounding work; do not add a second audit pass merely for this UI.

## 3. Review-model risks and controls

- **Reviewer believes a value, then grounding returns NONE:** early decisions are blocked, but cognitive anchoring remains. Mark the changed value visibly, invalidate any “already read” indicator and notify the reviewer. NONE stays an explicit outcome, not an absent link.
- **Evidence changes under an open review:** bind submissions to the evidence revision as well as existing path/anchor/occurrence identity. Reject stale submissions. Do not switch the displayed evidence beneath an open approval action.
- **Two definitions of reviewable:** one server-owned eligibility rule, reused by APIs and Studio. Preview visibility grants no decision capability.
- **Incremental “To check”:** display separate counts for **known issues** and **checks pending**, with a stable denominator. “0 issues; 300 pending” must not look complete. Known-issue counts can rise.
- **Resume semantics:** checkpoint `complete` continues to mean values complete, not job complete. Persist record outcomes and progress consistently; retries must be idempotent and tied to the same extraction revision. A restart must neither lose completed outcomes nor expose partially written evidence as final.

## 4. Reviewer-driven grounding economics

For 420 entries, reviewing one third means 140 entries.

**With dense five-record batches:**

- Full run: 84 groups.
- Reviewed subset: 28 groups.
- Potential reduction: 56 calls, about **67%**.
- Scaling the measured 32-minute grounding phase: approximately **10.7 minutes**, saving **21.3 minutes**.

That estimate requires skipped entries to remain ungrounded and comparable batch cost. Grounding everything later saves no total work.

Existing group boundaries matter. If the 140 entries are scattered randomly across fixed five-record groups, approximately

\[
1-(2/3)^5 \approx 87\%
\]

of groups are touched. Savings shrink to roughly **13%**, not 67%. Conversely, grounding individual opens without batching can increase call count.

A cold open waits about **20 seconds for its group**, plus queueing and persistence—not four seconds per record.

**Prefer navigation-prioritized background grounding first.** Prefetch nearby records and promote opened records. This improves responsiveness while preserving eventual complete coverage. Strict demand-only operation is a separate completeness-versus-cost decision.

## 5. Measurements and gates

Before building the UI, replay representative catalogue and Danish checkpoints through the proposed state transitions and existing grounding:

- Checkpoint availability, preview delivery latency, and time to first decision-eligible record.
- Code-link coverage by document, field and provenance—not only aggregate coverage.
- Later NONE, wrong-link and occurrence changes, separating code-linked from slice-only values.
- Grounding failures, retries and restart correctness.
- Simulated navigation: touched groups, actual calls and cold-open latency.

Actual **read-before-contradiction** rates require reviewer exposure. A checkpoint replay measures potential exposure, not what someone read.

**Initial gate:** preview cannot authorize decisions; stale submissions fail; crash/retry scenarios preserve evidence identity and eligibility; every tested contradiction remains visible. Coverage is a usefulness measure, not a safety threshold.

Then run a small reviewer pilot measuring premature confidence, missed updates, correction rate and review time. Do not enable B or early code-link approval solely because average coverage is high; require document-stratified evidence that unsupported-value detection and reviewer outcomes are not degraded.
