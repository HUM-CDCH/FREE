"""M0R item 4: kei lanes on DBOS Python 3.1.0.

Runs `phase1` (lanes, cancellation, priority, deadlines, database-clock stamps,
first half of the boot boundary; ends by SIGKILLing itself) and then `phase2`
(a restarted kei process; second half of the boot boundary).

Usage: M0R_DB_URL=postgresql://...@127.0.0.1:5432/free_test_m0r_kei \
  uv run --no-project --python 3.13 --with 'dbos==3.1.0' python kei_lanes.py
"""

import contextlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Callable, Optional
from urllib.parse import urlparse

import sqlalchemy as sa
from dbos import DBOS, DBOSConfig, SetEnqueueOptions, SetWorkflowID, SetWorkflowTimeout

URL = os.environ["M0R_DB_URL"]
_u = urlparse(URL)
assert _u.hostname == "127.0.0.1" and _u.port == 5432 and _u.path.startswith("/free_test_m0r_"), "disposable DB only"
ENGINE = sa.create_engine(URL.replace("postgresql://", "postgresql+psycopg://", 1))
LANES = {  # name: (global, worker)
    "kei-convert-large": (1, 1),
    "kei-convert-small": (1, 1),
    "kei-extract": (2, 2),
    "kei-gc": (1, 1),
}
POLL = 0.1  # seconds; shortened for the probe
EVENTS: list[tuple[str, str, float]] = []
_LOCK = threading.Lock()
_RELEASE: dict[str, threading.Event] = {}
QUEUES: dict[str, Any] = {}


def out(event: str, data: Any) -> None:
    print(f"RESULT {event} {json.dumps(data, default=str)}", flush=True)


def log(tag: str, what: str) -> None:
    with _LOCK:
        EVENTS.append((tag, what, time.monotonic()))


def ev(tag: str, what: str) -> Optional[float]:
    with _LOCK:
        for t, w, at in EVENTS:
            if t == tag and w == what:
                return at
    return None


def release(tag: str) -> threading.Event:
    with _LOCK:
        return _RELEASE.setdefault(tag, threading.Event())


def db_now() -> float:
    with ENGINE.connect() as c:
        return float(c.execute(sa.text("select extract(epoch from clock_timestamp())*1000")).scalar_one())


def row(wid: str) -> Optional[dict[str, Any]]:
    with ENGINE.connect() as c:
        r = c.execute(
            sa.text(
                "select status, updated_at, started_at_epoch_ms, workflow_deadline_epoch_ms, workflow_timeout_ms,"
                " priority, created_at, queue_name from dbos.workflow_status where workflow_uuid=:w"
            ),
            {"w": wid},
        ).mappings().first()
        return dict(r) if r else None


def wait_until(pred: Callable[[], Any], timeout: float, what: str) -> Any:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        v = pred()
        if v:
            return v
        time.sleep(0.005)
    raise TimeoutError(what)


@DBOS.step()
def native(tag: str, hold_sec: float) -> str:
    # A native-like blocking call: plain time.sleep in the step's thread, which
    # DBOS cannot interrupt. It exits when released or when hold_sec elapses.
    log(tag, "start")
    end = time.monotonic() + hold_sec
    flag = release(tag)
    while time.monotonic() < end and not flag.is_set():
        time.sleep(0.02)
    log(tag, "end")
    return tag


@DBOS.workflow(name="kei_job")
def kei_job(tag: str, hold_sec: float) -> str:
    return native(tag, hold_sec)


def enqueue(lane: str, tag: str, hold: float, timeout: Optional[float] = None, priority: Optional[int] = None) -> None:
    with contextlib.ExitStack() as stack:
        stack.enter_context(SetWorkflowID(tag))
        if timeout is not None:
            stack.enter_context(SetWorkflowTimeout(timeout))
        if priority is not None:
            stack.enter_context(SetEnqueueOptions(priority=priority))
        QUEUES[lane].enqueue(kei_job, tag, hold)


