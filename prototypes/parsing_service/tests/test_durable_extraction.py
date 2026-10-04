"""The real method algorithms yield at every call and replay saved responses.

This tier uses an in-memory implementation of the coordination contract and
scripted providers. PostgreSQL fencing and process recovery have separate tiers.
"""
from copy import deepcopy
from dataclasses import asdict
from uuid import uuid4

import pytest

from kei_exp.kie.extract import calls, run
from kei_exp.kie.extract.durable import Boundary, CapturePlanner, NeedsCall, digest
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.retained import publish_final, publish_values
from tests.test_extract_grounded import CountingChat, WordCounter, honest, request as recipe_request
from tests.test_extract_stages import SCHEMA, evidence, passages
from tests.test_unified_catalog import Model, evidence as unified_evidence, request as unified_request
from tests.helpers import catalogue


class Counter(WordCounter):
    context_tokens = 40000


def test_saved_composite_retains_rule_spans_without_claiming_whole_value_grounded():
    tree={"recordDescription":"A work", "schemaNodes":[{"id":"work", "name":"work", "type":"object",
        "children":[{"id":"title", "name":"title", "type":"string"}, {"id":"selected", "name":"selected", "type":"boolean"}]}]}
    lease=MemoryLease(tree)
    link={"path":["records",0,"work","title"], "segment":"p1_s1", "page":1,
          "bbox_pt":None, "verbatim":True, "hits":1, "linked_by":"key", "spans":[{"segment":"p1_s1","start":7,"end":11}],
          "alternatives":[], "provenance":"token", "key_spans":[{"segment":"p1_s1","start":0,"end":5}],
          "heading":None, "precision":"segment", "raw":"Book", "normalized":None}
    saved=publish_values(lease,{"work":{"title":"Book","selected":False}},"document",links=[link],complete=True)
    value=saved["values"][0]
    assert value["modelValue"] == {"title":"Book","selected":False}
    assert value["grounding"] == "ungrounded"
    assert value["processing"] == "saved"
    assert value["evidence"] == [{"anchorId":"a_p1_s1","occurrenceIds":[],"producer":link}]


class MemoryLease:
    def __init__(self, tree):
        self.attempt = str(uuid4())
        self.state = {"selection":{"id":str(uuid4()),"schemaRevisionId":str(uuid4()),"schemaTree":tree},
                      "generation": 1,
                      "source":{"generation":"g1","sourceRevisionId":str(uuid4())},
                      "effective":{"models":{role:{"model":"fake/extractor"} for role in ("fields","reasoning")}}}
        self.units, self.plans, self.publications = {}, {}, {}
        self.candidates, self.historical, self.intent = [], {}, "RUN"

    def call(self, name, *args):
        if name == "historical_coverage":
            return deepcopy(self.historical)
        if name == "publish_plan":
            _,stage,manifest=args
            if stage not in self.plans:
                if self.intent != "RUN":
                    return None
                self.plans[stage]={"digest":digest(manifest),"manifest":deepcopy(manifest)}
            assert self.plans[stage]["manifest"] == manifest
            return self.plans[stage]
        if name == "capture_unit":
            identity,key,descriptor=args
            if key not in self.units:
                if self.intent != "RUN":
                    return None
                self.units[key]={"id":identity,"descriptor":descriptor,"candidates":deepcopy(self.candidates),
                                 "input":None,"checkpoint":None}
                if descriptor.get("derivedFrom"):
                    parent=next(u for u in self.units.values() if u["id"]==descriptor["derivedFrom"])
                    self.units[key]["candidates"]=deepcopy(parent["candidates"])
            unit=self.units[key]
            if self.intent != "RUN" and unit["checkpoint"] is None:
                return None
            return deepcopy(unit)
        if name == "finalize_input":
            identity,request=args
            unit=next(u for u in self.units.values() if u["id"]==identity)
            if unit["input"] is None:
                unit["input"]={"digest":digest(request),"request":deepcopy(request)}
            assert unit["input"]["request"]==request
            return unit["input"]
        if name == "publish_snapshot":
            identity,selection,values,coverage=args
            saved={"values":deepcopy(values),"coverage":deepcopy(coverage)}
            assert selection==self.state["selection"]["id"]
            if identity in self.publications:
                assert self.publications[identity]==saved
            self.publications[identity]=saved
            return saved
        raise AssertionError(name)


