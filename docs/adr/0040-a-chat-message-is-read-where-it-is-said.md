# 0040: A chat message is read where it is said

Date: 2026-11-25. Status: accepted; amends [0034](0034-the-chat-reads-what-a-message-asks-first.md) and
[0035](0035-the-chat-proposes-corrections-to-results.md).

## Context

A chat message is classified before anything is done with it, and `edit` (change the template) and `correct` (change
particular extracted values) were told apart by its words alone. Many messages fit both ("the date is wrong", "年份不对"),
and the classifier did not know whether the researcher was looking at the template or at the results, or whether there
were results to change at all. The same message sent from the Results view could become a template proposal.

## Decision

- **The page says where.** An edit request after the first template carries `view` (`chat`, `template` or `results`)
  and `results=true` when a result is shown whose values a message can change (the Results view's result, not a
  read-only earlier one). The `proposeSchemaEdit` workflow's input keeps it as an optional `where`; inputs without it
  are read as before, and the step sequence is unchanged.
- **The classifier leans to what is looked at.** It is told the view and whether values can be changed. A message that
  could be either is `correct` when the researcher looks at the results and they can be changed, and `edit` when they
  look at the template or nothing can be changed. In the chat with a result shown, the words alone decide, as before.
- A message whose words are clear is read by its words wherever it is sent.

## Consequences

- "The date is wrong" sent under Results proposes changes to the values shown; under Template, a template change.
- Before the first template there is no `where`: nothing can be corrected yet, and Studio says so.
