"""Provider failures and persistence failures stop admission before compilation."""
import inspect
from types import SimpleNamespace

import pytest

from kei_exp.kie.extract.calls import Call
from kei_exp.workflows import durable_extract as worker


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
