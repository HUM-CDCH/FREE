"""kei's Extraction workflows: one durable attempt (`extractDurableV1`) per admitted attempt, on the kei-extract lane.

A planning step yields immutable captures. One child workflow and step per
provider request preserves outputs across the coordination/DBOS ack gap.
"""
from __future__ import annotations

from dataclasses import asdict

from dbos import DBOS, SetWorkflowID, WorkflowSerializationFormat

from kei_exp.kie.extract.discovery import StreamedPlaces

from kei_exp import runs
from kei_exp.kie.extract import calls
from kei_exp.kie.extract.durable import Boundary, CapturePlanner, NeedsCall
from kei_exp.kie.extract.llm import NuExtractChat, OpenAIChat
from kei_exp.kie.extract.gliformer import GLiFormerFields
from kei_exp.kie.extract.captured_provider import CapturedChat, FormatRefused
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.grounded import CatalogOptions
from kei_exp.kie.extract.unified import UnifiedOptions
from kei_exp.kie.extract.models import EXTRACT_MODELS, Router, routes
from kei_exp.kie.extract.run import ExtractRequest, dispatch, Options
from kei_exp.kie.passages import load
from kei_exp.workflows import config
from kei_exp.workflows.coordination import CoordinationPool, Lease

_pool: CoordinationPool | None = None


def configure(url: str):
    global _pool
    pool = CoordinationPool(url)
    try:
        pool.ready()
    except BaseException:
        pool.close()
        raise
    _pool = pool


def close_coordination():
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def coordinator() -> CoordinationPool:
    if _pool is None:
        raise RuntimeError("Extraction coordination has not been initialized")
    return _pool


def show(key, value):
    """Progress Studio shows while the run reads, as this workflow's DBOS event. Display only: it is never read back
    by the run, and failing to write it never fails a call."""
    try:
        DBOS.set_event(key, value, serialization_type=WorkflowSerializationFormat.PORTABLE)
    except Exception:
        pass


class Shown:
    """A discovery reply's places as they are generated, shown at most every half second and once complete."""

    def __init__(self):
        self.places, self.at = StreamedPlaces(), 0.0

    def feed(self, delta):
        from time import monotonic
        if self.places.feed(delta) and monotonic() - self.at >= 0.5:
            self.at = monotonic()
            show("places", self.places.places)

    def done(self):
        show("places", self.places.places)


def discovery_event(discovery):
    """Studio's discovery progress (`discoveryProgress`): the record starts found so far, and each discovery capture
    this round yielded with the lines its window labels from L1."""
    return {"found": discovery["found"], "windows": [{"capture": capture, "lines": lines}
                                                     for capture, lines in sorted(discovery["windows"].items())]}


def failed_output(output):
    return not output.get("formatRefused") and any(not call.get("ok") and not call.get("recovered") for call in output.get("calls",[]))


def chat_for(provider):
    if provider["adapterVersion"] != 1:
        raise ValueError("unsupported captured provider adapter")
    if provider["adapter"]=="gliformer":
        return GLiFormerFields(url=provider["url"],model=provider["model"],timeout=provider["timeout"],
                              pinned_info=provider["nativeInfo"])
    kind = {"instruct": OpenAIChat, "nuextract": NuExtractChat}.get(provider["adapter"])
    if kind is None:
        raise ValueError("unsupported durable fields adapter")
    return kind(url=provider["url"], model=provider["model"], timeout=provider["timeout"],
                max_tokens=provider["maxTokens"])


def effective(lease):
    selected = lease.state["selection"]
    existing = lease.call("resolve_selection", None)
    if existing is not None:
        pinned = existing["configuration"]
        lease.state["effective"] = pinned
        # The pinned routes/defaults are authoritative on recovery. Pydantic's
        # deployment model availability validator is relevant only at admission.
        from kei_exp.kie.extract.schema import Schema
        options = Options.model_construct(**pinned["options"])
        for name, kind in (("article", ArticleOptions), ("catalog", CatalogOptions), ("unified", UnifiedOptions)):
            if getattr(options,name) is not None:
                setattr(options,name,kind.model_validate(getattr(options,name)))
        request = ExtractRequest.model_construct(schema_=Schema.model_validate(selected["schemaTree"]),options=options)
        return request, Router(**{role: chat_for(provider) for role,provider in pinned["models"].items()})
    options = selected["resolved"]["options"]
    request = ExtractRequest.model_validate({"schema": selected["schemaTree"], "options": options})
    models = {}
    for role, key in routes(request.options).items():
        model = EXTRACT_MODELS[key]
        client = model.chat()
        # Deployment endpoints only; no researcher keys/headers reach storage.
        from urllib.parse import urlsplit
        url = urlsplit(model.url)
        if url.username or url.password or url.query:
            raise ValueError("model endpoint credentials cannot enter capture history")
        models[role] = {"key": key, "model": model.repo, "adapter": model.adapter, "adapterVersion": 1,
                        "url": model.url, "timeout": client.timeout, "maxTokens": getattr(client,"max_tokens",0)}
        if model.adapter=="gliformer":
            info=client.info()
            models[role]["nativeInfo"]={name:info[name] for name in ("protocol","model","identity","max_input_tokens")}
    # Nested method serializers own optional fields; exclude_none would remove
    # their keys before Article's serializer can apply its canonical contract.
    frozen_options = {name: value for name, value in request.options.model_dump().items() if value is not None}
    if request.options.unified is not None:
        frozen_options.pop("discovery_chars",None); frozen_options.pop("record_chars",None)
    pinned = lease.call("resolve_selection", {"models": models, "options": frozen_options, "planner": 1,
                                             "protocols": {"calls": 1, "source": request.record_scope}})
    lease.state["effective"] = pinned["configuration"]
    return request, Router(**{role: chat_for(provider) for role, provider in pinned["configuration"]["models"].items()})