def result(tag: str, timeout: float = 20) -> Any:
    wait_until(lambda: (row(tag) or {}).get("status") in ("SUCCESS", "ERROR", "CANCELLED"), timeout, f"{tag} terminal")
    return row(tag)["status"]


def launch(boot_label: str) -> float:
    # The kei boot boundary: read the database clock after the flock (the
    # previous process has exited) and before DBOS.launch().
    boot_ts = db_now()
    DBOS(
        config=DBOSConfig(
            name="kei",
            system_database_url=URL,
            application_version="kei@1",
            executor_id="kei-worker-0",
            log_level="ERROR",
        )
    )
    DBOS.launch()
    for name, (g, w) in LANES.items():
        QUEUES[name] = DBOS.register_queue(name, global_concurrency=g, worker_concurrency=w, polling_interval_sec=POLL)
    QUEUES["ctrl-global-only"] = DBOS.register_queue("ctrl-global-only", global_concurrency=1, polling_interval_sec=POLL)
    out("launched", {"phase": boot_label, "bootTimestampMs": boot_ts})
    return boot_ts


def other_lanes_run(busy: str, label: str) -> dict[str, float]:
    """Enqueue a quick job on every other lane and time it to completion."""
    t0 = time.monotonic()
    tags = {lane: f"{label}-other-{lane}" for lane in LANES if lane != busy}
    for lane, tag in tags.items():
        enqueue(lane, tag, 0.05)
    done = {}
    for lane, tag in tags.items():
        assert result(tag, 10) == "SUCCESS", tag
        done[lane] = round(time.monotonic() - t0, 2)
    return done


def cancel_case(lane: str, mode: str, queue: Optional[str] = None) -> dict[str, Any]:
    q = queue or lane
    cap = LANES.get(q, (1, 1))[1]
    label = f"{q}-{mode}"
    blockers = [f"{label}-b{i}" for i in range(cap)]
    for b in blockers:
        enqueue(q, b, 60)
    victim = blockers[0]
    if mode == "claim":
        wait_until(lambda: (row(victim) or {}).get("status") == "PENDING", 10, "claim")
    else:
        wait_until(lambda: all(ev(b, "start") for b in blockers), 10, "all blockers started")
        time.sleep(0.3)
    step_started_at_cancel = ev(victim, "start") is not None
    DBOS.cancel_workflow(victim)
    follower = f"{label}-f"
    enqueue(q, follower, 0.05)
    t_follower = time.monotonic()
    others = other_lanes_run(q, label) if queue is None else {}
    time.sleep(max(0.0, t_follower + 1.5 - time.monotonic()))
    victim_step_running = ev(victim, "start") is not None and ev(victim, "end") is None
    follower_while_blocked = {"status": row(follower)["status"], "started": ev(follower, "start") is not None}
    release(victim).set()
    wait_until(lambda: ev(victim, "end") is not None or ev(victim, "start") is None, 10, "victim end")
    wait_until(lambda: ev(follower, "end"), 20, "follower end")
    for b in blockers[1:]:
        release(b).set()
    for b in blockers[1:]:
        result(b)
    v_end = ev(victim, "end")
    f_start = ev(follower, "start")
    return {
        "lane": q,
        "mode": mode,
        "victimStepStartedBeforeCancel": step_started_at_cancel,
        "victimStepRunningAt1.5s": victim_step_running,
        "victimStatus": row(victim)["status"],
        "followerWhileVictimStepBlocked": follower_while_blocked,
        "followerStartedAfterVictimStepExit": (v_end is None) or (f_start is not None and f_start >= v_end),
        "followerStartLagAfterVictimExitMs": None if v_end is None else round((f_start - v_end) * 1000),
        "otherLanesCompletedSec": others,
    }


