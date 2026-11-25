# 0036: A missing value can be filled in

Date: 2026-11-25. Status: accepted; amends [0035](0035-the-chat-proposes-corrections-to-results.md).

## Context

When the extraction finds nothing for a field, the value is saved as missing (`absent`): it has a stable identity,
its producing field and an empty model value, but no decision could be saved on it. Results showed it as "No value",
not reviewable, and the chat (0035) left it out of the values it could change. A researcher who knew the value was
in the source, on a page the model did not read well, could not record it anywhere but in an export they edited by
hand, and the next Extraction learned nothing from it.

## Decision

- **A missing value takes an edit that fills it in, and its undo.** The correction save accepts `EDITED` (with a
  value that fits the producing field and is not null) and `PENDING` on an `absent` value, and refuses `APPROVED`,
  `REJECTED` and cell approvals: there is no reading to approve, and a rejected nothing is still nothing. Values not
  read yet (`unprocessed`, `failed`) stay closed.
- **It is an ordinary correction.** It is revisioned, conflicts as any other, may carry correction Evidence the
  researcher links, and guides later Extractions when included. With no Evidence, its source context is the
  document, as for any edit without one.
- **Review does not wait on it.** Review counts and finalization still cover saved values only: a missing value is
  neither to check nor required, and filling one in does not count as reviewing a saved one.
- **Where it shows.** Results offers *Fill in* on a missing row (no Approve or Reject); once filled it reads
  *Edited*, and *Filled in by you · No source linked* when no Evidence is linked. History says *Filled in*; exports
  carry the value with the decision *Filled in*. Words stay plain and few: the row says what happened, not why.
- **The chat lists missing values too.** After the saved values, each missing one is listed with `"missing":true`;
  the model may fill it in with an edit, never reject it. A change that would empty a filled-in value is left out
  and said: "to remove a value you filled in, use Undo in Results".

## Consequences

- A record the extraction never found has no values to fill in; adding a record stays out of scope.
- Missing values come after saved ones in the chat's value table, so on a long result its budget leaves missing
  values out first.
