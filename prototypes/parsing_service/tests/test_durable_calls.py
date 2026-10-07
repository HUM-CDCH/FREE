"""Provider failures and persistence failures stop admission before compilation."""
import inspect
import json
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


class Streamed:
    """A provider's server-sent reply: one data line per piece, then the finish, the usage and [DONE]."""
    status_code = 200
    text = ""
    headers = {"content-type": "text/event-stream; charset=utf-8"}

    def __init__(self, reply, *, size=7, prompt=120):
        pieces = [reply[at:at + size] for at in range(0, len(reply), size)]
        self.lines = [f"data: {json.dumps({'choices': [{'delta': {'content': piece}, 'finish_reason': None}]})}".encode()
                      for piece in pieces]
        self.lines += [b"", f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]})}".encode(),
                       f"data: {json.dumps({'choices': [], 'usage': {'prompt_tokens': prompt, 'completion_tokens': 40}})}".encode(),
                       b"data: [DONE]"]

    def __enter__(self): return self
    def __exit__(self, *_): pass
    def raise_for_status(self): pass
    def iter_lines(self): return iter(self.lines)


REPLY = '{"places":[["L1","record","1"],["L2","record","2","Valley\\tfinds"]],"begins_inside_record":false,"ends_inside_record":false}'


def test_streamed_places_are_only_the_closed_ones():
    from kei_exp.kie.extract.discovery import StreamedPlaces
    places, completed = StreamedPlaces(), []
    for at in range(0, len(REPLY), 5):
        if places.feed(REPLY[at:at + 5]):
            completed.append(len(places.places))
    assert places.places == json.loads(REPLY)["places"]
    assert completed == [1, 2]


def test_discovery_reply_streams_its_places_and_saves_the_unstreamed_output(monkeypatch):
    from kei_exp.kie.extract import captured_provider
    posted, shown, committed = [], [], {}
    def post(url, json, timeout, stream=False):
        posted.append((url, json, stream))
        return Streamed(REPLY)
    monkeypatch.setattr(captured_provider.requests, "post", post)
    monkeypatch.setattr(worker, "show", lambda key, value: shown.append((key, deepcopy(value))))
    saved_request = {"model": "fixture/model", "messages": [{"role": "user", "content": "[L1] 1. Hill"}]}
    class Lease:
        def __init__(self, *_): pass
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def call(self, routine, *args):
            if routine == "read_call":
                return {"checkpoint": None, "intent": "RUN", "input": {"digest": "fixed", "request": {"composer": 1,
                    "provider": {"url": "http://model/v1/chat/completions", "timeout": 5, "model": "fixture/model",
                                 "adapter": "instruct", "adapterVersion": 1, "maxTokens": 4096},
                    "budget": {"context": 32768, "counted": 120, "reserve": 4096},
                    "body": {"stage": "discovery", "record": None, "system": "s", "user": "u", "schema": {},
                             "max_tokens": 4096, "max_whitespace": None, "httpRequest": deepcopy(saved_request)}}}}
            if routine == "begin_call": return True
            if routine == "commit_output":
                committed["output"] = args[2]
                return {"output": args[2]}
    monkeypatch.setattr(worker, "Lease", Lease)
    monkeypatch.setattr(worker, "coordinator", lambda: None)
    result = inspect.unwrap(worker.invoke_capture)("extraction", "attempt", "capture")
    assert result == {"ok": True, "capture": "capture"}
    # Only the transport asks for the stream: the saved request is otherwise sent as it was captured.
    assert posted == [("http://model/v1/chat/completions", {**saved_request, "stream": True,
                       "stream_options": {"include_usage": True}}, True)]
    assert committed["output"]["parsed"] == json.loads(REPLY)
    assert committed["output"]["calls"][0] | {"seconds": 0} == asdict(Call("discovery", None, 120, 40, 0, "stop", True,
                                                                         None, 120, 32768, 4096))
    assert shown[-1] == ("places", json.loads(REPLY)["places"])


def test_a_server_that_ignores_the_stream_is_read_as_the_unstreamed_reply(monkeypatch):
    from kei_exp.kie.extract import captured_provider
    class Whole(Streamed):
        headers = {"content-type": "application/json"}
        def json(self):
            return {"choices": [{"message": {"content": REPLY}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 120, "completion_tokens": 40}}
    monkeypatch.setattr(captured_provider.requests, "post", lambda *_, **__: Whole(REPLY))
    pieces = []
    reply = captured_provider.CapturedChat({"url": "http://model", "timeout": 5, "model": "m"}, {}, on_text=pieces.append).complete()
    assert (reply.text, reply.finish, reply.input_tokens, pieces) == (REPLY, "stop", 120, [])
