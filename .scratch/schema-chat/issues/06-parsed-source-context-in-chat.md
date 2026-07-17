# 06 — Send parsed Source Context through existing chat

Status: resolved
Type: task
Blocked by: none

## What to build

Replace repeated PDF attachment in the existing chat with validated parsed
Source Document Markdown and annotations, preserving the current
conversational experience. Remove `FileUIPart` usage and data-URL conversion
for this path. Parsed Markdown is delimited and identified as untrusted
Source Context and is never interpolated into system instructions.
Annotation identity in the call includes annotation text and page number,
not only annotation IDs.

## Acceptance criteria

- [x] Chat sends parsed Markdown and annotations, never a PDF attachment
- [x] Source Context is delimited as untrusted data, outside system instructions
- [x] Annotations carry text and page number
- [x] Conversational experience unchanged for the researcher
- [x] Focused tests added; test, lint, and build green

## Blocked by

None - can start immediately.

## Answer

Studio chat now sends validated parsed Source Document Markdown and annotations
as request data instead of attaching the PDF. The route inserts a clearly delimited,
JSON-serialized untrusted Source Context immediately before the current researcher
question, including annotation text and page number, without changing system
instructions or the visible conversation flow.

Focused route coverage verifies multi-turn model-facing order and adversarial
boundary content. Studio's full test suite (161 passed, 2 skipped), lint, and
production build are green.
