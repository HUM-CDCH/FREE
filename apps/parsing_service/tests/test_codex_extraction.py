"""Codex protocol, isolation and conservative budgets through real child processes, without model access."""
import json
import sys
import time

import pytest

from kei_exp.kie.extract.codex import CONTEXT_TOKENS, POLICY, CodexChat
from kei_exp.kie.extract.llm import ModelOutputError
from kei_exp.kie.extract.models import defaults, registry
from kei_exp.kie.extract.calls import complete
from kei_exp.kie.extract.tokens import counter_for
from kei_exp.workflows.durable_extract import PinnedCounter, chat_for

SCHEMA = {"type": "object", "properties": {"identifier": {"type": "string"}},
          "required": ["identifier"], "additionalProperties": False}


@pytest.fixture
def server(tmp_path, monkeypatch):
    def configure(*, activity=None, usage=True, input_tokens=100, output_tokens=20, window=272000,
                  status="completed", hang=False, stall=False, catalog=None):
        script = tmp_path / "fake-codex"
        recorded = tmp_path / "requests.jsonl"
        script.write_text(f"#!{sys.executable}\n" + """
import json, sys, time
settings = SETTINGS
recorded = RECORDED

def emit(event):
    print(json.dumps(event), flush=True)

for line in sys.stdin:
    request = json.loads(line)
    with open(recorded, 'a') as saved:
        saved.write(json.dumps(request) + '\\n')
    method = request['method']
    if method == 'initialize':
        emit({'id': request['id'], 'result': {}})
        if settings['stall']:
            time.sleep(60)
    if method == 'model/list':
        page = int(request['params'].get('cursor') or 0)
        emit({'id': request['id'], 'result': settings['catalog'][page]})
    if method == 'thread/start':
        emit({'id': request['id'], 'result': {'thread': {'id': 'test-thread'}}})
    if method == 'turn/start':
        if settings['hang']:
            time.sleep(60)
        if settings['activity']:
            emit({'method': 'item/started', 'params': {'item': {'type': settings['activity']}}})
        emit({'method': 'item/completed', 'params': {'item': {'type': 'agentMessage', 'text': '{"identifier":"FREE-LOCAL-001"}'}}})
        if settings['usage']:
            emit({'method': 'thread/tokenUsage/updated', 'params': {'tokenUsage': {
                'total': {'inputTokens': settings['input_tokens'], 'outputTokens': settings['output_tokens']},
                'modelContextWindow': settings['window']}}})
        emit({'method': 'turn/completed', 'params': {'turn': {'status': settings['status']}}})
""".replace("SETTINGS", repr(dict(activity=activity, usage=usage, input_tokens=input_tokens,
              output_tokens=output_tokens, window=window, status=status, hang=hang, stall=stall, catalog=catalog))).replace("RECORDED", repr(str(recorded))))
        script.chmod(0o700)
        monkeypatch.setenv("KEI_CODEX_BINARY", str(script))
        return recorded
    return configure


def extract(chat=None):
    return (chat or CodexChat(model="test-model", timeout=3)).complete(
        system="Extract the identifier.", user="Document identifier: FREE-LOCAL-001.", schema=SCHEMA)


def test_one_isolated_structured_turn_and_reported_usage(server):
    recorded = server()
    reply = extract()
    assert json.loads(reply.text) == {"identifier": "FREE-LOCAL-001"}
    assert (reply.input_tokens, reply.output_tokens, reply.finish) == (100, 20, "stop")
    requests = [json.loads(line) for line in recorded.read_text().splitlines()]
    start = next(item['params'] for item in requests if item['method'] == 'thread/start')
    assert start['ephemeral'] and start['approvalPolicy'] == 'never' and start['sandbox'] == 'read-only'
    assert start['baseInstructions'] == 'Extract the identifier.'
    assert start['config']['mcp_servers'] == {} and not start['config']['features.shell_tool']
    assert not start['config']['features.multi_agent']
    turn = next(item['params'] for item in requests if item['method'] == 'turn/start')
    assert turn['outputSchema'] == SCHEMA
    assert turn['input'][0]['text'] == 'Document identifier: FREE-LOCAL-001.'


@pytest.mark.parametrize('activity', ['commandExecution', 'mcpToolCall', 'contextCompaction', 'collabAgentToolCall'])
def test_tools_and_compaction_are_refused(server, activity):
    server(activity=activity)
    with pytest.raises(ModelOutputError, match='tools or compaction'):
        extract()


@pytest.mark.parametrize('settings', [
    {'usage': False}, {'input_tokens': 50000}, {'window': 8192}, {'output_tokens': 8193}, {'status': 'failed'},
])
def test_unverified_or_exceeded_budgets_and_failed_turns_are_refused(server, settings):
    server(**settings)
    with pytest.raises(ModelOutputError):
        extract()


