# Deployed Studio exploratory browser testing

Date: 2026-10-01. Status: authenticated exploratory pass completed; two reproducible UX findings, no observed workspace crash. Target: `https://baratheon.cdch-dgxspark.lan.ku.dk:11434/free/`.

Purpose: extend the accompanying [UX/user-story catalogue](2026-10-01-studio-ux-user-stories.md) with observed behavior from semi-random normal browser interactions. This is a bounded exploratory pass, not load testing or a security penetration test. Only clearly named test data created by this pass may be deleted. Existing projects, configuration and research records must remain intact.

## QA inventory

| Surface / claim | Functional checks | Visual check / evidence |
| --- | --- | --- |
| Entry and authentication | `/free` redirect, session/login state, reload/back/forward | Screenshot, URL, visible account/access state |
| Home and project rail | Open projects, resource tabs, rail disclosure, rapid switching | Screenshots and route/content agreement |
| Document workspace | Open/close/switch tabs, panel switches, PDF zoom and scroll | Screenshots, page errors, selected document identity |
| Schema and results | Inspect views/history and Evidence; editing only in newly created test resources | View labels, stale/read-only affordances, failures |
| Batch navigation | History/member/grid transitions and return link | Route/content agreement and error capture |
| Model Configuration | Open/close and switch tabs; no Apply to existing configuration | Visible controls, viewport fit, console/errors |
| Narrow viewport | Navigation drawer, controls, dialog fit | Screenshot and region bounds |
| Off-path navigation | Rapid Back/Forward/reload while a read is pending | Reproducible sequence and late-response correctness |
| Off-path interactions | Repeated open/close/switch actions and inaccessible route | Recoverable error versus crash/hang |

Authentication requiring interactive user credentials will be reported as a limitation. Test execution, outcomes, reproducible defects and artifact paths will be recorded below after observation; no passing claims are made in this initial inventory.

## Entry checks observed

- The supplied `/free` URL responds with HTTP 308 to `/free/`.
- A fresh Chromium context navigated to `/free/` and was redirected to Microsoft Entra, where the University of Copenhagen sign-in form rendered. This is an authentication boundary, not an application failure.
- An anonymous GET to `/free/api/auth/session` returned HTTP 200 with `{"authenticated":false}`.
- An anonymous GET to `/free/api/project-contexts` returned HTTP 401 with `authentication_required`; no project data was returned.
- A visible persistent Chromium session was opened for user sign-in. Its Playwright context used a 1440×1000 viewport and accepted the deployment's TLS certificate for this test. The browser's identity-provider page produced two console resource-401 messages and the authentication phase recorded a callback 400 before the successful session; these were not reproduced during workspace navigation and do not establish a FREE defect.
- The deployment's build identity has not been compared with local HEAD. Source-derived story expectations must be rechecked against the deployed behavior.

The user completed Microsoft authentication, after which all workspace checks below ran through the real deployed app. No API response was mocked and no internal application state was injected.

## Execution and scope

The session exercised the existing `lel` and `lol` projects, including a 51-page source and a two-page source with an incomplete Article result. Existing schema/review/configuration values were inspected, not deliberately changed or submitted. No new model call, ingestion, reprocessing, extraction or batch execution was started. Batch preparation/history was checked; a populated batch review grid was unavailable in the selected projects.

The semi-random pass used seed **20261001** and attempted **100 actions**: 38 known-route navigations, 44 clicks, 8 Back actions, 4 Forward actions, 5 reloads and 1 strategy selection. It visited eight distinct route URLs. The [seeded action/outcome record](2026-10-01-studio-exploratory-evidence/seed-20261001-navigation.json) records every step. There were 99 completed actions and one rejected automated click: it attempted a background rail control while Model Configuration was opening. The modal correctly intercepted the click; this is a test-driver selection error, not an application defect. Separate manual sequences exercised additional UI states and are recorded in the [interaction log](2026-10-01-studio-exploratory-evidence/interaction-log.jsonl).

Targeted checks included:

- Project Sources/Schemas/Extractions switching; rapid route changes; Back/Forward and reload; both document routes reopened successfully.
- Schema Fields/JSON, Results Review/Raw JSON/Markdown, nested result navigation, used-schema inspection and Run details.
- Model Configuration Models/Connections/Advanced; opening/closing without Apply; desktop and 390×844 viewport layouts.
- PDF zoom and sample-page selection controls without submitting a run.
- Empty batch preparation, including disabled Run with zero selected sources.
- Blank project-name validation, then creation of `E2E exploratory 2026-10-01 — temporary`, Unicode rename, reload, delete cancellation and confirmed deletion of **only that new empty project**. Its ID was `d81a7bbf-ce2f-4f36-b884-42f84f3ab6f4`. Home returned to the original two projects after cleanup.
- Reopening the deleted test project's URL: the app showed **That project no longer exists** and remained navigable. Its project/ingestion reads returned expected 404s. [Screenshot](2026-10-01-studio-exploratory-evidence/07-deleted-project-route.png).

No uncaught `pageerror` event was observed. The seeded pass produced no new failing application response beyond the earlier authentication events already listed. The later deleted-resource 404s were expected negative-test results. These statements apply only to this browser session and these actions; they are not proof that all workflows or browser engines are defect-free.

## Reproducible findings

### UX-01: mobile project drawer ignores Escape

