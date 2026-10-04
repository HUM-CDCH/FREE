"""Call-level planning/capture adapter, shared by every extraction method.

Planning evaluates the existing algorithms against committed call outputs.
An unexecuted request yields to the durable workflow; it never invokes a
provider in the planning step. Child workflows execute one finalized capture.
"""
from __future__ import annotations

import hashlib
import json
import threading
from copy import deepcopy
from uuid import uuid4

from kei_exp.kie.extract.calls import Call
from kei_exp.kie.extract.models import ROLE
from kei_exp.kie.extract.tokens import counter_for


def canonical(body):
    return json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(body):
    return hashlib.sha256(canonical(body).encode()).hexdigest()


def field_meaning(node):
    meaning={k:v for k,v in node.items() if k not in ("id","name","children")}
    if "children" in node:
        meaning["children"]=sorted([[child["id"],field_meaning(child)] for child in node["children"]])
    return digest(meaning)


def adapt_value(source, target, value):
    """Presentation renames use stable child identities, including array objects."""
    if field_meaning(source) != field_meaning(target):
        raise ValueError("incompatible field")
    if value is None:
        return None
    def object_value(raw):
        old = {child["id"]: child for child in source.get("children", [])}
        return {child["name"]: adapt_value(old[child["id"]], child, raw.get(old[child["id"]]["name"]))
                for child in target.get("children", [])}
    if source["type"] == "object":
        return object_value(value)
    if source["type"] == "array" and source.get("children"):
        return [object_value(item) for item in value]
    return value


class NeedsCall(BaseException):
    """A planning yield; never mistaken for a failed model response."""


class Boundary(BaseException):
    """The control won admission; no further native work may start."""