class PinnedCounter:
    def __init__(self, budget):
        self.context_tokens = budget["context"]
        self.counted = budget["counted"]

    def request_tokens(self, *_):
        return self.counted


@DBOS.step(name="invokeExtractionCaptureV1")
def invoke_capture(extraction: str, attempt: str, capture: str) -> dict:
    with Lease(coordinator(), extraction, attempt) as lease:
        saved = lease.call("read_call", capture)
        if saved["checkpoint"] is not None:
            checkpoint = saved["checkpoint"]
            return {"ok": not failed_output(checkpoint["output"]) or checkpoint.get("recoverable", False), "capture": capture}
        if saved["intent"] != "RUN":
            return {"ok": True, "boundary": True}
        finalized = saved["input"]
        if finalized is None:
            raise ValueError("capture input was not finalized")
        request = finalized["request"]
        if request["composer"] != 1:
            raise ValueError("unsupported captured composer")
        client = chat_for(request["provider"])
        body = dict(request["body"])
        native=body.pop("kind",None)=="native"
        http_request=body.pop("httpRequest",None)
        if not native:
            body.pop("max_whitespace",None)
            if http_request is None:
                raise ValueError("capture lacks the exact HTTP request")
            # Discovery's reply is streamed so the records it finds show while it is generated (transport only: the
            # saved request is sent unchanged, and the call is read and saved as an unstreamed one).
            shown=Shown() if body["stage"]=="discovery" else None
            client=CapturedChat(request["provider"],http_request,on_text=shown.feed if shown else None)
        if not lease.call("begin_call", capture):
            return {"ok": True, "boundary": True}
        try:
            if native:
                parsed,call=calls.structure(client,**body)
                attempts=[call]
            else:
                parsed, attempts = calls.complete(client, **body, counter=PinnedCounter(request["budget"]))
                if shown:
                    shown.done()
            output = {"parsed": parsed, "calls": [asdict(call) for call in attempts]}
        except FormatRefused:
            output={"formatRefused":True,"parsed":None,"calls":[asdict(calls.Call(body["stage"],body["record"],None,None,
              0.0,None,False,"structured output format refused",recovered=True))]}
        except Exception as error:
            lease.call("fail_call", capture)
            return {"ok": False, "reason": type(error).__name__}
        # A transient commit failure retains the returned output in this native
        # step and retries persistence. It must never present it as already saved.
        from time import sleep
        for retry in range(3):
            try:
                committed = lease.call("commit_output", capture, finalized["digest"], output)
                break
            except Exception:
                if retry == 2:
                    lease.call("fail_call", capture)
                    raise RuntimeError("returned output could not be saved") from None
                sleep(0.1 * (retry + 1))
        # The fenced commit owns failure policy. Recoverable replies let the
        # existing bounded planner split its window on the next replay.
        return {"ok": not failed_output(output) or bool(committed and committed.get("recoverable")), "capture": capture}


@DBOS.workflow(name="extractionCallV1", max_recovery_attempts=config.MAX_RECOVERY_ATTEMPTS,
               serialization_type=WorkflowSerializationFormat.PORTABLE)
def call_workflow(extraction: str, attempt: str, capture: str) -> dict:
    return invoke_capture(extraction, attempt, capture)


