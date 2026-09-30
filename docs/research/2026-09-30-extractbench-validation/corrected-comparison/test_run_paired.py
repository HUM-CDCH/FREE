import importlib.util
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from experiments.harness.model import BudgetExceeded

spec = importlib.util.spec_from_file_location('run_paired', Path(__file__).with_name('run_paired.py'))
run_paired = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run_paired)


def test_cutoff_refuses_after_persisted_time_and_on_stop_file(tmp_path):
    allowance = run_paired.CutoffAllowance(2, run_paired.now() + timedelta(hours=1), tmp_path / 'STOP')
    allowance.take()
    assert allowance.remaining == 1
    (tmp_path / 'STOP').touch()
    with pytest.raises(BudgetExceeded):
        allowance.take()
    assert allowance.remaining == 0 and allowance.denied == 1
    late = run_paired.CutoffAllowance(5, run_paired.now() - timedelta(seconds=1), tmp_path / 'none')
    with pytest.raises(BudgetExceeded):
        late.take()


def test_journal_numbering_continues_after_restart_and_records_failures(tmp_path):
    reply = SimpleNamespace(input_tokens=3, output_tokens=4, seconds=0.1, finish='stop')
    for _ in range(2):    # two processes, one request each
        chat = SimpleNamespace(complete=lambda **_: reply)
        run_paired.journal_calls(chat, tmp_path / 'journal')
        chat.complete(max_tokens=8, user='x')

    def boom(**_):
        raise OSError('down')
    chat = SimpleNamespace(complete=boom)
    run_paired.journal_calls(chat, tmp_path / 'journal')
    with pytest.raises(OSError):
        chat.complete(max_tokens=8)
    names = sorted(p.name for p in (tmp_path / 'journal').iterdir())
    assert names == [f'request-{i:04}.{s}.json' for i in (1, 2, 3) for s in ('finished', 'started')]
    assert '"failed"' in (tmp_path / 'journal' / 'request-0003.finished.json').read_text()
