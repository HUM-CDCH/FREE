from types import SimpleNamespace
import json
import hashlib
from pathlib import Path

import pytest

import run_bounded as runner
from experiments.harness.model import BudgetExceeded, Provider


def test_deadline_denies_new_reservations_without_refunding_prior_calls(monkeypatch, tmp_path):
    now = [10]
    monkeypatch.setattr(runner.time, 'monotonic', lambda: now[0])
    allowance = runner.DeadlineAllowance(4, 20, tmp_path / 'STOP_REQUESTS')
    allowance.take()
    assert allowance.remaining == 3
    now[0] = 20
    with pytest.raises(BudgetExceeded, match='deadline'):
        allowance.take()
    assert allowance.remaining == 0 and allowance.denied == 1


def test_stop_file_blocks_new_calls(tmp_path):
    stop = tmp_path / 'STOP_REQUESTS'
    stop.touch()
    allowance = runner.DeadlineAllowance(4, float('inf'), stop)
    with pytest.raises(BudgetExceeded):
        allowance.take()
    assert allowance.remaining == 0


def test_inflight_call_drains_with_identical_arguments_and_cache_identity(monkeypatch, tmp_path):
    now = [10]
    monkeypatch.setattr(runner.time, 'monotonic', lambda: now[0])
    received = []
    reply = SimpleNamespace(input_tokens=12, output_tokens=8, seconds=2.0, finish='stop')
    class Chat:
        model = 'fake'
        def complete(self, **kw):
            received.append(kw)
            now[0] = 25
            return reply
    chat = Chat()
    original_type = type(chat)
    request = {'system': 's', 'user': 'u', 'schema': None, 'max_tokens': 40, 'seed': 7}
    provider = Provider(chat)
    original_key = provider.key(request)
    runner.journal_calls(chat, tmp_path / 'journal')
    allowance = runner.DeadlineAllowance(3, 20, tmp_path / 'STOP_REQUESTS')
    allowance.take()
    assert chat.complete(**request) is reply
    assert received == [request] and type(chat) is original_type
    assert provider.key(request) == original_key
    assert json.loads((tmp_path / 'journal/request-0001.finished.json').read_text())['output_tokens'] == 8
    with pytest.raises(BudgetExceeded):
        allowance.take()
    assert len(list((tmp_path / 'journal').glob('*.started.json'))) == 1


def test_failed_transport_is_journaled_as_unknown_not_zero(tmp_path):
    class Chat:
        def complete(self, **kw):
            raise OSError('lost connection')
    chat = Chat()
    runner.journal_calls(chat, tmp_path)
    with pytest.raises(OSError):
        chat.complete(max_tokens=4096)
    started = json.loads((tmp_path / 'request-0001.started.json').read_text())
    finished = json.loads((tmp_path / 'request-0001.finished.json').read_text())
    assert started['unknown_token_upper_bound'] == 36864
    assert finished['unknown_usage'] == 1 and 'output_tokens' not in finished


def test_changed_preflight_is_rejected_before_starting_run(monkeypatch, tmp_path):
    study = {'budget': {'max_calls': 400}, 'final': None, 'provider': {}}
    (tmp_path / 'execution-study.json').write_text(json.dumps(study))
    (tmp_path / 'preflight.json').write_text(json.dumps({
        'study_nominal_calls_fit': True, 'fresh_completion_calls': 0, 'provider': {}}))
    (tmp_path / 'launch-manifest.json').write_text(json.dumps({'pins': {},
        'preflight_sha256': 'changed',
        'study_file_sha256': hashlib.sha256((tmp_path / 'execution-study.json').read_bytes()).hexdigest(),
        'runner_sha256': hashlib.sha256(Path(runner.__file__).read_bytes()).hexdigest()}))
    monkeypatch.setattr(runner.studies, 'expand', lambda _: {'base': SimpleNamespace(budget=SimpleNamespace(workers=1))})
    monkeypatch.setattr(runner.studies, 'make_provider', lambda *a: SimpleNamespace(identity={}, counter=object()))
    monkeypatch.setattr(runner.studies, 'pins_of', lambda *a: {})
    monkeypatch.setattr(runner.studies, 'run_study', lambda *a, **kw: pytest.fail('inference must not start'))
    monkeypatch.setattr('sys.argv', ['run_bounded.py', str(tmp_path), '--hours', '8'])
    with pytest.raises(AssertionError, match='Preflight changed'):
        runner.main()
    assert not (tmp_path / 'runner-started.json').exists()
