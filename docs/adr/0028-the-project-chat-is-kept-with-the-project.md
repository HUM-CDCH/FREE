# 0028: The project chat is kept with the project

Date: 2026-11-03. Status: accepted; amends [0026](0026-the-chat-leads-the-whole-workflow.md); amended by
[0029](0029-the-researcher-clears-the-project-chat.md).

## Context

The chat leads the whole workflow and belongs to the project (0026), yet it lived only in the browser: it survived a
turn to another document of the project, but not a visit to the project page, a reload or another device. Every
request also sent the whole conversation to the model, with nothing to say that earlier messages were about another
Source Document than the one it reads, and nothing to bound its length short of the server's 500-message refusal.

## Decision

- **Kept with the project.** Each Project Context has a chat log: `projectChatEntry` rows, ordered by `position`
  (from 1, never moved) and cascaded with the project. An entry is a message, a message before the first template
  (an `instruction`, or a question with its `answer`), a guided step's answer, or a `document` turn
  (`shared/projectChat.contract.ts`). `GET/POST /api/project-contexts/:id/chat` read the latest 1,000 entries and append;
  `DELETE …/chat/:entryId` takes back a kept instruction, the only entry the researcher can remove. Every route is
  owner-scoped. The client names each entry's ID, so a repeated append adds nothing twice, and writes them one after
  another, so the stored order is the order said; a failed write is tried again with the next.
- **A message is kept once it is answered** (or fails), ahead of its answer. A message taken back with Stop is never
  kept. A pending proposal is not part of the log; the model operation recovery reopens it as before.
- **A turn to another document is said.** Before anything is said on a document other than the one the chat last
  named, a `document` entry names it, in the conversation and in the log. Opening a document without saying anything
  adds nothing.
- **The model reads the conversation bounded and placed.** Chat history gains a `note` role, Studio's own lines: each
  document turn becomes one, and the prompt says earlier messages may be about another document than the one read
  now. The history sent is the latest messages within 24,000 characters and 200 messages; when it is cut, a note says
  so and the document the first kept message was about is named again.

## Consequences

- The conversation is the same on reload, on the project page and back, and on another device; the researcher clears
  it only as a whole (0029).
- Older entries than the latest 1,000 stay stored and are not shown; nothing prunes the log yet.
- The standalone Template panel, outside a project's document workspace, keeps its chat for the page only.
