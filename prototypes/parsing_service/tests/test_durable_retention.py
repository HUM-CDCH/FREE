from types import SimpleNamespace
import pytest
from kei_exp.workflows.durable_extract import delete_quiescent_history

GRAPH={"attempts":[{"id":"old","workflowId":"root-old"},{"id":"new","workflowId":"root-new"}],"captures":[{"id":"capture"}]}
IDS=["root-old","root-new","kei-call:old:capture","kei-call:new:capture"]

@pytest.mark.parametrize("state,updated,expected",[("PENDING",None,False),("ENQUEUED",None,False),("CANCELLED",100,False),("CANCELLED",99,True),("MAX_RECOVERY_ATTEMPTS_EXCEEDED",100,False),("SUCCESS",None,True),("ERROR",None,True)])
def test_native_history_waits_for_all_linked_calls_and_the_worker_boot_boundary(state,updated,expected):
    deleted=[]
    def statuses(ids):
        assert ids==IDS
        return [SimpleNamespace(workflow_id=id,status=state if id==IDS[2] else "SUCCESS",updated_at=updated) for id in ids]
    assert delete_quiescent_history(GRAPH,100,statuses,deleted.extend) is expected
    assert deleted==(IDS if expected else [])


def test_failed_status_read_deletes_no_history():
    deleted=[]
    def failed(ids):
        raise OSError("database unavailable")
    with pytest.raises(OSError):
        delete_quiescent_history(GRAPH,100,failed,deleted.extend)
    assert deleted==[]