def test_a_hung_child_is_terminated_within_the_call_deadline(server):
    server(hang=True)
    with pytest.raises(TimeoutError):
        extract(CodexChat(model='test-model', timeout=0.2))


def test_a_child_that_stops_reading_cannot_block_a_write_past_the_deadline(server):
    # Within budget, yet its JSON-escaped instructions exceed the pipe buffer, so writing thread/start blocks.
    server(stall=True)
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        CodexChat(model='test-model', timeout=0.5, max_tokens=1024).complete(
            system='文' * 16000, user='Document identifier: FREE-LOCAL-001.', schema=SCHEMA)
    assert time.monotonic() - started < 3


def test_oversize_source_is_refused_before_starting_a_process(monkeypatch):
    monkeypatch.setenv('KEI_CODEX_BINARY', '/no/such/binary')
    with pytest.raises(ModelOutputError, match='budget'):
        CodexChat(model='test-model').complete(system='S', user='x' * CONTEXT_TOKENS, schema=SCHEMA)


def test_counter_labels_multilingual_bytes_as_an_upper_bound():
    chat = CodexChat(model='test-model')
    counter = counter_for(chat)
    assert counter.identity()['source'] == POLICY
    assert counter.identity()['input_counting'] == 'upper_bound'
    assert counter.request_tokens('S', '中文', SCHEMA) > counter.request_tokens('S', 'ab', SCHEMA)


def test_deployment_registry_pins_codex_for_both_roles_and_requires_a_model():
    models = registry({'KEI_EXTRACT_PROVIDER': 'codex-cli', 'KEI_EXTRACT_MODEL': 'test-model'})
    assert defaults(models) == {'fields': 'instruct', 'reasoning': 'instruct'}
    assert isinstance(models['instruct'].chat(), CodexChat)
    with pytest.raises(ValueError, match='requires KEI_EXTRACT_MODEL'):
        registry({'KEI_EXTRACT_PROVIDER': 'codex-cli'})


def test_durable_provider_and_budget_preserve_actual_usage_without_exact_equality(server):
    server()
    provider = {'adapterVersion': 1, 'adapter': 'codex-cli', 'model': 'test-model', 'url': 'codex://local',
                'timeout': 3, 'maxTokens': 8192}
    chat = chat_for(provider)
    counter = PinnedCounter({'context': CONTEXT_TOKENS, 'counted': 4500}, upper_bound=True)
    parsed, calls = complete(chat, stage='record', record=0, system='Extract the identifier.',
                             user='Document identifier: FREE-LOCAL-001.', schema=SCHEMA, counter=counter, max_tokens=8192)
    assert parsed == {'identifier': 'FREE-LOCAL-001'} and calls[-1].ok
    assert calls[-1].input_tokens == 100 and calls[-1].counted_input_tokens == 4500


def test_saved_provider_payload_is_sent_without_recomposition(server):
    from kei_exp.kie.extract.captured_provider import CapturedChat
    recorded = server()
    payload = CodexChat(model='test-model').request_body(system='Pinned instructions.', user='Pinned source.', schema=SCHEMA)
    reply = CapturedChat({'adapter': 'codex-cli', 'model': 'test-model', 'timeout': 3}, payload).complete(
        system='Changed instructions', user='Changed source', schema={})
    assert json.loads(reply.text)['identifier'] == 'FREE-LOCAL-001'
    requests = [json.loads(line) for line in recorded.read_text().splitlines()]
    assert next(item['params'] for item in requests if item['method'] == 'thread/start')['baseInstructions'] == 'Pinned instructions.'
    assert next(item['params'] for item in requests if item['method'] == 'turn/start')['input'][0]['text'] == 'Pinned source.'


def test_limited_exact_counters_do_not_need_identity_metadata():
    from types import SimpleNamespace
    from kei_exp.kie.extract.method import LimitedCounter
    from kei_exp.kie.extract.llm import Reply
    class ExactChat:
        model = 'test-model'
        def complete(self, **_):
            return Reply('{"identifier":"FREE-LOCAL-001"}', 120, 20, 'stop', 0.1)
    counter = LimitedCounter(SimpleNamespace(context_tokens=65536, request_tokens=lambda *_: 120), 32768)
    parsed, calls = complete(ExactChat(), stage='record', record=0, system='S', user='U', schema=SCHEMA,
                             max_tokens=8192, counter=counter)
    assert parsed['identifier'] == 'FREE-LOCAL-001' and calls[-1].ok


def test_limited_codex_counters_retain_the_explicit_usage_policy():
    from kei_exp.kie.extract.method import LimitedCounter
    counter = LimitedCounter(CodexChat(model='test-model').counter(), 32768)
    assert counter.upper_bound


