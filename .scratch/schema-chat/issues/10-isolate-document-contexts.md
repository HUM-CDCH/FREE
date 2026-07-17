# 10 — Isolate active Source Document contexts

Status: ready-for-agent
Type: task
Blocked by: 09

## What to build

Opening another Source Document starts a new active document context:
increment the monotonic document epoch, abort schema generation and chat for
the previous context, clear the approved schema, pending suggestion,
conversation, and Extraction Results, and reset schema revision for the new
epoch. Generation, chat, and extraction responses from a previous epoch must
not cross into the new context — completion guards include both epoch and
revision. `SchemaPanel` local editing state resets after an external Apply.

Run the final integrated acceptance verification against the complete
acceptance list in `docs/schema-chat-plan.md` § Acceptance, with the
credentialed Gemma check as the documented manual smoke test.

## Acceptance criteria

- [ ] Opening another Source Document clears all browser-owned document context
- [ ] Late generation/chat/extraction responses from a previous epoch cannot commit
- [ ] Revision resets per epoch; guards always pair epoch and revision
- [ ] `SchemaPanel` local editing state resets after external Apply
- [ ] Full plan acceptance list verified; manual smoke procedure current
- [ ] Focused lifecycle tests added; test, lint, and build green

## Blocked by

- 09-modify-schema-through-chat