@DBOS.step(name="planExtractionCallsV1")
def plan_next(extraction: str, attempt: str) -> dict:
    with Lease(coordinator(), extraction, attempt) as lease:
        if lease.state["intent"] != "RUN" and lease.call("resolve_selection",None) is None:
            return {"boundary": True}
        request, router = effective(lease)
        planner = CapturePlanner(lease)
        router = Router(router.fields, router.reasoning, planner)
        if isinstance(router.fields,GLiFormerFields):
            router.fields.runtime=planner
        source = lease.state["source"]
        directory = runs.directory_of(source["runId"])
        if directory is None:
            raise ValueError("pinned source is unavailable")
        # Only committed durable outputs are reusable checkpoints.
        # Each new-protocol pipeline derives its work from exact call outputs.
        evidence = load(directory)
        if evidence.generation != source["generation"]:
            raise ValueError("pinned source generation is unavailable")
        evidence = planner.filter_evidence(evidence) if request.options.catalog is None else evidence
        if not evidence.passages:
            return {"historicalOnly":True}
        try:
            result = dispatch(directory, evidence, request, router, chunks=config.CATALOG_CHUNKS)
        except NeedsCall:
            if planner.discovery is not None:
                show("discovery", discovery_event(planner.discovery))
            return {"pending": sorted(planner.pending, key=lambda key: planner.pending[key]), "roles": planner.roles}
        except Boundary:
            return {"boundary": True}
        return {"result": result, "scopes": planner.scopes}


@DBOS.step(name="acknowledgeExtractionV1")
def acknowledge(extraction: str, attempt: str, complete: bool, failure: dict | None):
    saved = coordinator().call("read_attempt_outcome", extraction, attempt)
    if saved is not None:
        return saved
    with Lease(coordinator(), extraction, attempt) as lease:
        return lease.call("acknowledge", complete, failure)


@DBOS.step(name="settledExtractionCallsV1")
def settled(workflow_ids: list[str]) -> dict:
    """The listed call workflows that have ended, each with whether planning may go on after it: not after a call that
    failed (it paused the attempt) or a call workflow that did not return."""
    return {status.workflow_id: status.status == "SUCCESS" and bool((status.output or {}).get("ok"))
            for status in DBOS.list_workflows(workflow_ids=workflow_ids, load_input=False)
            if status.status not in ("PENDING", "ENQUEUED", "DELAYED")}


@DBOS.workflow(name="extractDurableV1", max_recovery_attempts=config.MAX_RECOVERY_ATTEMPTS,
               serialization_type=WorkflowSerializationFormat.PORTABLE)
def extract_workflow(request: dict) -> dict:
    if set(request) != {"protocol", "extraction_id", "attempt_id"} or request["protocol"] != 1:
        return {"ok": False, "reason": "invalid durable attempt"}
    extraction, attempt = request["extraction_id"], request["attempt_id"]
    if not DBOS.patch("extract-wait-first"):
        return wait_all(extraction, attempt)
    # Each call runs as soon as it is planned, up to CATALOG_CHUNKS per role at once, and the attempt is planned again
    # as soon as one ends: a slow call holds up no other. Nothing is acknowledged while a call it started still runs,
    # so a Pause or a failure keeps every output already admitted.
    running: dict = {}  # capture -> (role, handle), in start order
    ended: set[str] = set()

    def wait() -> bool:
        """Until a running call ends; whether every call that ended meanwhile lets planning go on."""
        DBOS.wait_first([handle for _, handle in running.values()], polling_interval_sec=0.2)
        outcomes = settled([handle.workflow_id for _, handle in running.values()])
        ok = True
        for capture, (_, handle) in list(running.items()):
            if handle.workflow_id in outcomes:
                ok = ok and outcomes[handle.workflow_id]
                ended.add(capture)
                del running[capture]
        return ok

    def stop(complete: bool, failure: dict | None, compile_saved: bool = True) -> dict:
        while running:
            wait()
        if compile_saved:  # the drained calls' outputs, compiled while admission is halted
            try:
                plan_next(extraction, attempt)
            except Exception:
                pass
        return {"status": acknowledge(extraction, attempt, complete, failure)}
    while True:
        try:
            work = plan_next(extraction, attempt)
        except Exception as error:
            return stop(False, {"code": type(error).__name__}, compile_saved=False)
        if work.get("boundary"):
            return stop(False, None, compile_saved=bool(running))
        if work.get("historicalOnly"):
            publish_result(extraction, attempt, {"records": [], "completeness": {"processing": True}}, {})
            return {"status": acknowledge(extraction,attempt,True,None)}
        if "result" in work:
            while running:
                wait()
            publish_result(extraction, attempt, work["result"], work["scopes"])
            from kei_exp.kie.extract.retained import processing_complete
            processing = processing_complete(work["result"])
            return {"status": acknowledge(extraction, attempt,processing,None if processing else {"code":"incomplete_processing"})}
        for capture in work["pending"]:
            role = work["roles"][capture]
            if capture in running:
                continue
            if capture in ended:  # its call ended without saving an output: planning it again would never end
                return stop(False, {"code": "capture_replanned"})
            if sum(each == role for each, _ in running.values()) < max(1, config.CATALOG_CHUNKS):
                with SetWorkflowID(f"kei-call:{attempt}:{capture}"):
                    running[capture] = (role, DBOS.start_workflow(call_workflow, extraction, attempt, capture))
        if not running:  # a method that yields must have planned a call
            return stop(False, {"code": "nothing_planned"}, compile_saved=False)
        if not wait():
            return stop(False, {"code": "capture_failed"})


