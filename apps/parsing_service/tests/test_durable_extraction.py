"""The real method algorithms yield at every call and replay saved responses.

This tier uses an in-memory implementation of the coordination contract and
scripted providers. PostgreSQL fencing and process recovery have separate tiers.
"""
from copy import deepcopy
from dataclasses import asdict
from uuid import uuid4

import pytest

from kei_exp.kie.extract import calls, run, unified
from kei_exp.kie.extract.durable import Boundary, CapturePlanner, NeedsCall, digest
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract import retained
from kei_exp.workflows import durable_extract as worker
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


def linked_while_running(lease):
    """Each value's Evidence as published before, and with, the final publication."""
    linked=lambda complete: {value["id"]:value["evidence"] for publication in lease.publications.values()
        if publication["coverage"].get("processingComplete") is complete for value in publication["values"] if value["evidence"]}
    return linked(False),linked(True)


def test_unified_entry_publishes_its_final_evidence_before_the_run_finishes():
    source=unified_evidence("1. Hill. Material: gold. Gilded. Find: bead (2)","2. Valley. Material: flint.")
    request=unified_request()
    lease=MemoryLease(request.schema_.model_dump(by_alias=True,exclude_none=True))
    finish(lease,CountingChat(Model(source)),lambda router,counter: run.dispatch(None,source,request,router,counter=counter))
    running,final=linked_while_running(lease)
    assert running and running.items() <= final.items()
    # Shown, not yet settled: adopting revised inputs still re-reads a record the run had not finished (filter_evidence).
    assert {value["grounding"] for publication in lease.publications.values() if publication["coverage"].get("processingComplete") is False
            for value in publication["values"]} == {"provisional"}


def test_a_record_shown_before_the_run_finished_is_read_again_after_adoption():
    source=unified_evidence("first entry; second entry")
    lease=MemoryLease({"recordDescription":"entry","schemaNodes":[]})
    primary=[{"segment":"p1_s0","start":0,"end":12}]
    record=retained.record_identity(lease.state["source"]["sourceRevisionId"],primary)
    lease.historical={"manifest":{"coverage":{"reprocessValueIds":[]}},
        "snapshot":{"values":[{"id":"v","recordId":record,"grounding":"provisional","evidence":[{"anchorId":"a_p1_s0"}]}],
                    "coverage":{"completedScopes":{"unit":{"scope":primary,"primary":primary}}}}}
    assert CapturePlanner(lease).filter_evidence(source).passages[0].text==source.passages[0].text


def test_unified_planning_shows_discovery_progress_until_its_records_are_planned():
    source=unified_evidence("1. Hill. Material: gold.","2. Valley. Material: flint.")
    request=unified_request()
    lease=MemoryLease(request.schema_.model_dump(by_alias=True,exclude_none=True))
    chat=CountingChat(Model(source))
    extract=lambda router,counter: run.dispatch(None,source,request,router,counter=counter)
    def plan():
        counter=Counter();planner=CapturePlanner(lease,{"fields":counter,"reasoning":counter})
        try:
            extract(Router(chat,chat,planner),counter)
        except NeedsCall:
            pass
        return planner
    waiting=plan()
    assert waiting.discovery["found"]==[]
    assert list(waiting.discovery["windows"].values())==[[{"segment":"p1_s0","start":0,"end":24},{"segment":"p2_s0","start":0,"end":27}]]
    assert set(waiting.discovery["windows"])==set(waiting.pending)
    finish(lease,chat,extract)
    assert plan().discovery is None


@pytest.mark.parametrize("chunks",[1,3])
def test_a_planning_round_yields_at_most_chunks_page_windows_each_shown_with_its_own_lines(chunks):
    """Discovery's fan-out is bounded: each round yields the next `chunks` page windows in source order, the event
    names each with its own lines, and the starts found so far are every earlier window's, in source order."""
    source=unified_evidence(*(f"{n}. Site{n}. Material: m{n}." for n in range(1,11)))
    request=unified_request(defaults=2)
    lease=MemoryLease(request.schema_.model_dump(by_alias=True,exclude_none=True))
    rounds=[]
    def extract(router,counter):
        try:
            return run.dispatch(None,source,request,router,counter=counter,chunks=chunks)
        except NeedsCall:
            if router.runtime.discovery is not None:
                rounds.append(worker.discovery_event(router.runtime.discovery))
                assert {window["capture"] for window in rounds[-1]["windows"]}==set(router.runtime.pending)
            raise
    result=finish(lease,CountingChat(Model(source)),extract)
    assert [record["material"] for record in result["records"]]==[f"m{n}" for n in range(1,11)]
    starts=[f"p{n}_s0" for n in range(1,11)]
    assert [{window["lines"][0]["segment"] for window in event["windows"]} for event in rounds]==\
        [set(starts[at:at+chunks]) for at in range(0,10,chunks)]
    assert all([found["segment"] for found in event["found"]]==starts[:len(event["found"])] for event in rounds)
    assert [len(event["found"]) for event in rounds]==list(range(0,10,chunks))


