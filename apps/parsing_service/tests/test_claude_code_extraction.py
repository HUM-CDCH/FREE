"""Claude Code isolation, event checks and conservative budgets through real child processes, without model access."""
import json
import os
import sys
import time

import pytest

from kei_exp.kie.extract.claude_code import CONTEXT_TOKENS, POLICY, ClaudeCodeChat
from kei_exp.kie.extract.llm import ModelOutputError
from kei_exp.kie.extract.models import defaults, registry
from kei_exp.kie.extract.calls import complete
from kei_exp.kie.extract.tokens import counter_for
from kei_exp.workflows.durable_extract import PinnedCounter, chat_for

SCHEMA = {"type": "object", "properties": {"identifier": {"type": "string", "x-free-type": "string"}},
          "required": ["identifier"], "additionalProperties": False}
PLAIN = {"type": "object", "properties": {"identifier": {"type": "string"}},
         "required": ["identifier"], "additionalProperties": False}
MODEL = "claude-test-1"


@pytest.fixture
def cli(tmp_path, monkeypatch):
    def configure(*, tools=("StructuredOutput",), mcp=(), blocks=None, compact=False, models=None,
                  usage=None, window=200000, result=None, structured=True, hang=False, stall=False,
                  logged_in=True, emit_result=True):
        script = tmp_path / "fake-claude"
        recorded = tmp_path / "invocation.json"
        settings = dict(tools=list(tools), mcp=list(mcp), compact=compact, hang=hang, stall=stall,
                        logged_in=logged_in, emit_result=emit_result, window=window, structured=structured,
                        blocks=blocks or [{"type": "thinking", "thinking": ""},
                                          {"type": "tool_use", "name": "StructuredOutput",
                                           "input": {"identifier": "FREE-LOCAL-001"}}],
                        models=models or [MODEL],
                        usage=usage or {"input_tokens": 2, "cache_read_input_tokens": 0,
                                        "cache_creation_input_tokens": 98, "output_tokens": 20},
                        result=result or {"subtype": "success", "is_error": False})
        script.write_text(f"#!{sys.executable}\n" + """
import json, os, sys, time
settings = SETTINGS

def emit(event):
    print(json.dumps(event), flush=True)

if sys.argv[1:3] == ['auth', 'status']:
    emit({'loggedIn': settings['logged_in'], 'authMethod': 'oauth_token'})
    sys.exit(0)
if settings['stall']:
    time.sleep(60)
source = sys.stdin.read()
with open(RECORDED, 'w') as saved:
    json.dump({'arguments': sys.argv[1:], 'source': source, 'cwd': os.getcwd(), 'environment': dict(os.environ)}, saved)
emit({'type': 'system', 'subtype': 'init', 'tools': settings['tools'], 'mcp_servers': settings['mcp'],
      'model': settings['models'][0]})
if settings['hang']:
    time.sleep(60)
if settings['compact']:
    emit({'type': 'system', 'subtype': 'compact_boundary'})
for piece in ('{"ident', 'ifier":"FREE-LOCAL-001"}'):
    emit({'type': 'stream_event', 'event': {'type': 'content_block_delta',
          'delta': {'type': 'input_json_delta', 'partial_json': piece}}})
emit({'type': 'assistant', 'message': {'content': settings['blocks']}})
if settings['emit_result']:
    emit({'type': 'result', **settings['result'], 'usage': settings['usage'],
          **({'structured_output': {'identifier': 'FREE-LOCAL-001'}} if settings['structured'] else {}),
          'modelUsage': {model: {'contextWindow': settings['window']} for model in settings['models']}})
""".replace("SETTINGS", repr(settings)).replace("RECORDED", repr(str(recorded))))
        script.chmod(0o700)
        monkeypatch.setenv("KEI_CLAUDE_BINARY", str(script))
        return recorded
    return configure


def extract(chat=None):
    return (chat or ClaudeCodeChat(model=MODEL, timeout=3)).complete(
        system="Extract the identifier.", user="Document identifier: FREE-LOCAL-001.", schema=SCHEMA)


