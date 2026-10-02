# Fable 5.1 closing review

Date: 2026-09-29. Model verified in CLI result metadata: `claude-fable-5-1`.
Round 4 of the discussion recorded in [discussion.md](discussion.md).
The response below evaluates the plan, not implemented behavior. The two
additional evaluation details were subsequently incorporated into tasks 1.4/6.2.

---

**Round 4. Verdict: AGREED.**

Checked each round-3 finding against the amended text.

| Finding | Where resolved | Status |
| --- | --- | --- |
| A1 recovery artifact | design §7, tasks 1.3/2.4/4.3/4.5, spec "Recovery preserves…" | Resolved. Ordering, write-once semantics, conflict, `budget_unhonorable`, identity validation, embedded records+digests, both crash boundaries, concurrent recovery, cancellation, cleanup all present. Your refinement (worker validates local files, Studio verifies embedded digests via existing acceptance, no second fetch API, no per-window steps) is the right shape; the Studio check is self-consistency plus pin match, which is all it needs. |
| A2 legacy isolation | migration step 3, tasks 1.2/4.4 | Resolved. Golden capture before shared edits, frozen closure or byte-equal scripted proof per change, fixed clock/metadata. |
| A3 item identity | design §4, tasks 3.4, spec "Candidate merging…" | Resolved, more conservative than my proposal; acceptable. See limitation below. |
| A4 document partition | design §3, tasks 3.2, spec scenario, risks | Resolved. Independent partition over all nonblank ranges, separate accounting, cost disclosed. |
| A5 migration blocks admission | migration step 4, tasks 4.2/5.3, spec added req | Resolved. Refreshable conflict, tolerant decoders, byte-identical retired keys, atomic Apply, Article usable. |
| A6 fit at execution | design §5, tasks 5.1, spec | Resolved. Shape at admission, fit at execution, per member, settings error. |
| Continuation incl. overlap 0 | design §2, tasks 2.3, spec | Resolved. |
| Verification batching | design §3, tasks 3.5 | Resolved. Stable IDs, partition on overflow. |
| Whitespace | design §2 | Resolved. Unicode `White_Space` only. |

**A3 limitation, explicitly acknowledged.** The conservative rule does not make the user requirement unachievable. Complete scheduling, disjoint ownership and exhaustive accounting hold regardless. What first release gives up: an array item whose leaves are split across two entry windows is never assembled into one object; it stays as partial proposals with explicit cardinality. Items fully inside one window, and items fully observed twice under overlap, resolve normally. This is a visible completeness cost, not a fabrication risk, and the correct trade for a first release. Two consequences the plan must carry, both task-level not architecture:

- 1.4 holdout labels must include known split-item cases per family so the partial rate is measured, and thresholds must count partials as unresolved, never as correct or wrong.
- 6.2 reports partial-item rate alongside boundary/field quality; if a family's rate is high, that argues for stitching as the next change, not for loosening the rule here.

**Rejected round-3 items, accepted.** Dropping within-observation same-span dedup is fine; with occurrence anchors a true duplicate has equal anchor and equal everything, and flagging rather than collapsing costs only reviewer time. Dropping shared-first-leaf stitching was already my intent; your wording is stricter and clearer.

**Non-blocking notes.** `window_refused` name from round 3 does not appear; any stable code is fine as long as 1.3 fixes it. "On each change" in step 3 should mean CI on every PR until 6.5, not manual runs.

**Shared decisions 1–9 stand.** Phase-1 numeric defaults, evaluation registration and fixture capture are tasks. No implementation or test results are claimed. Plan is executable as written.