def finish(lease, chat, extract):
    for _ in range(150):
        counter=Counter()
        planner=CapturePlanner(lease,{"fields":counter,"reasoning":counter})
        router=Router(chat,chat,planner)
        try:
            result=extract(router,counter)
        except NeedsCall:
            for unit in lease.units.values():
                if unit["id"] not in planner.pending:
                    continue
                body=dict(unit["input"]["request"]["body"])
                body.pop("max_whitespace")
                parsed,attempts=calls.complete(chat,**body,counter=counter)
                unit["checkpoint"]={"output":{"parsed":parsed,"calls":[asdict(call) for call in attempts]}}
        else:
            lease.state["recordScopes"]=planner.scopes
            publish_final(lease,result)
            return result
    raise AssertionError("method never completed")


@pytest.mark.parametrize("method",["article","generic","recipe","unified"])
def test_each_method_uses_call_checkpoints_and_retains_validated_values(tmp_path,method):
    if method == "unified":
        source=unified_evidence("1. Hill. Material: gold. Gilded. Find: bead (2)","2. Valley. Material: flint.")
        request=unified_request()
        chat=CountingChat(Model(source))
        extract=lambda router,counter: run.dispatch(None,source,request,router,counter=counter,chunks=2)
    elif method == "recipe":
        directory=catalogue.write("two-in-one-segment",tmp_path)
        request=recipe_request()
        chat=CountingChat(honest)
        extract=lambda router,counter: run.extract(directory,request,router,counter=counter,chunks=2)
    else:
        source=evidence(passages(["1. Hill 1827.","2. Valley 1828."]))
        request=run.ExtractRequest(schema=SCHEMA,options={"strategy":"article" if method=="article" else "catalog"})
        def answer(system,user,schema):
            if "record boundaries" in system:
                return {"starts":["B1","B2"],"end":None}
            if "### Claims" in user:
                return {key:{"label":"NONE","attribution":False} for key in schema["properties"]}
            return {"site":"Hill","year":1827}
        chat=CountingChat(answer)
        extract=lambda router,counter: run.dispatch(None,source,request,router,counter={"fields":counter,"reasoning":counter})
    chat.max_tokens=1024
    tree=request.schema_.model_dump(by_alias=True,exclude_none=True)
    lease=MemoryLease(tree)
    result=finish(lease,chat,extract)
    count=len(chat.calls)
    assert count>=2 and count==len(lease.units)
    assert lease.publications and all(u["input"] and u["checkpoint"] for u in lease.units.values())
    final=list(lease.publications.values())[-1]["coverage"]["finalizedAttempt"]
    assert final=={"attemptId":lease.attempt,"generation":1,"selectionId":lease.state["selection"]["id"],"complete":True}
    assert finish(lease,chat,extract)["records"]==result["records"]
    assert len(chat.calls)==count


@pytest.mark.parametrize("complete", [True, False])
def test_empty_final_publication_saves_completion_proof_without_inventing_values(complete):
    lease=MemoryLease({"recordDescription":"document","schemaNodes":[]})
    publish_final(lease,{"records":[],"completeness":{"processing":complete}})
    final=next(iter(lease.publications.values()))
    assert final["values"]==[]
    assert final["coverage"]["finalizedAttempt"]["complete"] is complete


def test_capture_freezes_guidance_before_provider_and_pause_refuses_new_units():
    node={"id":"field","name":"title","type":"string"}
    lease=MemoryLease({"recordDescription":"document","schemaNodes":[node]})
    candidate={"id":"correction","fieldId":"field","meaning":digest({"type":"string"}),
               "value":"corrected without Evidence","grounded":False,"node":node}
    lease.candidates=[{"id":"revision","candidate":candidate}]
    chat=CountingChat(lambda *_:{"title":"target"});chat.max_tokens=10
    args=dict(stage="record",record=0,system="Read target only",user="source",schema={"type":"object"})
    with pytest.raises(NeedsCall):
        CapturePlanner(lease,{"fields":Counter()}).complete(chat,**args)
    unit=next(iter(lease.units.values()));captured=deepcopy(unit["input"])
    assert captured["request"]["examples"]==[candidate]
    lease.candidates=[]
    with pytest.raises(NeedsCall):
        CapturePlanner(lease,{"fields":Counter()}).complete(chat,**args)
    assert unit["input"]==captured and not chat.calls
    lease.intent="PAUSE"
    with pytest.raises(Boundary):
        CapturePlanner(lease,{"fields":Counter()}).complete(chat,**{**args,"user":"new source"})