def test_a_bounded_ceiling_leaves_out_the_codex_framing_only_with_overflow_windows():
    """Studio's default 12,288-token units would otherwise hold only the CLI's own framing: every request refused."""
    from types import SimpleNamespace
    from kei_exp.kie.extract.codex import FRAMING_TOKENS
    from kei_exp.kie.extract.method import LimitedCounter
    codex = CodexChat(model='test-model').counter()
    excluded = LimitedCounter(LimitedCounter(codex, 12288, exclude_framing=True), 12288, exclude_framing=True)
    assert (excluded.context_tokens, excluded.excluded_tokens) == (12288 + FRAMING_TOKENS, FRAMING_TOKENS)
    assert (LimitedCounter(codex, 12288).context_tokens, LimitedCounter(codex, 12288).excluded_tokens) == (12288, 0)
    assert LimitedCounter(codex, CONTEXT_TOKENS, exclude_framing=True).context_tokens == CONTEXT_TOKENS  # never above
    assert LimitedCounter(SimpleNamespace(context_tokens=32768), 12288, exclude_framing=True).context_tokens == 12288


SECTIONS = ["Viega price list."] + [f"Section {n}. " + "filler " * 300 for n in range(12)] + ["All prices in USD."]


def article_on_codex(settings: dict | None, chat=None):
    """An Article run over `SECTIONS` on Codex counters: its artifact, or what it raised, and the calls it sent."""
    from kei_exp.kie.extract import run
    from tests.helpers.chat import FakeChat
    from tests.test_article_grounding_scale import SCHEMA as PRICE_LIST, labelling
    from tests.test_extract_grounded import keeps_every_reading, resolving
    from tests.test_extract_stages import evidence, passages

    def script(system, user, schema):
        if "items" in schema["properties"]:
            return {"publisher": "Viega", "currency": "USD", "items": []}
        return keeps_every_reading(schema) if resolving(user) else labelling([])(system, user, schema)
    sent = FakeChat(script)
    options = {"strategy": "article", **({"article": settings} if settings is not None else {})}
    request = run.ExtractRequest.model_validate({"schema": {**PRICE_LIST.model_dump(by_alias=True, exclude_none=True),
        "recordScope": "document"}, "options": options})
    counter = CodexChat(model="test-model").counter
    try:
        outcome = run.dispatch(None, evidence(passages(SECTIONS)), request, chat or sent,
                               counter={"fields": counter(), "reasoning": counter()})
    except Exception as error:  # noqa: BLE001 - the outcome under test
        outcome = error
    return outcome, sent.calls


def test_codex_settings_without_overflow_windows_send_the_requests_9ef058d2_sent():
    """Requests and reply reserves captured from 9ef058d2 on Codex counters, whose framing every count holds."""
    import hashlib
    captured = {
        None: "a0e048a3e468b3cf8c7043825c7874dbb4465c23c60df65a1e3bc72abaee097c",
        "full": "a0e048a3e468b3cf8c7043825c7874dbb4465c23c60df65a1e3bc72abaee097c",
        32768: "e9ea802813ba28b564be7db3164c2a305ce0b200375978975f237ba63da85e31",
        24576: "f9d36b14ef40fdc031437859d6c78f4af9c0ee50f078ee2073607e1806b7791a",
    }
    for setting, digest in captured.items():
        settings = (None if setting is None else {"context": "full"} if setting == "full" else
                    {"context": "bounded", "context_tokens": setting})
        result, sent = article_on_codex(settings)
        assert hashlib.sha256(json.dumps(sent, ensure_ascii=False, sort_keys=True).encode()).hexdigest() == digest
        assert not result["issues"] and "grounding_overflow_version" not in result
    # As at 9ef058d2, a 12,288-token ceiling without the factor holds only the framing: no root is answered.
    result, sent = article_on_codex({"context": "bounded", "context_tokens": 12288})
    assert "article_root_unanswered" in str(result) and not sent


def test_codex_reads_the_default_bounded_contexts_directly_and_under_durable_planning():
    """Each root keeps a reply as large as its source, the framing aside (`invalid required reply reserve` before)."""
    from kei_exp.kie.extract.durable import CapturePlanner, NeedsCall
    from kei_exp.kie.extract.models import Router
    from tests.helpers.chat import FakeChat
    from tests.test_article_grounding_scale import SCHEMA as PRICE_LIST
    from tests.test_durable_extraction import MemoryLease
    defaults = {"context": "bounded", "grounding_overflow": "windows"}
    result, sent = article_on_codex(defaults)
    assert not result["issues"] and result["grounding_overflow_version"] == 1
    assert all(call["max_tokens"] <= 12288 for call in sent) and len(result["contexts"]) > 1
    lease = MemoryLease(PRICE_LIST.model_dump(by_alias=True, exclude_none=True))
    counter = CodexChat(model="test-model").counter
    planner, chat = CapturePlanner(lease, {"fields": counter(), "reasoning": counter()}), FakeChat(lambda *_: {})
    with pytest.raises(NeedsCall):  # the first root captured for the worker, not refused
        article_on_codex(defaults, Router(chat, chat, planner))
    assert [unit["input"]["request"]["body"]["max_tokens"] for unit in lease.units.values()] == [sent[0]["max_tokens"]]