Classification: keyboard usability finding; suggested priority P2. Reproduced repeatedly, including with focus explicitly on a control inside the drawer.

1. Open an authenticated project/document at a 390×844 viewport.
2. Activate **Open project navigation**.
3. Focus the drawer's **Collapse projects** button.
4. Press **Escape**.

Observed: the drawer and backdrop remain open; the DOM still exposes **Close project navigation** and **Collapse projects**. Pressing Enter on **Collapse projects** closes it, so there is a working alternative. Export options does dismiss on Escape in the same session.

Expected UX: Escape should dismiss the overlay and return focus to its opener. This is a consistency/accessibility improvement; no explicit product-contract requirement for drawer Escape was identified, so it is not labelled a data-integrity defect.

Evidence: [focused Escape screenshot](2026-10-01-studio-exploratory-evidence/09-drawer-focused-escape.png), [second reproduction](2026-10-01-studio-exploratory-evidence/10-drawer-escape-reproduction.png), and the interaction log. A screenshot immediately after opening captured the rail during its width animation; the settled focused screenshots confirm normal full drawer width. The animated frame is **not** evidence of a persistent clipping defect.

Candidate E2E acceptance after adopting the behavior: narrow viewport → open navigation → focus its control → Escape → backdrop hidden and opener focused. Pair it with normal close-button and outside-click checks, including desktop-to-mobile resizing.

### UX-02: review counters use conflicting-looking meanings of pending

Classification: review-progress wording finding; suggested priority P2. Reproduced after reloading/reopening the two-page source and selecting Results.

Resource: project `947ff674-d541-4ce2-b011-732213385bdb`, document `c333daed-ca39-40ea-9bb5-c0c272633584` (`pmph3task1.pdf`).

The same result simultaneously displays:

- **22 required decisions remaining**, **22 grounded**, **24 ungrounded**;
- **Decisions: 46 pending**;
- **Approve remaining (22)**;
- a notice that the 24 ungrounded values are optional.

Observed: the required-action count is 22, while the generic pending badge reports 46. This makes it unclear whether the optional values must also be reviewed to finish. The screenshot also shows **Draft saved**, but this pass did not establish whether that draft predated the session; no claim is made that opening Results incorrectly wrote a draft.

Expected UX: distinguish required decisions still needed from optional/populated decision entries. For example, use the required count for the pending badge or label the larger number as total values/decision entries. The exact wording should follow the adopted review semantics.

Evidence: [stable counter reproduction](2026-10-01-studio-exploratory-evidence/11-review-counter-reproduction.png), [initial desktop results](2026-10-01-studio-exploratory-evidence/03-results-desktop.png), and recorded DOM text. This is a display/interpretation finding, not evidence of incorrect finalization or lost decisions; no existing review was finalized or reverted to test it.

Candidate E2E acceptance: fixture with grounded and optional ungrounded values → assert required-count badge, remaining-action button and completion guidance use explicitly consistent scopes; partial/full draft and carried-review variants should preserve those scopes.

Local implementation outcome: [counter fix and verification record](2026-10-01-review-counter-fix.md). This resolves the source-side total-as-pending wording and persistence-feedback inference; the deployed build has not been updated or rechecked, and its optional-decision behavior remains distinct from the local contract.

## Additional observations, not confirmed defects

- Opening both documents briefly exposed **No Source Document open** while the requested document was still loading, then rendered the correct workspace. Recorded DOM snapshots capture this transient empty-state wording; its duration was not measured. A dedicated delayed-read test would establish whether loading should replace that message.
- The live deployment exposes **Import Excel codebook**, selected-source sample coverage, review-attention navigation and optional ungrounded-review wording beyond the earlier source-derived catalogue baseline. Presence of those controls does not verify the full import/transfer contract. Reconcile deployed build identity and current task status before promoting those stories into release gates.
- At 390×844 the right panel covers most of the PDF and its long contents scroll internally; the toolbar scrolls horizontally. Primary review/export controls were reachable. No persistent page-level horizontal overflow was observed in the sampled views; desktop/mobile metrics and screenshots are in the logs. This does not establish every editor or modal's viewport fit.

## Evidence and limits

- [Authenticated home](2026-10-01-studio-exploratory-evidence/00-authenticated-home.png), [project Sources](2026-10-01-studio-exploratory-evidence/01-project-desktop.png), [document/schema](2026-10-01-studio-exploratory-evidence/02-document-desktop.png).
- [Mobile Model Configuration](2026-10-01-studio-exploratory-evidence/04-model-config-mobile.png), [mobile Results](2026-10-01-studio-exploratory-evidence/05-results-mobile.png), [mobile nested result](2026-10-01-studio-exploratory-evidence/06-results-mobile-item.png).
- [Seeded actions/outcomes](2026-10-01-studio-exploratory-evidence/seed-20261001-navigation.json) and [targeted interaction log](2026-10-01-studio-exploratory-evidence/interaction-log.jsonl). Early targeted log entries contain resulting snapshots without operation lists; later entries record both. These are custom Playwright observations, not a standard Playwright trace archive.

The pass used Chromium with desktop and narrow viewport emulation, not additional engines or a physical touch device. Authentication and app APIs were real; no deployment process was restarted, no network failure was injected, and no backend row/artifact audit was performed. Existing project data and model credentials were not used for destructive tests. The temporary project was deleted; the two original projects remained listed and their source routes remained accessible. No application fix was made in this task.
