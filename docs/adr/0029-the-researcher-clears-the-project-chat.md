# 0029: The researcher clears the project chat

Date: 2026-11-09. Status: accepted; amends [0028](0028-the-project-chat-is-kept-with-the-project.md).

## Context

The project chat is kept with the project (0028), and the instructions kept in it steer every template generation.
Deleting the template cleared the conversation in the page but not where it is kept, so a reload brought the old
instructions back, and the next generation used them. The researcher had no way to start the conversation again.

## Decision

- **Clearing is its own action.** The chat's *Clear conversation*, confirmed in a dialog, removes every entry of the
  Project Context's chat: messages, kept instructions, questions with their answers, answered steps and document turns.
  `DELETE /api/project-contexts/:id/chat` clears it, owner-scoped like the other chat routes, under the project row's
  lock so an append waiting meanwhile lands after it; the chat starts again from position 1.
- **The stored chat goes first.** The page clears what it shows only once the stored chat is cleared; a write already
  on its way finishes before the clear, and entries queued unsent are dropped. A failed clear changes nothing shown.
- **Not while something is on its way.** Clear is unavailable while a reply, an edit request or a proposal is pending.
- **Deleting the template keeps the conversation.** The template and the conversation are cleared separately.
- After a clear, the next thing said names its Source Document again, as at the start of a chat.

## Consequences

- A template generated after a clear reads no instruction from before it. Nothing records that a clear happened.
- The schema revisions, extractions and reviews made before a clear stay; only the conversation goes.
