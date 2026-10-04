# Design review request: FREE Studio Results rail prototypes

You are reviewing UI prototypes. Do not edit any file. Report findings only.

## Context
FREE Studio is a research tool: humanities researchers extract structured values from scanned PDFs (here a Danish archaeology report, "Grav 8"), then review each extracted value against its source evidence (approve / edit / reject). The current Results rail (right panel) is cluttered and confusing, and the rail and the document are poorly integrated.

Read for context:
- Current UI screenshots: /home/gebbaro/Progetti/FREE/artifacts/pr167-verification/results/real-catalog-final/evidence.png and .../real-article-final/reloaded.png
- Current code: /home/gebbaro/Progetti/FREE/prototypes/studio/src/ResultsTab.tsx, src/ReviewAttention.tsx, src/claimStates.ts
- Design system: /home/gebbaro/Progetti/FREE/prototypes/studio/DESIGN.md
- Domain glossary: /home/gebbaro/Progetti/FREE/CONTEXT.md

## Prototypes (self-contained .dc.html artboards: HTML markup with `{{holes}}`, `<sc-if>`/`<sc-for>` templating, and a `class Component extends DCLogic` script whose renderVals() feeds the template)
Directory: /tmp/claude-1000/-home-gebbaro-Progetti-FREE/bf3f4175-d086-45bc-9c56-bccb77b65e60/scratchpad/results-canvas/project/
- Main.dc.html: diagnosis of today's rail + proposed vocabulary
- CalmRail.dc.html (A): values-first rail: one header (status, progress, filters), records inline, selected value expands with source quote and Approve|Edit|Reject, diagnostics behind a "Run details" drawer, PDF|Markdown toggle moved to the document toolbar
- FocusReview.dc.html (C): one value at a time, document dimmed to the passage, key hints, auto-advance
- ReviewFlow.dc.html (A + C): the chosen direction; A's list with a "One by one" mode that turns the rail into C in place
- States.dc.html (E): the header in every state and at 264px / 344px rail widths
The user prefers A and C, so focus on ReviewFlow.dc.html, then CalmRail and FocusReview.

## What to review
1. Does the A + C flow actually fix the clutter and the rail/document disconnect? What is still confusing or cluttered?
2. Visual craft: alignment, spacing, hierarchy, density, type sizes, the selected-row expansion (recently reworked after the user called it sloppy), buttons, consistency with DESIGN.md (tokens, one filled primary per screen, colour never the only signal, evidence blue only for evidence marks, terracotta for selection/focus).
3. Interaction: list ↔ focus mode transition, keyboard model, undo, bulk "Approve rest…", what happens across records, edit flow, discoverability.
4. Honesty / domain correctness: the vocabulary (Verified, Rule-linked, Weak link, Unsupported, Unchecked, Missing; To check / Approved / Edited / Rejected) against claimStates.ts and CONTEXT.md. Are any distinctions the code keeps on purpose lost or misnamed?
5. Accessibility: semantics, focus, contrast, target sizes, screen-reader announcements.
6. Anything missing that would block turning this into production React in ResultsTab.tsx.

## Output
A ranked list (most important first), at most 15 items. Each item: severity (high/med/low), board + element (file:line where possible), the problem in one or two sentences, and a concrete fix. End with a 3-line overall verdict. Be blunt and specific; skip praise.