class CapturePlanner:
    def __init__(self, lease, counters=None):
        self.lease = lease
        self.selection = lease.state["selection"]
        self.counters = counters or {}
        self.pending = {}
        self.historical = lease.call("historical_coverage")
        self.scopes = {}
        self._ordinals = {}
        self._lock = threading.Lock()

    def plan_records(self, stage, scopes):
        self.scopes.update({index: scope for index,scope in enumerate(scopes)})
        manifest = {"plannerVersion":1,"selectionId":self.selection["id"],
                    "sourceGeneration":self.lease.state["source"]["generation"],
                    "units":[{"key":digest(scope),"scope":scope,"ordinal":index} for index,scope in enumerate(scopes)],
                    "coverage":{"primaryScopes":scopes,"historicalSnapshot":self.historical.get("manifest",{}).get("coverage",{}).get("snapshotId")}}
        if self.lease.call("publish_plan",str(uuid4()),stage,manifest) is None:
            raise Boundary()

    def filter_evidence(self, evidence):
        """Subtract fixed historical primary coverage without moving offsets.

        Masked characters cannot be extracted again; canonical character indices
        for the remaining source stay valid. Context overlap does not count as
        completed coverage. Explicit reprocessing retains the selected scope.
        """
        from dataclasses import replace
        from kei_exp.kie.extract.retained import record_identity
        snapshot = self.historical.get("snapshot")
        if not snapshot:
            return evidence
        reprocess = set(self.historical["manifest"]["coverage"].get("reprocessValueIds",[]))
        source_revision = self.lease.state["source"]["sourceRevisionId"]
        ranges = {}
        for completed in snapshot["coverage"].get("completedScopes",{}).values():
            record_id = record_identity(source_revision,completed["scope"])
            if any(value["recordId"]==record_id and value["grounding"]=="provisional" for value in snapshot["values"]):
                continue
            if any(value["recordId"]==record_id and value["id"] in reprocess for value in snapshot["values"]):
                continue
            for primary in completed["primary"]:
                ranges.setdefault(primary["segment"],[]).append((primary["start"],primary["end"]))
        passages=[]
        for passage in evidence.passages:
            chars=list(passage.text)
            for start,end in ranges.get(passage.id,[]):
                if not 0 <= start < end <= len(chars):
                    raise ValueError("historical primary coverage no longer resolves")
                chars[start:end]=[" "]*(end-start)
            text="".join(chars)
            if text.strip():
                passages.append(replace(passage,text=text))
        return replace(evidence,passages=tuple(passages))

    def complete(self, chat, *, stage, record, system, user, schema, max_tokens=None, counter=None):
        # The required request identifies the unit BEFORE adding feedback. A
        # replay never reads today's corrections to reconstruct an old input.
        scope = digest({"source": user, "stage": stage, "record": record})
        base = digest({"scope": scope, "system": system, "schema": schema, "model": chat.model,
                       "max_tokens": max_tokens, "bounded": getattr(chat, "max_whitespace", None)})
        with self._lock:
            ordinal = self._ordinals.get(base, 0)
            self._ordinals[base] = ordinal + 1
        key = digest([base, ordinal])
        source = self.lease.state["source"]
        manifest = {"plannerVersion": 1, "selectionId": self.selection["id"], "sourceGeneration": source["generation"],
                    "units": [{"key": key, "scope": scope, "ordinal": ordinal}],
                    "coverage": {"primarySource": digest(user), "contextOverlap": "included in exact input"}}
        plan = self.lease.call("publish_plan", str(uuid4()), "call:" + key, manifest)
        if plan is None:
            raise Boundary()
        capture = self.lease.call("capture_unit", str(uuid4()), key,
            {"stage": stage, "scope": scope, "ordinal": ordinal, "planDigest": plan["digest"], "role": ROLE[stage]})
        if capture is None:
            raise Boundary()
        if capture["checkpoint"] is not None:
            output = capture["checkpoint"]["output"]
            if output.get("formatRefused"):
                return self._fallback(capture,key)
            return output["parsed"], [Call(**call) for call in output["calls"]]
        if capture["input"] is None:
            counter = counter or self.counters.get(ROLE[stage]) or counter_for(chat)
            reserve = max_tokens if max_tokens is not None else getattr(chat, "max_tokens", 8192)
            count = counter.request_tokens(system, user, schema)
            context = counter.context_tokens
            if type(context) is not int or count + reserve > context:
                raise ValueError("required source and reply budget exceed the served context")
            examples, omissions = self._feedback(capture["candidates"], system, user, schema, reserve, counter)
            if examples:
                system += self._guidance(examples)
            count = counter.request_tokens(system, user, schema)
            body = {"stage": stage, "record": record, "system": system, "user": user, "schema": schema,
                    "max_tokens": reserve, "max_whitespace": getattr(chat, "max_whitespace", None)}
            if hasattr(chat,"request_body"):
                body["httpRequest"]=chat.request_body(system=system,user=user,schema=schema,max_tokens=reserve)
            effective = self.lease.state["effective"]["models"][ROLE[stage]]
            finalized = {"provider": effective, "composer": 1, "tokenizer": counter.identity(),
                         "budget": {"counted": count, "context": context, "reserve": reserve},
                         "examples": examples, "omissions": omissions, "body": body}
            self.lease.call("finalize_input", capture["id"], finalized)
        with self._lock:
            self.pending[capture["id"]] = key
        raise NeedsCall()

    def _fallback(self, parent, parent_key):
        key=digest([parent_key,"format-fallback",1])
        manifest={"plannerVersion":1,"selectionId":self.selection["id"],
                  "sourceGeneration":self.lease.state["source"]["generation"],
                  "units":[{"key":key}],"coverage":{"dependency":parent["checkpoint"]["outputDigest"]}}
        plan=self.lease.call("publish_plan",str(uuid4()),"fallback:"+key,manifest)
        if plan is None:
            raise Boundary()
        descriptor={**parent["descriptor"],"ordinal":0,"planDigest":plan["digest"],"derivedFrom":parent["id"]}
        capture=self.lease.call("capture_unit",str(uuid4()),key,descriptor)
        if capture is None:
            raise Boundary()
        refused=[Call(**call) for call in parent["checkpoint"]["output"]["calls"]]
        if capture["checkpoint"] is not None:
            output=capture["checkpoint"]["output"]
            return output["parsed"],[*refused,*[Call(**call) for call in output["calls"]]]
        if capture["input"] is None:
            request=deepcopy(parent["input"]["request"])
            request["body"]["httpRequest"].pop("response_format")
            self.lease.call("finalize_input",capture["id"],request)
        self.pending[capture["id"]]=key
        raise NeedsCall()

    def structure(self, backend, *, record, text, schema, identity, counted, context):
        from kei_exp.kie.extract.gliformer import NativeCounter
        counter=NativeCounter(backend,backend.info())
        key=digest(["native",record,text,schema,identity])
        manifest={"plannerVersion":1,"selectionId":self.selection["id"],
                  "sourceGeneration":self.lease.state["source"]["generation"],"units":[{"key":key}],
                  "coverage":{"primarySource":digest(text)}}
        plan=self.lease.call("publish_plan",str(uuid4()),"native:"+key,manifest)
        if plan is None:
            raise Boundary()
        capture=self.lease.call("capture_unit",str(uuid4()),key,
            {"stage":"entry","scope":digest(text),"ordinal":0,"planDigest":plan["digest"],"role":"fields"})
        if capture is None:
            raise Boundary()
        if capture["checkpoint"] is not None:
            output=capture["checkpoint"]["output"]
            return output["parsed"],Call(**output["calls"][0])
        if capture["input"] is None:
            proposed=deepcopy(schema)
            nodes={node["id"]:node for node in self.selection["schemaTree"]["schemaNodes"]}
            examples,omissions=[],[]
            for revision in capture["candidates"]:
                candidate=revision["candidate"];node=nodes.get(candidate["fieldId"])
                if node is None or candidate["meaning"]!=field_meaning(node):
                    omissions.append({"id":revision["id"],"reason":"incompatible"});continue
                amended=deepcopy(schema)
                amended["record"]["description"]+=self._guidance([*examples,candidate])
                if counter.request_tokens("",text,amended)>context:
                    omissions.append({"id":revision["id"],"reason":"budget"});continue
                examples.append(candidate);proposed=amended
            counted=counter.request_tokens("",text,proposed)
            if counted>context:
                raise ValueError("native required input exceeds captured capacity")
            request={"provider":self.lease.state["effective"]["models"]["fields"],"composer":1,
                     "tokenizer":counter.identity(),"budget":{"counted":counted,"context":context,"reserve":0},
                     "examples":examples,"omissions":omissions,"body":{"kind":"native","record":record,
                       "text":text,"schema":proposed,"identity":identity,"counted":counted,"context":context}}
            self.lease.call("finalize_input",capture["id"],request)
        self.pending[capture["id"]]=key
        raise NeedsCall()

    def _guidance(self, examples):
        nodes = {}
        def visit(items):
            for node in items:
                nodes[node["id"]] = node
                visit(node.get("children", []))
        visit(self.selection["schemaTree"]["schemaNodes"])
        projected = [{**candidate, "value": adapt_value(candidate["node"], nodes[candidate["fieldId"]], candidate["value"])} for candidate in examples]
        return ("\nResearcher correction examples (patterns only). Extract facts and Evidence solely from the target source; "
                "these examples never supply target facts or anchors.\n" + canonical(projected))

    def _feedback(self, candidates, system, user, schema, reserve, counter):
        nodes = {}
        def visit(items):
            for node in items:
                nodes[node["id"]] = node
                visit(node.get("children", []))
        visit(self.selection["schemaTree"]["schemaNodes"])
        examples, omissions = [], []
        for revision in candidates:
            candidate = revision["candidate"]
            node = nodes.get(candidate["fieldId"])
            meaning = field_meaning(node) if node else None
            if not node or candidate["meaning"] != meaning:
                omissions.append({"id": revision["id"], "reason": "incompatible"})
                continue
            proposed = [*examples, candidate]
            if counter.request_tokens(system + self._guidance(proposed), user, schema) + reserve > counter.context_tokens:
                omissions.append({"id": revision["id"], "reason": "budget"})
                continue
            examples = proposed
        return examples, omissions

    def saved_record(self, fields, scope, *, record=0, links=(), primary=()):
        from kei_exp.kie.extract.retained import publish_values
        self.scopes[record] = scope
        return publish_values(self.lease, fields, scope, record=record, links=links, primary=primary)

    def reuse_record(self, scope, *, record=0):
        from kei_exp.kie.extract.retained import record_identity
        snapshot = self.historical.get("snapshot")
        if not snapshot:
            return None
        record_id = record_identity(self.lease.state["source"].get("sourceRevisionId", self.lease.state["source"].get("artifactSha256")), scope)
        reprocess = set(self.historical["manifest"]["coverage"].get("reprocessValueIds", []))
        values = [v for v in snapshot["values"] if v["recordId"] == record_id and v["processing"] == "saved"]
        complete = any(c.get("scope") == scope for c in snapshot["coverage"].get("completedScopes", {}).values())
        if not complete or not values or any(v["id"] in reprocess for v in values):
            return None
        # Completed values retain their producing selection. Empty fields are
        # carried as historical results; no new schema is attributed to them.
        self.scopes[record]={"historical":True,"scope":scope}
        return {}
