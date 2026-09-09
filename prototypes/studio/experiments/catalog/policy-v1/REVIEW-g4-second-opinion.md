# Second opinion on gate G4 (gpt-6-astra via omp, 2026-09-09)

Verbatim reply to the brief in the session scratchpad; the brief's claims are reconciled in PROTOCOL.md, "Reconciliation after the second opinion".

1. **Do not revise G4 to make this result pass. Keep the default unchanged pending an independent adjudication review.** If adoption proceeds despite a confirmed failure, use **(b)**: an explicit acceptance override, not a passing gate. Record the failed criterion, accepted risk, decision-maker, scope, and original results. Counting “one revision plus one exception” versus “two revisions” is bookkeeping, not scientific justification.

2. **Point 1 identifies low resolution, not a denominator defect.** With a zero baseline, “wrong-anchor rate ≤ baseline” means zero observed wrong anchors, regardless of sample size. That is the gate’s literal consequence. Coverage and precision need not have identical tolerances: additional correct links do not necessarily compensate for misleading evidence. Small samples make this comparison unstable and weak evidence about underlying error rates; they do not invalidate its arithmetic. A prospective noninferiority margin could be defensible. Choosing one after observing the failure cannot validate this run.

3. **Point 2 wrongly narrows G4 to structural cross-record leakage.** The protocol separately prohibits cross-record links and limits wrong anchors. An anchor inside the correct record can still support the wrong proposition. The baseline having access to that anchor proves neither equivalent behavior nor safety. Its unsupported extraction is a separate failure, not an excuse for the candidate’s citation.

   **For the entire quoted passage, I would label the link supported under ordinary semantic grounding.** Its opening describes burned human and animal bones and a comb that accompanied the funeral pyre in A240’s context. That supports a cremation burial independently of the later comparative occurrence of *brandgrave*. The supplied earlier rationale ignores that opening.

   If the frozen rubric requires an explicit classification rather than this inference, the appropriate error would be **wrong-passage**, given that the cited anchor belongs to A240—not structural cross-record leakage. Exact labeling must follow the frozen taxonomy.

   “Never change a label because it changes a gate” is also wrong. Correct erroneous labels through an arm-blind review applying the same rule to both arms; preserve the original decision and report both scores. Do not relabel solely to obtain acceptance.

4. **Do not pool post hoc. Reconcile the protocol before declaring any gate outcome.** Pooling changes the estimand and lets larger documents mask a local regression. Here it also lets Hojbakkegaard’s baseline error offset Herredsvejen’s candidate error.

   The supplied text contains material contradictions:
   - Revision 2 says **“no more wrong-record or wrong-passage links”**—counts—while the scorer uses rates.
   - The closing paragraph says wrong links over linked units; the reported calculation uses linked units **plus wrong links**.
   - Contrary to the brief’s assertion, unsupported values appear in the section explicitly described as pre-registered before revision 2.

   Establish the authoritative frozen specification and chronology. **Keep unsupported values if that revision-2 registration is authentic; otherwise report them diagnostically and register any future gate prospectively.**

5. **G2’s motivation is sound; its threshold is not established.** Fixed overhead and integer calls explain infeasibility at three records. They do not justify allowing nine candidate calls against nine baseline calls, then only four against ten. That cliff needs an independent operational rationale; otherwise use a prospectively specified overhead/rounding allowance.

   Finally, process variability is a reason **for** repetitions, not against them. Visible-arm adjudications also violate blinding. A full-Beier Spark run cannot resolve Danish transfer validity, and Katrinesminde’s schema exclusion does not erase its observed identity/fallback failure.