def phase1(state_file: str) -> None:
    boot1 = launch("phase1")
    results: dict[str, Any] = {}

    # 1. Cancel right after claim and mid-step, on every lane.
    for lane in LANES:
        for mode in ("claim", "mid"):
            r = cancel_case(lane, mode)
            out("lane-cancel", r)
            if r["victimStepRunningAt1.5s"]:
                assert r["followerWhileVictimStepBlocked"] == {"status": "ENQUEUED", "started": False}, r
            assert r["followerStartedAfterVictimStepExit"], r
            assert all(v < 3 for v in r["otherLanesCompletedSec"].values()), r
    # Negative control: global limit only (no worker limit).
    ctrl = cancel_case("ctrl-global-only", "mid", queue="ctrl-global-only")
    out("control-global-only", ctrl)

    # 2. Priority 1 before 10, FIFO ties, on kei-extract.
    b = ["prio-b0", "prio-b1"]
    for t in b:
        enqueue("kei-extract", t, 60)
    wait_until(lambda: all(ev(t, "start") for t in b), 10, "prio blockers")
    order_in = [("prio-10a", 10), ("prio-10b", 10), ("prio-1a", 1), ("prio-10c", 10), ("prio-1b", 1)]
    for tag, p in order_in:
        enqueue("kei-extract", tag, 0.1, priority=p)
        time.sleep(0.02)
    release("prio-b0").set()  # one slot free; the other stays held
    for tag, _ in order_in:
        result(tag)
    started = sorted((ev(tag, "start"), tag) for tag, _ in order_in)
    order = [t for _, t in started]
    out("priority", {"enqueued": [t for t, _ in order_in], "startOrder": order})
    assert order == ["prio-1a", "prio-1b", "prio-10a", "prio-10b", "prio-10c"], order

    # 3. Dequeue-relative deadline on kei-extract: time spent ENQUEUED does not
    #    count. prio-b1 still holds one slot; dl-fill takes the other.
    enqueue("kei-extract", "dl-fill", 60)
    wait_until(lambda: ev("dl-fill", "start"), 10, "dl-fill start")
    enqueue("kei-extract", "dl-queued", 0.5, timeout=2.0)
    time.sleep(3.5)
    queued_row = row("dl-queued")
    release("dl-fill").set()
    dl_status = result("dl-queued", 20)
    final = row("dl-queued")
    rec = {
        "whileQueuedPastTimeout": {k: queued_row[k] for k in ("status", "workflow_timeout_ms", "workflow_deadline_epoch_ms")},
        "finalStatus": dl_status,
        "deadlineMinusStartMs": final["workflow_deadline_epoch_ms"] - final["started_at_epoch_ms"] if final["workflow_deadline_epoch_ms"] else None,
    }
    out("extract-deadline-dequeue-relative", rec)
    assert queued_row["status"] == "ENQUEUED" and queued_row["workflow_deadline_epoch_ms"] is None and dl_status == "SUCCESS", rec
    release("prio-b1").set()
    result("prio-b1")
    result("dl-fill")

    # 4. Deadlines expiring mid-step on every model lane; stamp from DB clock;
    #    the slot stays held until the native step exits.
    for lane in ("kei-convert-large", "kei-convert-small", "kei-extract"):
        cap = LANES[lane][1]
        fillers = [f"dl-{lane}-fill{i}" for i in range(cap - 1)]
        for f in fillers:
            enqueue(lane, f, 60)
        tag = f"dl-{lane}"
        enqueue(lane, tag, 4.0, timeout=1.0)
        wait_until(lambda: ev(tag, "start"), 10, "deadline job start")
        before = db_now()
        wait_until(lambda: row(tag)["status"] == "CANCELLED", 10, "deadline cancel")
        after = db_now()
        r = row(tag)
        follower = f"{tag}-f"
        enqueue(lane, follower, 0.05)
        time.sleep(0.8)
        f_while = {"status": row(follower)["status"], "started": ev(follower, "start") is not None}
        wait_until(lambda: ev(follower, "end"), 20, "deadline follower")
        for f in fillers:
            release(f).set()
            result(f)
        rec = {
            "lane": lane,
            "status": r["status"],
            "timeoutMs": r["workflow_timeout_ms"],
            # Cancel clears started_at_epoch_ms but keeps the deadline.
            "deadlineMinusEnqueueMs": r["workflow_deadline_epoch_ms"] - r["created_at"],
            "cancelStampAfterDeadlineMs": r["updated_at"] - r["workflow_deadline_epoch_ms"],
            "updatedAtWithinDbClockWindow": before <= r["updated_at"] <= after + 1,
            "followerWhileStepBlocked": f_while,
            "followerStartedAfterStepExit": ev(follower, "start") >= ev(tag, "end"),
        }
        out("lane-deadline", rec)
        assert rec["followerStartedAfterStepExit"] and rec["updatedAtWithinDbClockWindow"], rec

    # 5. Python-side cancel stamps updated_at from the database clock, even with
    #    Python's clock skewed by +1 h during the call; and a repeated cancel.
    enqueue("kei-gc", "clock-cancel", 60)
    wait_until(lambda: ev("clock-cancel", "start"), 10, "clock-cancel start")
    before = db_now()
    real_time = time.time
    time.time = lambda: real_time() + 3600  # type: ignore[assignment]
    try:
        DBOS.cancel_workflow("clock-cancel")
    finally:
        time.time = real_time  # type: ignore[assignment]
    after = db_now()
    first = row("clock-cancel")["updated_at"]
    time.sleep(0.2)
    DBOS.cancel_workflow("clock-cancel")
    second = row("clock-cancel")["updated_at"]
    release("clock-cancel").set()
    wait_until(lambda: ev("clock-cancel", "end"), 10, "clock-cancel end")
    out(
        "cancel-clock",
        {
            "updatedAtWithinDbClockWindow": before <= first <= after + 1,
            "pythonClockSkewSec": 3600,
            "repeatCancelAdvancesUpdatedAtMs": second - first,
        },
    )
    assert before <= first <= after + 1

    # 6. Boot boundary, first half: cancel a blocked kei-gc step, then die.
    enqueue("kei-gc", "boot-victim", 600)
    wait_until(lambda: ev("boot-victim", "start"), 10, "boot-victim start")
    DBOS.cancel_workflow("boot-victim")
    upd = row("boot-victim")["updated_at"]
    eligible = upd < boot1
    out("boot-boundary-before-restart", {"bootTimestampMs": boot1, "updatedAt": upd, "eligibleForDeleteRuns": eligible, "stepStillRunning": ev("boot-victim", "end") is None})
    assert not eligible
    with open(state_file, "w") as f:
        json.dump({"boot1": boot1, "updatedAt": upd}, f)
    sys.stdout.flush()
    os.kill(os.getpid(), signal.SIGKILL)