def test_codex_catalog_populates_both_extraction_roles(monkeypatch):
    from kei_exp import api
    from kei_exp.kie.extract import codex, models
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry({"KEI_EXTRACT_PROVIDER": "codex-cli", "KEI_EXTRACT_MODEL": "gpt-5.6-sol"}))
    monkeypatch.setattr(codex, "available_models", lambda: ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-sol"], raising=False)
    listing = api.list_extraction_models()
    assert {m["repo"] for m in listing["models"]} == {"gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-sol"}
    assert all(m["serving"] and m["reachable"] and m["roles"] == ["fields", "reasoning"] for m in listing["models"])
    assert listing["defaults"] == {"fields": "instruct", "reasoning": "instruct"}


def test_selected_codex_models_reach_the_clients_without_discovery_during_planning(monkeypatch):
    from kei_exp.kie.extract import codex, models
    from kei_exp.kie.extract.run import Options
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry({"KEI_EXTRACT_PROVIDER": "codex-cli", "KEI_EXTRACT_MODEL": "gpt-5.6-sol"}))
    def no_discovery():
        raise AssertionError("Planning must not query model discovery")
    monkeypatch.setattr(codex, "available_models", no_discovery, raising=False)
    options = Options(models={"fields": "codex:gpt-6.1-sol", "reasoning": "codex:gpt-6-luna"})
    router = models.chats_for(options)
    assert router.fields.model == "gpt-6.1-sol" and router.reasoning.model == "gpt-6-luna"
    assert isinstance(router.fields, CodexChat) and isinstance(router.reasoning, CodexChat)



def test_model_discovery_reads_all_pages_without_starting_an_inference(server):
    from kei_exp.kie.extract.codex import available_models
    low = [{"reasoningEffort": "low", "description": ""}, {"reasoningEffort": "high", "description": ""}]
    recorded = server(catalog=[
        {"data": [{"id": "gpt-6.1-sol", "supportedReasoningEfforts": low},
                  {"id": "hidden", "hidden": True, "supportedReasoningEfforts": low}], "nextCursor": "1"},
        {"data": [{"model": "gpt-6-luna", "id": "display-only", "supportedReasoningEfforts": low},
                  {"id": "gpt-6.1-sol", "supportedReasoningEfforts": low},
                  # Extraction requests low effort; a model that would reject it is not offered.
                  {"id": "high-only", "supportedReasoningEfforts": low[1:]}, {"id": "unadvertised"}],
         "nextCursor": None}])
    assert available_models() == ["gpt-6.1-sol", "gpt-6-luna"]
    requests = [json.loads(line) for line in recorded.read_text().splitlines()]
    assert [r["method"] for r in requests] == ["initialize", "initialized", "model/list", "model/list"]
    assert requests[-1]["params"]["cursor"] == "1"


@pytest.mark.parametrize("catalog", [
    [{"data": [] , "nextCursor": "0"}, {"data": [], "nextCursor": "0"}],
    [{"data": "invalid"}],
])
def test_invalid_discovery_fails_without_leaking_the_process(server, catalog):
    from kei_exp.kie.extract.codex import available_models
    server(catalog=catalog)
    with pytest.raises(ModelOutputError, match="invalid model catalog"):
        available_models()


def test_failed_discovery_keeps_the_default_visible_but_unavailable(monkeypatch):
    from kei_exp import api
    from kei_exp.kie.extract import codex, models
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry({"KEI_EXTRACT_PROVIDER": "codex-cli", "KEI_EXTRACT_MODEL": "old-model"}))
    def fail():
        raise TimeoutError("Unavailable")
    monkeypatch.setattr(codex, "available_models", fail)
    listing = api.list_extraction_models()
    assert listing["models"] == [{"key": "instruct", "repo": "old-model", "roles": ["fields", "reasoning"], "reachable": False, "serving": False}]


@pytest.mark.parametrize("provider,key", [("vllm", "codex:gpt-6.1-sol"), ("codex-cli", "codex:"),
                                          ("codex-cli", "codex:invalid model"), ("codex-cli", "codex:" + "a" * 123)])
def test_codex_choices_cannot_enable_a_backend_or_supply_an_invalid_id(monkeypatch, provider, key):
    from kei_exp.kie.extract import models
    from kei_exp.kie.extract.run import Options
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry({"KEI_EXTRACT_PROVIDER": provider, "KEI_EXTRACT_MODEL": "default-model"}))
    with pytest.raises(ValueError, match="unknown extraction model"):
        Options(models={"fields": key})
