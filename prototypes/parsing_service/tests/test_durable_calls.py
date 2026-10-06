"""Provider failures and persistence failures stop admission before compilation."""
import inspect
from dataclasses import asdict
from copy import deepcopy
from types import SimpleNamespace

import pytest

from kei_exp.kie.extract.calls import Call
from kei_exp.workflows import durable_extract as worker


@pytest.mark.parametrize("context", ["full", "bounded"])
def test_explicit_article_settings_are_frozen_and_restored_without_serializer_conflicts(monkeypatch,context):
    from kei_exp.kie.extract.models import ExtractModel
    monkeypatch.setitem(worker.EXTRACT_MODELS,"instruct",ExtractModel("instruct","fixture/model",
        "http://127.0.0.1:12345/v1/chat/completions","instruct",frozenset({"fields","reasoning"})))
    class Lease:
        state={"selection":{"schemaTree":{"recordDescription":"A document","recordScope":"document",
            "schemaNodes":[{"id":"title","name":"title","type":"string"}]},
            "resolved":{"options":{"strategy":"article","models":{"fields":"instruct","reasoning":"instruct"},
                "article":{"context":context,"context_tokens":8192},"start_page":2}}}}
        saved=None
        def call(self,routine,value):
            assert routine=="resolve_selection"
            if value is not None:
                assert self.saved is None
                self.saved={"configuration":deepcopy(value)}
            return deepcopy(self.saved)
    lease=Lease()
    request,router=worker.effective(lease)
    captured=deepcopy(lease.saved)
    assert request.options.article.context==context
    assert captured["configuration"]["options"]["article"]==request.options.article.model_dump()
    assert captured["configuration"]["options"]["start_page"]==2
    monkeypatch.delitem(worker.EXTRACT_MODELS,"instruct")
    resumed,resumed_router=worker.effective(lease)
    assert resumed.options.article==request.options.article
    assert resumed.options.start_page==2
    assert resumed_router.models==router.models=={"fields":"fixture/model","reasoning":"fixture/model"}
    assert lease.saved==captured


@pytest.mark.parametrize("checkpoint",[False,True])
def test_failed_reply_is_reported_failed_on_first_execution_and_saved_replay(monkeypatch,checkpoint):
    output={"parsed":None,"calls":[{"ok":False,"recovered":False}]}
    events=[]
    class Lease:
        def __init__(self,*_):pass
        def __enter__(self):return self
        def __exit__(self,*_):pass
        def call(self,routine,*args):
            events.append(routine)
            if routine=="read_call":return {"checkpoint":{"output":output} if checkpoint else None,"intent":"RUN",
                "input":{"digest":"fixed","request":{"composer":1,"provider":{},"budget":{},"body":{"httpRequest":{},"max_whitespace":1,"kind":"native"}}}}
            if routine=="begin_call":return True
    monkeypatch.setattr(worker,"Lease",Lease)
    monkeypatch.setattr(worker,"coordinator",lambda:None)
    monkeypatch.setattr(worker,"chat_for",lambda _:SimpleNamespace())
    provider=[]
    def structure(*_,**__):
        provider.append(True)
        return None,Call("entry",0,None,None,0,None,False,"bad reply")
    monkeypatch.setattr(worker.calls,"structure",structure)
    result=inspect.unwrap(worker.invoke_capture)("extraction","attempt","capture")
    assert result=={"ok":False,"capture":"capture"}
    assert provider==([] if checkpoint else [True])
    assert events==(["read_call"] if checkpoint else ["read_call","begin_call","commit_output"])


def test_returned_output_is_retried_then_halts_admission_without_claiming_saved(monkeypatch):
    events=[]
    class Lease:
        def __init__(self,*_):pass
        def __enter__(self):return self
        def __exit__(self,*_):pass
        def call(self,routine,*args):
            events.append(routine)
            if routine=="read_call":return {"checkpoint":None,"intent":"RUN","input":{"digest":"fixed",
                "request":{"composer":1,"provider":{},"budget":{},"body":{"kind":"native"}}}}
            if routine=="begin_call":return True
            if routine=="commit_output":raise OSError("disposable save fault")
    monkeypatch.setattr(worker,"Lease",Lease)
    monkeypatch.setattr(worker,"coordinator",lambda:None)
    monkeypatch.setattr(worker,"chat_for",lambda _:SimpleNamespace())
    monkeypatch.setattr(worker.calls,"structure",lambda *_,**__:({"flag":False},Call("entry",0,1,0,0,None,True)))
    with pytest.raises(RuntimeError,match="could not be saved"):
        inspect.unwrap(worker.invoke_capture)("extraction","attempt","capture")
    assert events==["read_call","begin_call","commit_output","commit_output","commit_output","fail_call"]


@pytest.mark.parametrize("checkpoint", [False, True])
def test_truncated_discovery_response_allows_the_planner_to_split_its_window(monkeypatch, checkpoint):
    call = Call("discovery", None, 20395, 4096, 0.1, "length", False,
                "the reply was cut off (finish_reason length)")
    output = {"parsed": None, "calls": [asdict(call)]}
    events = []
    class Lease:
        def __init__(self, *_): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def call(self, routine, *args):
            events.append(routine)
            if routine == "read_call":
                return {"checkpoint": {"output": output, "recoverable": True} if checkpoint else None, "intent": "RUN",
                        "input": {"digest": "fixed", "request": {"composer": 1, "provider": {},
                                  "budget": {"context": 32768, "counted": 20395},
                                  "body": {"stage": "discovery", "record": None, "httpRequest": {}}}}}
            if routine == "begin_call": return True
            if routine == "commit_output": return {"output": output, "recoverable": True}
    monkeypatch.setattr(worker, "Lease", Lease)
    monkeypatch.setattr(worker, "coordinator", lambda: None)
    monkeypatch.setattr(worker, "chat_for", lambda _: SimpleNamespace())
    monkeypatch.setattr(worker.calls, "complete", lambda *_, **__: (None, [call]))
    result = inspect.unwrap(worker.invoke_capture)("extraction", "attempt", "capture")
    assert result == {"ok": True, "capture": "capture"}
    assert events == (["read_call"] if checkpoint else ["read_call", "begin_call", "commit_output"])
