# 0042: What the values cannot take is run again

Date: 2026-11-26. Status: accepted; amends [0035](0035-the-chat-proposes-corrections-to-results.md) and
[0037](0037-a-correction-the-template-cannot-hold-becomes-a-template-change.md); how a request comes to a new run is
superseded by [0043](0043-a-message-about-the-results-is-routed-by-its-facts.md).

## Context

A chat message about the results (0035) ended in one of two ways: changes to listed values, or, for what the template
cannot hold, a template change and a run (0037). A third kind of request fell between them. The template can hold
what it asks, yet no listed value can take it: a record the extraction missed, or a value the message says is wrong
whose right value the chat cannot find in the source it was shown (a long source is excerpted). Such a request was
read as a template change, though the template was right, or asked about again.

## Decision

- **Three answers to a request about the results.** The proposal's model says, for what the listed values cannot meet,
  whether the template is wrong for it (`templateChange`, as before) or the template already holds it
  (`rerun`: why a new run may read it, in one sentence). Never both: a template change is extracted again anyway, so it
  goes first, and Studio drops a `rerun` beside one, or beside the template change it asks for when every change was a
  misfit.
- **A new run is offered, not started.** After any changes to the values, the chat offers *Run extraction again*, with
  the reason, as this document's run with the template as it is. A "yes" beside it runs it; setting it aside unsaid
  ends it, as another proposal or another result shown does.

## Consequences

- A request the values cannot take no longer becomes a template change the template does not need.
- The offered run is the document's whole run: saved corrections stay, and guide it as any saved edit does.
- Whether a request is a value change, a run, or a template change is decided from facts the model reports (0043).