@pytest.mark.parametrize("defaults,windows,overlap",[(1,None,1),(2,"page",3)])
def test_a_durable_unified_run_keeps_its_execution_record_with_its_plans(defaults,windows,overlap):
    """The discovery windows and overlap a run read with stay auditable in the database (`publish_plan`)."""
    source=unified_evidence("1. Hill. Material: gold.","2. Valley. Material: flint.")
    request=unified_request(defaults=defaults)
    lease=MemoryLease(request.schema_.model_dump(by_alias=True,exclude_none=True))
    result=finish(lease,CountingChat(Model(source)),lambda router,counter: run.dispatch(None,source,request,router,counter=counter))
    kept=[plan["manifest"] for stage,plan in lease.plans.items() if stage.startswith("unified-execution:")]
    assert kept==[lease.plans[f"unified-execution:{unified.digest(result['execution'])[:16]}"]["manifest"]]
    kept=kept[0]
    assert kept["units"]==[] and kept["execution"]==result["execution"]
    assert (kept["execution"]["effective"].get("windows"),kept["execution"]["effective"]["overlap"])==(windows,overlap)
    assert kept["execution"]["method"]=={"defaults":defaults}


def test_a_paused_unified_run_plans_on_without_its_execution_record():
    """The record is no gate: while the attempt does not run, planning goes on and the next running round keeps it."""
    source=unified_evidence("1. Hill. Material: gold.")
    request=unified_request(defaults=2)
    lease=MemoryLease(request.schema_.model_dump(by_alias=True,exclude_none=True))
    lease.intent="PAUSE"
    counter=Counter();planner=CapturePlanner(lease,{"fields":counter,"reasoning":counter})
    stages,call=[],lease.call
    lease.call=lambda name,*args:(stages.append(args[1]) if name=="publish_plan" else None,call(name,*args))[1]
    with pytest.raises(Boundary):
        run.dispatch(None,source,request,Router(CountingChat(Model(source)),CountingChat(Model(source)),planner),counter=counter)
    assert not any(stage.startswith("unified-execution") for stage in lease.plans)
    assert stages[0].startswith("unified-execution:") and stages[1].startswith("call:")  # on to discovery's first call


def test_a_changed_execution_record_adds_a_plan_instead_of_failing_the_attempt():
    """A round resumed after its record changed (here the served context, so every stage budget) plans on: both
    records stay, each under its own digest."""
    source=unified_evidence("1. Hill. Material: gold.")
    request=unified_request(defaults=2)
    lease=MemoryLease(request.schema_.model_dump(by_alias=True,exclude_none=True))
    class Smaller(Counter):
        context_tokens=32768
    for counter in (Counter(),Smaller()):
        planner=CapturePlanner(lease,{"fields":counter,"reasoning":counter})
        with pytest.raises(NeedsCall):
            run.dispatch(None,source,request,Router(CountingChat(Model(source)),CountingChat(Model(source)),planner),counter=counter)
    kept=[plan["manifest"]["execution"] for stage,plan in lease.plans.items() if stage.startswith("unified-execution:")]
    assert sorted(each["effective"]["stages"]["discovery"]["input_tokens"] for each in kept)==[32768-4096,40000-4096]


def test_article_grounding_batch_publishes_its_links_before_the_run_finishes():
    source=evidence(passages(["1. Hill 1827.","2. Valley 1828."]))
    request=run.ExtractRequest(schema=SCHEMA,options={"strategy":"article"})
    def answer(system,user,schema):
        if "### Claims" in user:
            return {claim:shape["enum"][0] for claim,shape in schema["properties"].items()}
        return {"site":"Hill","year":1827}
    lease=MemoryLease(request.schema_.model_dump(by_alias=True,exclude_none=True))
    finish(lease,CountingChat(answer),lambda router,counter: run.dispatch(None,source,request,router,counter={"fields":counter,"reasoning":counter}))
    running,final=linked_while_running(lease)
    assert running and running.items() <= final.items()


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