def test_one_isolated_structured_turn_and_reported_usage(cli, monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "deployment-token")
    monkeypatch.setenv("FREE_KEI_POSTGRES_PASSWORD", "never-forwarded")
    recorded = cli()
    reply = extract()
    assert json.loads(reply.text) == {"identifier": "FREE-LOCAL-001"}
    # Cache creation is input: a long source is reported almost entirely there.
    assert (reply.input_tokens, reply.output_tokens, reply.finish) == (100, 20, "stop")
    invocation = json.loads(recorded.read_text())
    arguments = invocation["arguments"]
    assert arguments[arguments.index("--tools") + 1] == ""
    assert arguments[arguments.index("--setting-sources") + 1] == ""
    assert {"--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"} <= set(arguments)
    assert arguments[arguments.index("--model") + 1] == MODEL
    assert arguments[arguments.index("--system-prompt") + 1] == "Extract the identifier."
    assert json.loads(arguments[arguments.index("--json-schema") + 1]) == PLAIN
    assert invocation["source"] == "Document identifier: FREE-LOCAL-001."
    environment = invocation["environment"]
    assert environment["CLAUDE_CODE_OAUTH_TOKEN"] == "deployment-token"
    assert environment["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
    assert environment["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "8192"
    home = os.path.realpath(environment["HOME"])
    assert home == os.path.realpath(invocation["cwd"]) and os.path.realpath(environment["CLAUDE_CONFIG_DIR"]).startswith(home)
    assert "FREE_KEI_POSTGRES_PASSWORD" not in environment


@pytest.mark.parametrize("settings", [
    {"tools": ["StructuredOutput", "Bash"]},
    {"mcp": [{"name": "server", "status": "connected"}]},
    {"blocks": [{"type": "tool_use", "name": "Bash", "input": {}}]},
    {"blocks": [{"type": "server_tool_use", "name": "web_search", "input": {}}]},
])
def test_tools_are_refused(cli, settings):
    cli(**settings)
    with pytest.raises(ModelOutputError, match="tools"):
        extract()


def test_compaction_is_refused(cli):
    cli(compact=True)
    with pytest.raises(ModelOutputError, match="compacted"):
        extract()


def test_a_call_to_any_other_model_is_refused(cli):
    cli(models=[MODEL, "claude-background-1"])
    with pytest.raises(ModelOutputError, match="not only"):
        extract()


@pytest.mark.parametrize("settings", [
    {"usage": {"output_tokens": 20}},
    {"usage": {"input_tokens": 50000, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 20}},
    {"window": 8192},
    {"usage": {"input_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 8193}},
    {"result": {"subtype": "success", "is_error": True}},
    {"result": {"subtype": "error_max_turns", "is_error": False}},
    {"structured": False},
    {"emit_result": False},
])
def test_unverified_or_exceeded_budgets_and_failed_turns_are_refused(cli, settings):
    cli(**settings)
    with pytest.raises(ModelOutputError):
        extract()


def test_a_hung_child_is_terminated_within_the_call_deadline(cli):
    cli(hang=True)
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        extract(ClaudeCodeChat(model=MODEL, timeout=0.3))
    assert time.monotonic() - started < 3


def test_a_child_that_stops_reading_cannot_block_the_source_write_past_the_deadline(cli):
    cli(stall=True)
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        ClaudeCodeChat(model=MODEL, timeout=0.5, max_tokens=1024).complete(
            system="S", user="文" * 19000, schema=SCHEMA)
    assert time.monotonic() - started < 3


def test_oversize_source_is_refused_before_starting_a_process(monkeypatch):
    monkeypatch.setenv("KEI_CLAUDE_BINARY", "/no/such/binary")
    with pytest.raises(ModelOutputError, match="budget"):
        ClaudeCodeChat(model=MODEL).complete(system="S", user="x" * CONTEXT_TOKENS, schema=SCHEMA)


def test_counter_labels_multilingual_bytes_as_an_upper_bound():
    counter = counter_for(ClaudeCodeChat(model=MODEL))
    assert counter.identity()["source"] == POLICY
    assert counter.identity()["input_counting"] == "upper_bound"
    assert counter.request_tokens("S", "中文", SCHEMA) > counter.request_tokens("S", "ab", SCHEMA)


def test_deployment_registry_pins_claude_code_for_both_roles_and_requires_a_model():
    models = registry({"KEI_EXTRACT_PROVIDER": "claude-code", "KEI_EXTRACT_MODEL": MODEL})
    assert defaults(models) == {"fields": "instruct", "reasoning": "instruct"}
    assert isinstance(models["instruct"].chat(), ClaudeCodeChat)
    for invalid in ({}, {"KEI_EXTRACT_MODEL": "invalid model"}):
        with pytest.raises(ValueError, match="requires KEI_EXTRACT_MODEL"):
            registry({"KEI_EXTRACT_PROVIDER": "claude-code", **invalid})


def test_durable_provider_and_budget_preserve_actual_usage_without_exact_equality(cli):
    cli()
    provider = {"adapterVersion": 1, "adapter": "claude-code", "model": MODEL, "url": "claude://local",
                "timeout": 3, "maxTokens": 8192}
    chat = chat_for(provider)
    counter = PinnedCounter({"context": CONTEXT_TOKENS, "counted": 4500}, upper_bound=True)
    parsed, calls = complete(chat, stage="record", record=0, system="Extract the identifier.",
                             user="Document identifier: FREE-LOCAL-001.", schema=SCHEMA, counter=counter, max_tokens=8192)
    assert parsed == {"identifier": "FREE-LOCAL-001"} and calls[-1].ok
    assert calls[-1].input_tokens == 100 and calls[-1].counted_input_tokens == 4500


def test_saved_provider_payload_is_sent_without_recomposition_and_streamed(cli):
    from kei_exp.kie.extract.captured_provider import CapturedChat
    recorded = cli()
    payload = ClaudeCodeChat(model=MODEL).request_body(system="Pinned instructions.", user="Pinned source.", schema=SCHEMA)
    shown = []
    reply = CapturedChat({"adapter": "claude-code", "model": MODEL, "timeout": 3}, payload, on_text=shown.append).complete(
        system="Changed instructions", user="Changed source", schema={})
    assert json.loads(reply.text)["identifier"] == "FREE-LOCAL-001"
    assert "".join(shown) == '{"identifier":"FREE-LOCAL-001"}'
    invocation = json.loads(recorded.read_text())
    assert invocation["arguments"][invocation["arguments"].index("--system-prompt") + 1] == "Pinned instructions."
    assert invocation["source"] == "Pinned source."


def test_limited_claude_code_counters_retain_the_explicit_usage_policy():
    from kei_exp.kie.extract.method import LimitedCounter
    assert LimitedCounter(ClaudeCodeChat(model=MODEL).counter(), 32768).upper_bound


@pytest.mark.parametrize("logged_in", [True, False])
def test_listing_offers_the_deployment_model_once_a_credential_is_configured(cli, monkeypatch, logged_in):
    from kei_exp import api
    from kei_exp.kie.extract import models
    cli(logged_in=logged_in)
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry({"KEI_EXTRACT_PROVIDER": "claude-code", "KEI_EXTRACT_MODEL": MODEL}))
    listing = api.list_extraction_models()
    assert listing["models"] == [{"key": "instruct", "repo": MODEL, "roles": ["fields", "reasoning"],
                                  "reachable": logged_in, "serving": logged_in}]
    assert listing["defaults"] == {"fields": "instruct", "reasoning": "instruct"}


def test_a_missing_cli_keeps_the_default_visible_but_unavailable(monkeypatch):
    from kei_exp import api
    from kei_exp.kie.extract import models
    monkeypatch.setenv("KEI_CLAUDE_BINARY", "/no/such/binary")
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry({"KEI_EXTRACT_PROVIDER": "claude-code", "KEI_EXTRACT_MODEL": MODEL}))
    assert api.list_extraction_models()["models"][0]["reachable"] is False


@pytest.mark.parametrize("key", ["claude:" + MODEL, "codex:" + MODEL])
def test_choices_cannot_name_a_model_the_deployment_did_not_select(monkeypatch, key):
    from kei_exp.kie.extract import models
    from kei_exp.kie.extract.run import Options
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry({"KEI_EXTRACT_PROVIDER": "claude-code", "KEI_EXTRACT_MODEL": MODEL}))
    with pytest.raises(ValueError, match="unknown extraction model"):
        Options(models={"fields": key})