def wait_all(extraction: str, attempt: str) -> dict:
    """An attempt started before `extract-wait-first`: every round's calls run, then all are awaited."""
    while True:
        try:
            work = plan_next(extraction, attempt)
        except Exception as error:
            return {"status": acknowledge(extraction, attempt, False, {"code": type(error).__name__})}
        if work.get("boundary"):
            return {"status": acknowledge(extraction, attempt, False, None)}
        if work.get("historicalOnly"):
            publish_result(extraction, attempt, {"records": [], "completeness": {"processing": True}}, {})
            return {"status": acknowledge(extraction,attempt,True,None)}
        if "result" in work:
            # Result validation/publication is completed by the retained-result
            # producer before a complete acknowledgement (see publish_result).
            publish_result(extraction, attempt, work["result"], work["scopes"])
            from kei_exp.kie.extract.retained import processing_complete
            processing = processing_complete(work["result"])
            return {"status": acknowledge(extraction, attempt,processing,None if processing else {"code":"incomplete_processing"})}
        handles = []
        for capture in work["pending"]:
            with SetWorkflowID(f"kei-call:{attempt}:{capture}"):
                handles.append(DBOS.start_workflow(call_workflow,extraction,attempt,capture))
        outcomes = []
        for handle in handles:
            try:
                outcomes.append(handle.get_result())
            except Exception:
                outcomes.append({"ok": False, "reason": "capture_failed"})
        if any(not item["ok"] for item in outcomes):
            # Compile committed responses while admission is halted, so successful
            # siblings remain visible even when a later native call failed.
            try:
                plan_next(extraction,attempt)
            except Exception:
                pass
            return {"status": acknowledge(extraction, attempt, False, {"code": "capture_failed"})}


@DBOS.step(name="publishExtractionResultV1")
def publish_result(extraction: str, attempt: str, result: dict, scopes: dict):
    # Filled by the retained-result compiler, never by the best-effort progress reader.
    from kei_exp.kie.extract.retained import publish_final
    with Lease(coordinator(), extraction, attempt) as lease:
        lease.state["recordScopes"] = scopes
        publish_final(lease, result)


def delete_quiescent_history(graph, boot_ms, list_statuses, delete_history):
    from kei_exp.workflows.gc import eligible
    identities = [attempt["workflowId"] for attempt in graph["attempts"]]
    identities += [f"kei-call:{attempt['id']}:{capture['id']}" for attempt in graph["attempts"] for capture in graph["captures"]]
    statuses = {}
    for index in range(0, len(identities), 100):
        statuses.update({status.workflow_id: status for status in list_statuses(identities[index:index + 100])})
    # Cancellation is not native quiescence. The existing worker boot clock and
    # slot prove that cancelled steps from an earlier process can no longer write.
    if not all(eligible(statuses.get(identity), boot_ms) for identity in identities):
        return False
    for index in range(0, len(identities), 100):
        delete_history(identities[index:index + 100])
    return True


@DBOS.step(name="collectDeletedDurableHistoryV1")
def collect_deleted_history(extraction: str, fence: int) -> dict:
    from kei_exp.workflows import boot
    graph = coordinator().call("read_deleted_graph", extraction, fence)
    if graph is None:
        return {"removed": False}
    return {"removed": delete_quiescent_history(graph, boot.timestamp_ms(),
        lambda ids: DBOS.list_workflows(workflow_ids=ids, load_input=False, load_output=False), DBOS.delete_workflows)}


@DBOS.workflow(name="deleteDurableHistoryV1", max_recovery_attempts=config.MAX_RECOVERY_ATTEMPTS,
               serialization_type=WorkflowSerializationFormat.PORTABLE)
def delete_history_workflow(request: dict) -> dict:
    from uuid import UUID
    if set(request) != {"protocol", "extraction_id", "fence"} or request["protocol"] != 1:
        return {"removed": False}
    try:
        UUID(request["extraction_id"])
        if type(request["fence"]) is not int or request["fence"] < 1:
            return {"removed": False}
    except (ValueError, TypeError):
        return {"removed": False}
    return collect_deleted_history(request["extraction_id"],request["fence"])
