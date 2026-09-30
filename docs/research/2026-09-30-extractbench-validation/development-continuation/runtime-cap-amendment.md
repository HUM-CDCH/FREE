# User-selected two-hour cap

After launch, the user answered the pending runtime question with “Up to 2 hours.”
This supersedes the original eight-hour admission default. The elapsed limit is
measured from the original start, **2026-09-30 10:54:39.692842 UTC**, not from the
answer or a restart. No request, extraction setting, model, source group, shuffle
order, recovery policy, evaluator or call allowance changes.

The existing runner already accepts a `STOP_REQUESTS` marker. A separate task-owned
[timer](enforce_runtime_cap.py) creates it after 105 minutes, at **12:39:39 UTC**,
leaving the configured 900-second request timeout to drain before the two-hour
wall cap at **12:54:39 UTC** (14:54 Rome time). If the runner is still alive at that
cap, the timer sends SIGTERM through its Linux pidfd. This targets the captured
runner process and cannot kill a later process that reuses its numeric PID.
The model server and other processes are unaffected.

The timer records its actions separately. Forced termination requires reconciling
every started request with its completion journal and response cache; missing
usage remains unknown and its reservation stays consumed. Neither deadline-stopped
cells nor cells not reached are treated as complete. The fixed cell order is not
rearranged to finish a more favorable comparison within the shorter window.

The [amendment record](runtime-cap-amendment.json) records both deadlines; the
[process record](runtime-cap-process.json) pins the timer and command. A harmless
local subprocess test verified admission stop, pidfd termination and reconciliation
marking without inference; see [verification](runtime-cap-verification.json).
The frozen launch manifest, runner and original start record remain unchanged.

To apply this exact later amendment to an independently launched, matching run:

```bash
/usr/bin/python3 \
  docs/research/2026-09-30-extractbench-validation/development-continuation/enforce_runtime_cap.py \
  .scratch/extractbench-v2-development
```

The command requires the run's own `detached-processes.json` and `runner-started.json`,
verifies its live process command, refuses existing amendment records, and needs to
remain alive until the runner exits. It is already active for this run; do not
start a second timer or restart inference.
