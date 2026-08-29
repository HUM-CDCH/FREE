---
description: Explore, review, and simplify the current diff until stable
argument-hint: "[additional constraints]"
---
<!-- markdownlint-disable MD013 -->
# Reduce Loop

Run a parent-orchestrated explore → review → reduce loop over the current diff.

Use the `subagent` tool. The parent session owns iteration, accepts or rejects proposals, verifies results, and decides when stability is reached. Child agents must not launch subagents or control the loop. Set each child model to the current session model with the thinking suffix specified below; do not silently replace these effort levels. Never allow concurrent writers to share the active worktree or any other filesystem checkout.

## Goal

Reduce conceptual complexity and duplication in production code changed by the current diff. Net production LOC reduction is a useful outcome and must be measured, but never win over correctness, readability, explicit invariants, useful error signals, tests, or repository conventions. Do not compress code mechanically, combine unrelated responsibilities, remove useful tests, or move code elsewhere merely to improve the line count.

Scope defaults to files in the current working-tree diff against the branch merge-base. Include staged and unstaged changes. Exclude generated files, lockfiles, vendored code, snapshots, and test fixtures from LOC scoring. Tests may be edited only when behavior or obsolete duplication genuinely changes; deleting or weakening tests does not count as reduction.

Before the first round:

1. Read repository instructions and inspect the current diff.
2. Identify the merge-base and record a baseline with changed production files, added/deleted production LOC, relevant tests, and focused validation commands.
3. If there is no current diff, stop and report that there is no target.

## Each round

### 1. Explore

Launch three fresh-context, read-only `scout` agents in parallel. Use the current session model at these effort levels and give each a distinct angle:

- **Low effort (`:low`) — local cleanup:** obvious duplication, dead code, shallow wrappers, redundant branches, and reuse of nearby patterns.
- **Medium effort (`:medium`) — structural simplification:** state flow, module boundaries, abstractions, types, and tests that reveal unnecessary concepts.
- **High effort (`:high`) — alternative design:** deeper behavior-preserving simplifications, hidden coupling, and opportunities missed by local inspection.

Each scout must inspect the actual repository and current diff. Require file/line evidence, expected complexity benefit, estimated LOC effect, risks, and focused validation. Scouts must not edit files. The parent must merge duplicate findings and preserve disagreements for review.

### 2. Review

Launch four fresh-context, read-only `reviewer` agents in parallel over the scout findings and actual diff:

- **Correctness (`:medium`):** behavior changes, lost invariants, API/type changes, and error-handling regressions.
- **Tests and validation (`:medium`):** coverage gaps, weak validation plans, platform concerns, and misleading LOC savings from test deletion.
- **Simplicity (`:high`):** conceptual reduction, duplication removed, local consistency, readability, and net production LOC.
- **Architecture and maintainability (`:high`):** coupling, abstraction quality, responsibility placement, performance/security implications, and long-term costs.

Reviewers must inspect files directly, cite evidence, rank proposals, identify dependencies or conflicts between proposals, and not edit files. Reject code golf, abstraction churn, scope expansion, and line-count improvements achieved by relocating complexity.

### 3. Decide

Synthesize only proposals that are safe, in scope, behavior-preserving, and likely to reduce complexity. Reject speculative redesigns and changes whose only benefit is fewer physical lines. If a proposal requires a product, API, architecture, or scope decision, pause and ask me rather than guessing.

If no accepted proposal remains, the loop is stable; stop.

### 4. Build two isolated candidates

Create two independent candidate checkouts containing the exact same snapshot of the current target diff. Never point both workers at the active worktree and never let them share a checkout.

Preferred isolation order:

1. Use `worktree: true` only when the target snapshot is cleanly representable from `HEAD` and each worktree will receive the same target patch before editing.
2. When the active tree is dirty, create two temporary isolated clones/copies outside the repository, including staged changes, unstaged changes, and in-scope untracked files. Verify that both candidates reproduce the same target diff before launching workers.
3. If exact isolation cannot be guaranteed, do not run concurrent writers. Run the low-effort worker as a read-only implementation proposal, then the medium-effort worker as the sole writer in the active tree, and disclose the degraded mode.

Launch two `worker` agents in parallel only after isolation is verified:

- **Conservative candidate (`:low`):** smallest safe patch using local patterns and minimal abstraction change.
- **Structural candidate (`:medium`):** best behavior-preserving simplification of the accepted proposals, allowed to reshape internals within scope.

Give both workers identical accepted requirements, baseline, validation contract, and stop rules. Require focused validation plus a report of changed files, commands with exit codes, production LOC before/after, complexity removed, and anything left undone. Do not impose hard turn or tool-call caps. Candidate workers may edit only their assigned isolated checkout.

### 5. Adversarial selection

After both candidates finish, launch one fresh-context, read-only `reviewer` at `:xhigh`. Give it the baseline and both candidate diffs, reports, and validation evidence. It must inspect both candidate checkouts directly, adversarially test their claims, and choose one of: candidate A, candidate B, a clearly specified safe combination, or neither.

The selector must prioritize correctness, conceptual simplicity, preserved invariants, readability, local consistency, validation strength, and only then net production LOC. It must explain the decision with file/line evidence and identify any repairs required before adoption. It must not edit files.

### 6. Adopt and verify

The parent applies only the selected candidate patch to the active worktree. Do not merge candidate branches wholesale and do not combine implementations unless the adversarial selector explicitly demonstrated that the patches are compatible. Before applying, confirm that the active target snapshot has not changed; if it has, stop and reassess rather than forcing the patch.

Inspect the adopted diff yourself. Run or confirm focused tests, lint, type checks, and diagnostics appropriate to the changed files. Recompute production LOC using the same baseline rules. Revert or repair any reduction that weakens behavior, tests, clarity, invariants, or local style. Delete temporary candidate checkouts only after their useful diffs and validation reports have been captured.

Start another round only if the worker made a material accepted simplification and validation passes. Stability is reached when a complete explore/review round produces no further safe, worthwhile complexity reduction. Do not continue for optional polish, formatting-only churn, code golf, or repeated rejected ideas.

## Completion report

Report:

- rounds completed and why the loop stopped;
- production LOC before and after, with the counting scope;
- concrete complexity or duplication removed;
- validation commands and results;
- rejected or deferred opportunities and why;
- remaining risks.

Additional constraints from this invocation:

$@
