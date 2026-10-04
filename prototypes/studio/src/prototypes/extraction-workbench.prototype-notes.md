# Extraction workbench interaction verdict

Date: 2026-10-04. Status: throwaway planning artifact, not production implementation. Baseline `a1ae85b7`. Origin: [Prototype pause, live correction, and parameter-edit interactions](https://github.com/HUM-CDCH/FREE/issues/175).

Open `extraction-workbench.prototype.html` directly in a browser; no install/server/database. The file contains a pure in-memory reducer plus free-play controls and 13 guided scenarios. It answers whether pause/drain, live corrections, saved selections, and partial exports can remain understandable in one workbench. Styling is restrained illustration, not a production design replacement.

Verdict: retain one lifecycle/control banner with saved/in-flight/pending state, an always-visible saved-result view, adjacent parameter controls, and simple evidence/compatibility warnings. Keep results and exports accessible during every state. Distinguish a saved selection from one adopted at an idle boundary. Historical producing-revision values and current-schema corrections are visibly separate. Existing calls retain context; subsequent calls in another Extraction use compatible feedback while keeping their selected schema/settings.

The user authorized completing the map and consulting Claude Code for uncertain judgment on 2026-10-04. The requested `fable-5.1` spelling was unavailable; the user explicitly approved the configured default at high effort. Claude reports actual model `claude-fable-5-1`. It found no unresolved critical human choice and judged the prototype grounded for resolution after concrete reducer fixes. This is delegated judgment under that authorization, not an assertion that the researcher personally clicked every scenario.

Corrections made from review: no Paused/Stopped acknowledgement while outputs await saving; per-target schema feedback eligibility; saved selections survive restart; failed idle boundaries accept revised inputs; control intent suppresses replay when paused/stopped; correction history persists; failed restart retains Retry; last-call failure settles; producing settings/feedback/attempt attribution remains in saved values/export snapshot; keyboard focus and feedback toggle semantics survive rendering.

One reviewer analogy was rejected because the user had already decided otherwise: after Stop is accepted, the terminal state is Stopped even if the last draining call completes. Completed wins only the explicitly agreed Pause race. Resolving an old correction supersedes its active feedback revision across targets; unchanged schemas do not keep consuming a superseded version merely because it once matched.

Browser interaction checks used local Playwright/Chromium with normal button and keyboard actions, no test suite added:

| Walkthrough | Observed outcome |
| --- | --- |
| Pause and resume | Both calls drain/save; Paused acknowledges only after commit; Resume starts remaining work. |
| Live correction | Save without pause; B's new call captures guidance; optional evidence linking and exclusion work. |
| Edit parameters | A's numeric schema excludes text correction; B's old text schema still uses it. After numeric correction supersedes it, B excludes the numeric revision; old text correction remains historical. |
| Saving fails | No premature Paused acknowledgement; restart suspends unsaved calls; explicit Resume repeats only unsaved calls. |
| Stop during pause | Drains/saves to Stopped; Resume refused; saved partial export remains available. |
| Failure and retry | Concurrent success preserved; correction retained; Retry schedules unfinished work. |
| Queued pause | No call starts before pause; restart stays paused; Resume enables admission. |
| Export snapshot | Snapshot remains fixed while more results arrive and edits pause execution. |
| Completion race | Final durable work yields Completed despite pending Pause; evidence state remains independently visible. |
| Returned but unsaved | Pause stays Pausing with zero in-flight calls until returned outputs save. |
| Fix after failure | Save/adopt selection at idle Failed boundary; Retry uses revised inputs. |
| Saved selection restart | Saved selection survives restart while local unsaved typing does not; adoption still requires idle boundary. |
| Failed restart | Failure during pause remains Failed after restart; Retry remains available. |

No browser JavaScript errors observed. Desktop inspected at 1200×900; mobile at 390×844 had document width 390, with no horizontal overflow. Keyboard focus remained on the next walkthrough step or selected scenario after re-render; Tab focused the next scenario with a visible outline. Screenshot assets show the incompatible-field state at desktop and mobile widths. These checks verify this interaction model, not PostgreSQL durability, production accessibility, actual model grounding, DBOS recovery, or export file generation.

Unmodeled implementation concerns—real fences/concurrent stale-view conflicts, source Evidence linking, selective reprocessing, batch pagination, and actual CSV/XLSX production—remain specified in their existing decision tickets and final implementation asset. The export control deliberately previews a fixed snapshot rather than pretending to generate a production workbook. The simulation's durability is an in-memory saved-state copy and is clearly labelled.