def test_field_corrections_do_not_enter_discovery_but_still_guide_record_values():
    from kei_exp.kie.extract.durable import field_meaning

    source = unified_evidence("1. Adorf. Material: Bronze.\n2. Bdorf. Material: Eisen.")
    request = unified_request()
    tree = request.schema_.model_dump(by_alias=True, exclude_none=True)
    node = next(node for node in tree["schemaNodes"] if node["id"] == "m")
    lease = MemoryLease(tree)
    candidate = {"id": "example", "fieldId": node["id"], "meaning": field_meaning(node),
                 "node": node, "value": "Gold", "grounded": False}
    lease.candidates = [{"id": "revision", "candidate": candidate}]

    class CorrectedModel(Model):
        def __call__(self, system, user, schema):
            # A schema-valid empty answer observed when field examples polluted
            # the boundary prompt; it must never become a successful empty run.
            if system.startswith("You find where records begin") and "Researcher correction examples" in system:
                return {"places": [], "begins_inside_record": True, "ends_inside_record": True}
            return super().__call__(system, user, schema)

    result = finish(lease, CountingChat(CorrectedModel(source)),
                    lambda router, counter: run.dispatch(None, source, request, router,
                                                         counter={"fields": counter, "reasoning": counter}))
    assert [record["material"] for record in result["records"]] == ["Bronze", "Eisen"]
    captured = [unit["input"]["request"] for unit in lease.units.values()]
    discovery = next(item for item in captured if item["body"]["stage"] == "discovery")
    assert discovery["examples"] == []
    assert discovery["omissions"] == [{"id": "revision", "reason": "stage"}]
    assert "Researcher correction examples" not in discovery["body"]["system"]
    entry = next(item for item in captured if item["body"]["stage"] == "entry")
    assert entry["examples"] == [candidate]
    assert "Researcher correction examples" in entry["body"]["system"]


def test_discovery_keeps_an_already_captured_guided_input_immutable():
    node = {"id": "field", "name": "title", "type": "string"}
    lease = MemoryLease({"recordDescription": "document", "schemaNodes": [node]})
    chat = CountingChat(lambda *_: {})
    args = dict(stage="discovery", record=None, system="Find record boundaries", user="source",
                schema={"type": "object"}, max_tokens=10)
    with pytest.raises(NeedsCall):
        CapturePlanner(lease, {"reasoning": Counter()}).complete(chat, **args)
    unit = next(iter(lease.units.values()))
    # Represent a finalized input captured by the previous composition rule. Retry
    # must invoke this saved body, even though new discovery inputs omit it.
    unit["input"]["request"]["body"]["system"] += "\nResearcher correction examples: saved old guidance"
    unit["input"]["digest"] = digest(unit["input"]["request"])
    captured = deepcopy(unit["input"])
    with pytest.raises(NeedsCall):
        CapturePlanner(lease, {"reasoning": Counter()}).complete(chat, **args)
    assert unit["input"] == captured
    assert not chat.calls


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


@pytest.mark.parametrize("bounded", [False, True])
def test_article_guidance_preserves_bounded_root_input_sized_reply_floor(bounded):
    from kei_exp.kie.extract.article import document_root
    from kei_exp.kie.extract.durable import field_meaning
    from kei_exp.kie.extract.method import ArticleOptions, LimitedCounter
    from kei_exp.kie.extract.schema import Schema
    from kei_exp.kie.extract.stages import REPLY_TOKENS
    node={"id":"title","name":"title","type":"string"}
    tree={"recordDescription":"The whole document","schemaNodes":[node]}
    lease=MemoryLease(tree)
    candidate={"id":"correction","fieldId":"title","meaning":field_meaning(node),"node":node,
               "value":"guidance "*3000,"grounded":False}
    lease.candidates=[{"id":"correction","candidate":candidate}]
    counter=LimitedCounter(Counter(),16000)
    chat=CountingChat(lambda *_:{"title":"target"})
    with pytest.raises(NeedsCall):
        document_root(passages(["source "*7000]),Schema.model_validate(tree),
            Router(fields=chat,reasoning=chat,runtime=CapturePlanner(lease,{"fields":counter})),
            counters={"fields":counter},record_chars=48000,check=lambda:None,
            method=ArticleOptions(context="bounded" if bounded else "full",context_tokens=16000))
    request=next(iter(lease.units.values()))["input"]["request"]
    assert request["examples"]==([] if bounded else [candidate])
    assert request["omissions"]==([{"id":"correction","reason":"budget"}] if bounded else [])
    assert request["budget"]["reserve"]>=REPLY_TOKENS
    assert (request["budget"]["reserve"]>=7000) is bounded
    assert request["budget"]["counted"]+request["budget"]["reserve"]==counter.context_tokens
    assert request["body"]["user"].split().count("source")==7000


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