@pytest.mark.parametrize("oversized", [False, True])
def test_article_reply_allocation_protects_its_floor_and_selects_guidance(oversized):
    from kei_exp.kie.extract.durable import field_meaning
    from kei_exp.kie.extract.schema import Schema
    from kei_exp.kie.extract.stages import REPLY_TOKENS, extract_record
    node={"id":"title","name":"title","type":"string"}
    tree={"recordDescription":"The whole document","schemaNodes":[node]}
    lease=MemoryLease(tree)
    candidate={"id":"correction","fieldId":"title","meaning":field_meaning(node),"node":node,
               "value":"guidance "*(50000 if oversized else 1),"grounded":False}
    lease.candidates=[{"id":"correction","candidate":candidate}]
    counter=Counter()
    chat=CountingChat(lambda *_:{"title":"target source"})
    def plan():
        return extract_record(passages(["target source"]),Schema.model_validate(tree),
            Router(fields=chat,reasoning=chat,runtime=CapturePlanner(lease,{"fields":counter})),
            budget=48000,counter=counter,document=True)
    with pytest.raises(NeedsCall):
        plan()
    captured=deepcopy(next(iter(lease.units.values()))["input"])
    request=captured["request"]
    assert request["examples"]==([] if oversized else [candidate])
    assert request["omissions"]==([{"id":"correction","reason":"budget"}] if oversized else [])
    assert request["budget"]["reserve"]>=REPLY_TOKENS
    assert request["budget"]["counted"]+request["budget"]["reserve"]==counter.context_tokens
    assert request["body"]["max_tokens"]==request["budget"]["reserve"]
    assert "target source" in request["body"]["user"] and not chat.calls
    lease.candidates=[]
    with pytest.raises(NeedsCall):
        plan()
    assert next(iter(lease.units.values()))["input"]==captured


def test_replanning_subtracts_only_fixed_primary_coverage_and_keeps_offsets():
    source=unified_evidence("first entry; second entry")
    lease=MemoryLease({"recordDescription":"entry","schemaNodes":[]})
    primary=[{"segment":"p1_s0","start":0,"end":12}]
    lease.historical={"manifest":{"coverage":{"reprocessValueIds":[]}},
                      "snapshot":{"values":[],"coverage":{"completedScopes":{"unit":{"scope":primary,"primary":primary}}}}}
    planner=CapturePlanner(lease)
    changed=planner.filter_evidence(source)
    assert changed.passages[0].text==" "*12+source.passages[0].text[12:]
    lease.historical["snapshot"]["coverage"]["completedScopes"]={}
    assert planner.filter_evidence(source)==changed  # replay uses the pinned copy


def test_format_fallback_is_a_separate_capture_with_the_original_input():
    from kei_exp.kie.extract.llm import OpenAIChat
    lease=MemoryLease({"recordDescription":"document","schemaNodes":[]})
    chat=OpenAIChat(model="fake/extractor",max_tokens=10)
    args=dict(stage="record",record=0,system="fixed instructions",user="fixed source",schema={"type":"object"})
    with pytest.raises(NeedsCall):
        CapturePlanner(lease,{"fields":Counter()}).complete(chat,**args)
    parent=next(iter(lease.units.values()))
    parent["checkpoint"]={"outputDigest":"refusal","output":{"formatRefused":True,"parsed":None,
      "calls":[asdict(calls.Call("record",0,None,None,0.0,None,False,"format refused",recovered=True))]}}
    lease.candidates=[{"id":"new correction that must not recompose the fallback"}]
    with pytest.raises(NeedsCall):
        CapturePlanner(lease,{"fields":Counter()}).complete(chat,**args)
    fallback=list(lease.units.values())[1]
    before=deepcopy(parent["input"]["request"])
    before["body"]["httpRequest"].pop("response_format")
    assert fallback["input"]["request"]==before
    assert fallback["descriptor"]["derivedFrom"]==parent["id"]


def test_native_input_captures_schema_guidance_without_adding_source_facts(monkeypatch):
    from kei_exp.kie.extract.gliformer import GLiFormerFields, NativeCounter
    node={"id":"field","name":"title","type":"string"}
    lease=MemoryLease({"recordDescription":"document","schemaNodes":[node]})
    lease.candidates=[{"id":"revision","candidate":{"id":"example","fieldId":"field","meaning":digest({"type":"string"}),
      "value":"corrected pattern","grounded":False,"node":node}}]
    info={"identity":{"model":"native-v1"},"max_input_tokens":10000}
    backend=GLiFormerFields("http://unused",pinned_info=info)
    monkeypatch.setattr(NativeCounter,"request_tokens",lambda self,s,u,schema:len(u)+len(str(schema)))
    planner=CapturePlanner(lease)
    with pytest.raises(NeedsCall):
        planner.structure(backend,record=0,text="target source only",schema={"record":{"fields":["title"],"children":{},"description":"document"}},
                          identity=info["identity"],counted=100,context=10000)
    request=next(iter(lease.units.values()))["input"]["request"]
    assert request["body"]["text"]=="target source only"
    assert request["examples"][0]["grounded"] is False
    assert "corrected pattern" in request["body"]["schema"]["record"]["description"]


