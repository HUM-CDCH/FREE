"""Fair-sharing probe: one kei-convert-like queue, 4 slots (= vLLM max-num-seqs), pages as workflows.
A starts a 60-page book; B then starts a 30-page book; C (and A itself) then add a 2-page small document.
Run once unpartitioned (plain priority+FIFO) and once partitioned by user with partition_concurrency == 4.
Run from a scratch directory (it writes fair-<mode>.sqlite there): uv run --with dbos==3.1.0 python fair_queue_probe.py fifo|partitioned"""
import json, random, sys, threading, time
from dbos import DBOS, DBOSConfig, SetEnqueueOptions

mode = sys.argv[1]  # "fifo" or "partitioned"
starts: list[tuple[float, str]] = []
lock = threading.Lock()
T0 = time.monotonic()

@DBOS.workflow()
def page(tag: str) -> str:
    with lock:
        starts.append((round(time.monotonic() - T0, 2), tag))
    time.sleep(random.uniform(0.15, 0.35))  # one OCR page
    return tag

def enq(user, doc, n, priority):
    hs = []
    for i in range(n):
        o = {"priority": priority}
        if mode == "partitioned":
            o["queue_partition_key"] = user
        with SetEnqueueOptions(**o):
            hs.append(DBOS.enqueue_workflow("kei-convert", page, f"{user}:{doc}:{i}"))
    return hs

DBOS(config=DBOSConfig(name=f"fair-{mode}", system_database_url=f"sqlite:///fair-{mode}.sqlite",
                       application_version="0.1.0", log_level="ERROR"))
DBOS.reset_system_database()
DBOS.launch()
kw = {"global_concurrency": 4, "worker_concurrency": 4, "polling_interval_sec": 0.05}
if mode == "partitioned":
    kw["partition_concurrency"] = 4  # partitions the queue without capping a lone user
DBOS.register_queue("kei-convert", **kw)

hs = enq("A", "book", 60, 10)
time.sleep(1.0)
t_b = time.monotonic() - T0
hs += enq("B", "book", 30, 10)
time.sleep(1.0)
t_small = time.monotonic() - T0
hs += enq("C", "small", 2, 1)
hs += enq("A", "small", 2, 1)
for h in hs:
    h.get_result()

def first(prefix):
    return next(t for t, tag in starts if tag.startswith(prefix))
def last(prefix):
    return max(t for t, tag in starts if tag.startswith(prefix))
both_end = min(last("A:book"), last("B:book"))  # while both books still had pages waiting
b_window = [tag.split(":")[0] for t, tag in starts if first("B:") <= t <= both_end and ":book:" in tag]
report = {
    "mode": mode,
    "B_enqueued_at": round(t_b, 2), "B_first_start": first("B:"),
    "book_starts_while_both_waiting": {u: b_window.count(u) for u in "AB"},
    "small_enqueued_at": round(t_small, 2),
    "C_small_first_start": first("C:small"), "A_small_first_start": first("A:small"),
    "total_s": round(starts[-1][0], 2),
}
print(json.dumps(report))
DBOS.destroy()
