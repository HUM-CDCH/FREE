# 06 — Send parsed Source Context through existing chat

Status: ready-for-agent
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

- [ ] Chat sends parsed Markdown and annotations, never a PDF attachment
- [ ] Source Context is delimited as untrusted data, outside system instructions
- [ ] Annotations carry text and page number
- [ ] Conversational experience unchanged for the researcher
- [ ] Focused tests added; test, lint, and build green

## Blocked by

None - can start immediately.
