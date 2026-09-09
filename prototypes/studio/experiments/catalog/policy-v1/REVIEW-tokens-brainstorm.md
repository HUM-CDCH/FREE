# Brainstorm on token and round-trip reduction after policy v1 (gpt-6-astra via omp, 2026-09-09)

## Brief

# Brainstorm: cutting tokens and round trips in FREE Catalog mode after policy v1

Answer in under 900 words. Rank levers by expected saving against risk to value and evidence quality, name the useless round trips, and propose the cheapest experiment and gate for each lever you would keep. Disagree where warranted; add levers I missed.

## Where the tokens go now

Acceptance run, full Beier catalogue (420 entries, 45 pages, 3,093 blocks), Schema Revision 6 (six fields: catalogue_label, locality_and_findspot, fa_code, find_description as a verbatim quote of up to 400 characters, museum_inventory list, literature_references list), Ollama qwen3.8:27b Q4 on the Spark server, policy v1 (5 records per values call, 5 records per grounding call, field-aware claims), 213 calls, 92 minutes:

| phase | calls | input tokens (per call) | output tokens (per call) | time | s per call | output tok/s |
|---|---:|---:|---:|---:|---:|---:|
| discovery | 45 | 332,439 (7,387) | 4,421 (98) | 9.5 min | 12.6 | 7.8 |
| values | 84 | 213,171 (2,537) | 108,826 (1,295) | 50.8 min | 36.3 | 35.7 |
| grounding | 84 | 379,068 (4,512) | 54,063 (643) | 31.6 min | 22.6 | 28.5 |
| total | 213 | 924,678 | 167,310 | 92 min | | |

The per-record production run made 885 calls in 106 minutes with 1,093,497 input and 172,809 output tokens. So batching cut calls 4.2 times but time only 13%: values and grounding are output-bound (35 and 28 output tokens per second); discovery is prefill-bound (7.4k tokens in, 98 out, 12.6 s).

## Anatomy of a call

- Prompt assembly (general route): a fixed system instruction; a user message whose text starts with the schema template JSON and the caller instruction, then `SOURCE DOCUMENT:` plus the document markdown, then a trailer. Static text first, variable document last, for values and discovery. `reasoning: 'none'`. Structured JSON output through Ollama's native format; the JSON schema costs no prompt tokens.
- Discovery: one call per page chunk, about 11.6k characters of markdown plus a 3.5k-character instruction (record description and rules), returns `{starts: [...], end}` per chunk. Every chunk of the document is read once at 7.4k tokens.
- Values: a batch of five record slices under `### Record R<n>` headings (about 1.9k characters per record), template with the six fields, 1.1k-character instruction (the record description). Output is JSON with a routing key and all six field names repeated per record; `find_description` quotes carry most of it (about 180 characters average).
- Grounding: the same five record slices again, now as `[E<n>] text` lines under `### Canonical Evidence`, plus a 3.4k-character instruction with the claims listed as `[C<k>] records[i].field: "value"` and a `### Fields` block with field descriptions, plus a template mapping each claim label to a string. Output is `{"links": {"C1": "E181", ...}}`, about 15 tokens per claim; on this run 3,481 claims.

Earlier measurements you may recall: on the 29-entry Beier excerpt with the seven-field schema, your "Luna batches of 5 · joint evidence" arm (values and evidence labels in one call) gave 9 calls, 201–202/203 values, 160–163/164 supported, precision 98.2–99.4%, against the separate-grounding policy's 203/164/100%. Lexical auto-linking of single-hit claims (`policy-v1` arm) linked the wrong passage on two trap values and set off a NONE cascade in the remaining grouped claims (156/164). Retrieval pre-filters lost supported links. The grounding lab found the LLM grounder with field name plus siblings the best scorer and no non-LLM replacement.

## Levers I see, with my estimates

A. Grounding re-reads what values just read. The 379k grounding input tokens are the record slices a second time plus the claims. Joint extraction (value plus evidence label in one call) removes 84 calls and most of those tokens; the earlier measurement says it costs one to four supported fields per 164 and about one point of precision, and it removes the independent check that catches an unsupported value with NONE. Is there a middle path: keep grounding separate but send only the anchors that lexically contain the claim (the hit set) for claims with one or more hits, and the full slice only for zero-hit claims?

