# 0039: Mark as reviewed keeps the results editable

Date: 2026-11-25. Status: accepted.

## Context

Every decision in Results is saved as it is made. The header's *Save review* then created the Finalized Review of the
shown pair (result snapshot, Decision Version) and switched Results to that pair, view only. Researchers read "Save" as
"or lose your work", and the view-only page looked as if the results were locked. Changing a value meant finding *Show
the latest results* first.

The view-only switch also hid a real gap. The Decision Version is the Project's: a correction in another document
raises it, so the live cut of a reviewed document names no review of its own and offered *Save review* again, although
nothing in it changed. Showing the finalized pair avoided saying so.

## Decision

- **The action is named for what it does.** *Mark as reviewed* in Results, the batch grid and the save dialog ("All
  values checked. Mark this document as reviewed?": *Yes, and open …*, *Yes*, *Not yet*). Finalization stays explicit.
- **The results stay shown.** Marking reads the shown results again; it no longer opens the marked pair. The pair opens
  from History, as every Finalized Review does.
- **A page says where its review stands.** Beside `finalization` (a review of exactly this pair), the page read returns
  `review`: the latest Finalized Review of this snapshot named at or before the cut, and `changed`, whether this
  Extraction's decisions as of the cut differ from those it named (the digest `finalize` stores, computed the same way).
  Studio counts the results reviewed while it is unchanged; changed, the header says *changed after review* and offers
  *Mark as reviewed* again.

## Consequences

- Another document's correction no longer makes a reviewed document look unreviewed.
- An export, the project's counts and the guided workflow still read the Finalized Reviews themselves: a change after
  review is exported once the document is marked again, as before.
- One more finalization query per page read, and a digest of this Extraction's decisions when a review is not the cut's
  own.