def phase2(state_file: str) -> None:
    with open(state_file) as f:
        state = json.load(f)
    boot2 = launch("phase2")
    time.sleep(2.0)  # let startup recovery run
    r = row("boot-victim")
    eligible = r["updated_at"] < boot2
    out(
        "boot-boundary-after-restart",
        {
            "bootTimestampMs": boot2,
            "status": r["status"],
            "updatedAtUnchanged": r["updated_at"] == state["updatedAt"],
            "eligibleForDeleteRuns": eligible,
            "stepRerunAfterRestart": ev("boot-victim", "start") is not None,
        },
    )
    assert r["status"] == "CANCELLED" and eligible and r["updated_at"] == state["updatedAt"]
    DBOS.destroy()


if __name__ == "__main__":
    if len(sys.argv) > 2:
        {"phase1": phase1, "phase2": phase2}[sys.argv[1]](sys.argv[2])
        sys.exit(0)
    with tempfile.TemporaryDirectory() as d:
        state = os.path.join(d, "state.json")
        p1 = subprocess.run([sys.executable, __file__, "phase1", state])
        out("phase1-exit", {"returncode": p1.returncode, "killedBySIGKILL": p1.returncode == -signal.SIGKILL})
        assert p1.returncode == -signal.SIGKILL, "phase1 must end by SIGKILL after its checks"
        p2 = subprocess.run([sys.executable, __file__, "phase2", state])
        out("phase2-exit", {"returncode": p2.returncode})
        sys.exit(p2.returncode)