B. Output format. Grounding output at 15 tokens per claim could be `C1:E181` lines at about 6. Values output repeats six field names per record; `find_description` is a 400-character verbatim quote, which the model must generate token by token although the text exists in the document. Returning an anchor label plus a character offset range for verbatim-string fields, and materialising the text from the document, would replace about 100 output tokens per value with about 10, guarantee verbatim, and make the value self-grounding. The grounding lab rejected a "quote/E hybrid" earlier; I do not know whether that was because models produce wrong offsets. What is your view?

C. Lexical pre-links, restricted. Skip the model for claims whose value is a bounded token of exactly one candidate anchor AND is long enough not to be a code (say 20 characters or more, or a verbatim-string field). The two traps were short values. This reduces claims sent, not calls, unless a whole group empties.

D. Batch and group size. 5 to 8 or 10 halves the calls again; tokens hardly change; identity errors were seen once at size 2 (R1 returned twice). Is call count worth anything once time is output-bound?

E. Discovery. 36% of input tokens and 10% of time, prefill-bound. Options: a smaller model for boundary detection; a heuristic first pass (numbered headings) with the LLM confirming only ambiguous chunks; sending block heads instead of full blocks. Rules alone found zero records on Danish prose reports. Discovery dominates short reports (20 of 25 calls), so any saving here matters more for them than for Beier.

F. Prefix caching. The static prefix (system plus template plus instruction, about 1.5k tokens) is re-prefilled 213 times. Ollama reuses the KV cache for a shared prompt prefix on the same loaded model. Values and discovery already put the static text first; grounding puts the variable claims before the evidence. Reordering grounding to put evidence first and claims last would let the prefix cache cover the fixed preamble only; is it worth it?

G. Instruction size. The record description is repeated in every call of every phase (1.1k to 3.5k characters). Could a shorter per-phase instruction do, or is the description what makes the model accurate?

H. Anything structural: could discovery and values be one pass over page chunks (extract records per chunk without a separate discovery), given that the earlier chunk-joint arms existed in your experiments? What did they lose?

## Questions

1. Which of A–H are real and which are noise at this scale? Give expected token and time savings per lever on this run's numbers.
2. Which round trips are useless in the strict sense: same information sent twice with no independent check gained?
3. For each lever you keep: the smallest experiment on the 29-entry excerpt with its exact reference (evaluate.py: 203 values, 164 supported fields, precision) and the gate it must pass.
4. What must not be traded: the reviewer-facing evidence links, abstention (NONE), and the doubt flags (verbatim, lexicalHits). Say if any lever compromises them.


## Reply (verbatim)

## Ranking and savings

**Keep compact output, shorter instructions, cache-aware ordering, and discovery experiments. Investigate quote spans. Do not promote joint extraction or lexical pre-links on current evidence.**

One correction: reported “output tok/s” equals output tokens divided by **whole-call time**; it does not establish decode-bound execution. Measure prompt-evaluation and generation durations separately. Time estimates below are conditional forecasts, not measured savings; do not add overlapping levers.

### 1. B — Compact grounding output: highest-confidence saving

At your estimate, 15 → 6 tokens across 3,481 claims saves **31–33k output tokens**, about **19 minutes at the reported effective rate**. Actual savings require generation timing.

Prefer native structured JSON with compact claim/evidence identifiers over unstructured `C1:E181` lines. Preserve explicit `NONE`, multiple links, and claim identity; positional arrays risk silent shifts.

**Cheapest experiment:** replay the excerpt’s frozen values through only the compact grounder. Pass the common quality gate below, including omitted/duplicate identifiers. Measure actual serialized tokens.

### 2. G/F — Shorten instructions; establish whether caching actually helps

**G:** Removing an average 500 tokens per call saves **106.5k input tokens, 11.5%**. Wall-time saving is unknown without prefill timings. Retain field semantics, scope rules, and abstention; delete repeated prose and examples only through ablation.

