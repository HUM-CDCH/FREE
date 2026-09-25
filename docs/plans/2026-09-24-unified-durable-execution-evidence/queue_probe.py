import json, threading, time
from urllib.parse import urlparse
from dbos import DBOS, DBOSConfig, SetWorkflowID
url='postgresql://postgres:review-disposable-only@127.0.0.1:5432/free_test_dbos_review'
p=urlparse(url)
assert p.hostname=='127.0.0.1' and p.port==5432 and p.username=='postgres' and p.path.startswith('/free_test_')
started=threading.Event(); events=[]; release=threading.Event()
@DBOS.step()
def native(tag):
    events.append((tag,'start',time.monotonic()))
    if tag=='cancelled':
        started.set()
        assert release.wait(10)
    events.append((tag,'end',time.monotonic()))
    return tag
@DBOS.workflow()
def work(tag): return native(tag)
DBOS(config=DBOSConfig(name='queue-review',system_database_url=url,dbos_system_schema='queue_probe',application_version='queue@1',executor_id='queue-review',log_level='ERROR'))
DBOS.launch()
q=DBOS.register_queue('kei-probe',concurrency=1,worker_concurrency=1,polling_interval_sec=0.1)
with SetWorkflowID('blocked'): h=q.enqueue(work,'cancelled')
assert started.wait(10)
DBOS.cancel_workflow('blocked')
with SetWorkflowID('following'): nxt=q.enqueue(work,'following')
time.sleep(0.8)
print('WHILE_CANCELLED_STEP_BLOCKED',json.dumps({'events':events,'next_status':nxt.get_status().status}))
assert not any(e[0]=='following' for e in events)
release.set()
print('NEXT_RESULT',nxt.get_result())
print('NO_OVERLAP',json.dumps(events))
DBOS.destroy()