def test_article_adoption_keeps_old_contributions_and_emits_explicit_lineage():
    from kei_exp.kie.extract.retained import publish_values
    tree={"recordDescription":"document","schemaNodes":[{"id":"title","name":"title","type":"string"},
      {"id":"authors","name":"authors","type":"array","itemType":"string"}]}
    lease=MemoryLease(tree)
    before=publish_values(lease,{"title":"Saved title","authors":["Alice"]},"document",complete=True)
    historical={"id":"snapshot-old","values":before["values"],"coverage":{}}
    lease.historical={"manifest":{"coverage":{"reprocessValueIds":[]}},"snapshot":historical}
    lease.state["selection"]["id"]=str(uuid4())
    after=publish_values(lease,{"title":None,"authors":["Bob"]},"document",complete=True)
    assert [v["fieldId"] for v in after["values"]]==["authors"]
    assert after["values"][0]["modelValue"]==["Alice","Bob"]
    assert after["values"][0]["lineage"]==["snapshot-old:"+historical["values"][1]["id"]]
    assert historical["values"][0]["modelValue"]=="Saved title"


def test_failed_primary_record_remains_eligible_for_adoption():
    from kei_exp.kie.extract.retained import publish_values
    lease=MemoryLease({"recordDescription":"entry","schemaNodes":[{"id":"name","name":"name","type":"string"}]})
    saved=publish_values(lease,{"name":"partial"},[{"segment":"p1_s0","start":0,"end":10}],primary=[])
    assert saved["values"][0]["processing"]=="saved"
    assert saved["coverage"]["completedScopes"]=={}


def test_completed_document_fields_are_carried_without_another_call():
    from kei_exp.kie.extract.retained import publish_values,document_inputs
    from kei_exp.kie.extract.schema import Schema
    node={"id":"doc","name":"title","type":"string","valueSource":"document"}
    lease=MemoryLease({"recordDescription":"entry","schemaNodes":[node,{"id":"item","name":"name","type":"string"}]})
    saved=publish_values(lease,{"title":"Document title"},"document-fields",complete=True,field_ids={"doc"})
    lease.historical={"manifest":{"coverage":{}},"snapshot":{"values":saved["values"],"coverage":saved["coverage"]}}
    router=Router(CountingChat(lambda *_:{}),CountingChat(lambda *_:{}),CapturePlanner(lease))
    remaining,carried=document_inputs(router,Schema.model_validate(lease.state["selection"]["schemaTree"]))
    assert not remaining.document_nodes
    assert carried=={"title":"Document title"}


def test_renamed_composites_carry_typed_children_and_keep_conflicting_proposals():
    from kei_exp.kie.extract.retained import publish_values
    from kei_exp.kie.extract.durable import field_meaning
    old_node={"id":"person","name":"person","type":"object","children":[{"id":"Z","name":"name","type":"string"},{"id":"a","name":"age","type":"integer"}]}
    lease=MemoryLease({"recordDescription":"entry","schemaNodes":[old_node]})
    before=publish_values(lease,{"person":{"name":"Alice","age":None}},"document",complete=True)
    renamed={**old_node,"children":[{**old_node["children"][1],"name":"years"},{**old_node["children"][0],"name":"full_name"}]}
    assert field_meaning(old_node)==field_meaning(renamed)
    assert field_meaning(old_node)=="f9283904936a43435df32890e041320ea421d6b269ae281ca876ebc11e659626"
    lease.state["selection"]["schemaTree"]["schemaNodes"]=[renamed]
    lease.historical={"manifest":{"coverage":{}},"snapshot":{"id":"earlier","values":before["values"]}}
    after=publish_values(lease,{"person":{"full_name":"Bob","years":30}},"document",complete=True)
    assert after["values"][0]["modelValue"]=={"full_name":"Alice","years":30}
    assert after["coverage"]["historicalProposals"][before["values"][0]["id"]]["conflicts"]==[{"path":["Z"],"historical":"Alice","proposed":"Bob"}]
    assert before["values"][0]["modelValue"]=={"name":"Alice","age":None}