**F:** A genuinely shared 1.5k-token prefix across 213 calls represents at most **~318k avoidable repeated prefill tokens**, not reduced logical prompt size. Existing cache hits reduce that opportunity. Residency, scheduling, and exact prefix equality matter.

Evidence-first grounding does **not** create cross-batch reuse: evidence changes too. Put all invariant grounding instructions/schema/field descriptions before **both** claims and evidence.

**Experiments:** G: one shortened-instruction excerpt run. F: replay identical requests with original versus reordered prompts, recording cache/prompt-evaluation behavior and latency. Keep only measured improvements; both must pass the quality gate.

### 3. B — Quote spans: potentially large, but not self-grounding

If each description saves 30–90 tokens, 420 records save **12.6–37.8k output tokens**, illustratively **6–18 minutes**. The proposed 100-token quote average is unverified: 180 characters is not 100 tokens by definition.

Offsets guarantee verbatim text **only after deterministic materialization and bounds checking**. They do not guarantee the correct passage, field, or record. Define the canonical text, Unicode indexing, and cross-anchor spans. Preserve independent semantic grounding initially.

**Experiment:** change only `find_description` on the excerpt. Require exact reference strings, valid ranges, unchanged support/precision and doubt flags. Reject invalid spans explicitly; never silently repair them. I cannot attribute the earlier hybrid failure without its results.

### 4. E — Discovery: real, especially on short reports

Eliminating discovery entirely caps this run’s saving at **332k input, 4.4k output, 9.5 minutes**. Avoiding 80% of its calls would save roughly **266k input and 7.6 minutes**, assuming comparable omitted chunks.

Start with a smaller discovery model using unchanged input: lowest semantic disruption, but **no token saving**. Then test reduced block representations preserving IDs and boundary context. Numbered-heading heuristics are corpus-specific; Danish prose already disproves a universal rules-only route.

**Experiment:** discovery-only replay on the excerpt, then values/grounding over its proposed boundaries. Require identical record coverage and no splits, merges, or truncations, plus the common gate. Before broader rollout, include Danish and cross-page records.

### 5. A — Joint extraction: large opportunity, currently fails acceptance

Removing grounding removes **379k input tokens gross**, plus 84 calls. Net savings subtract evidence scaffolding and citations added to values.

Illustratively, 3–6 added citation tokens per claim cost 10–21k output tokens; at the values effective rate, the nominal **31.6-minute** phase removal becomes **22–27 minutes**, before other costs.

But the reported joint arm already loses values/support and precision. Separate grounding gains an independent judgment, though not an independent source.

**Experiment worth keeping:** joint extraction followed by the existing grounder auditing *all* claims against unchanged evidence. It tests compact candidate-verification, not safe selective skipping. Require the common gate. Selective auditing needs evidence that its uncertainty signal catches silent errors.

### 6. D — Larger batches: secondary

Size 8 gives **151 total calls**; size 10 gives **129**, versus 213—not half overall. Savings are fixed overhead plus duplicated prompts. At one second overhead per eliminated call: **~1.0/1.4 minutes**.

**Experiment:** size 10, unchanged semantics. Require the common gate, exact routing, no omissions/duplicates, and measured latency improvement.

## Reject for now

**A hit-set filtering / C pre-links:** lexical uniqueness—even long or verbatim—does not prove semantic support. Filtering removes disconfirming context. Skipping all 420 description claims saves only approximately **6.5k grounding output tokens / 3.8 minutes**, before input effects. Earlier traps and retrieval losses argue against promotion.

**H chunk-joint:** nominally saves discovery’s 9.5 minutes, but risks cross-page ownership and incomplete records. Its historical losses are unavailable here; do not invent them.

## Gate and invariants

Every retained behavior-changing arm: `evaluate.py` against **203 reference values, 164 supported fields, 100% precision**; compare identities, not totals. Preserve reviewer links, explicit `NONE`, `verbatim`, and `lexicalHits`; include known traps.

**Strictly useless round trips: none demonstrated.** Discovery determines scope; grounding checks support. Repeated text and verbose serialization are waste, not proof that either judgment is redundant.
