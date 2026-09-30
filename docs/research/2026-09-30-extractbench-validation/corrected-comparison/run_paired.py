"""Run the frozen corrected-schema comparison group by group through the existing run_study/execute_cell accounting.

Only the cell order changes (contract schedule instead of the seeded shuffle) and request admission gains a persisted
wall-clock cutoff. Prompts, payloads, recovery, scoring and cell budgets are the harness's own. Resuming reads the same
clock and allowance; it never renews either. Run from prototypes/parsing_service:
python PATH/run_paired.py RUN_ROOT [--groups N]
"""
import argparse
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from experiments.extraction.manifest import write_new
from experiments.harness import study as studies
from experiments.harness.model import Allowance, BudgetExceeded
from kei_exp.canonical import canonical_json

now = lambda: datetime.now(UTC)
file_sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()


class CutoffAllowance(Allowance):
    """The study allowance, refusing every request at or after the persisted admission cutoff or once STOP_REQUESTS exists."""

    def __init__(self, calls, cutoff, stop_file):
        super().__init__(calls)
        self.cutoff, self.stop_file = cutoff, stop_file

    def take(self):
        if now() >= self.cutoff or self.stop_file.exists():
            with self._lock:
                self.remaining = 0
                self.denied += 1
            raise BudgetExceeded('admission cutoff or stop file reached')
        super().take()


def journal_calls(chat, directory):
    """Journal every fresh completion HTTP attempt; numbering continues across restarts."""
    directory.mkdir(exist_ok=True)
    original, serial = chat.complete, len(list(directory.glob('*.started.json')))

    def complete(**request):
        nonlocal serial
        serial += 1
        prefix = directory / f'request-{serial:04}'
        write_new(prefix.with_suffix('.started.json'), {'at': now().isoformat(),
            'request_sha256': hashlib.sha256(canonical_json(request)).hexdigest(), 'max_output_tokens': request['max_tokens']})
        try:
            reply = original(**request)
        except BaseException as error:
            write_new(prefix.with_suffix('.finished.json'), {'status': 'failed', 'error_type': type(error).__name__,
                                                            'unknown_usage': 1, 'at': now().isoformat()})
            raise
        write_new(prefix.with_suffix('.finished.json'), {'status': 'completed', 'input_tokens': reply.input_tokens,
            'output_tokens': reply.output_tokens, 'seconds': reply.seconds, 'finish': reply.finish, 'at': now().isoformat()})
        return reply

    chat.complete = complete


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--groups', type=int, default=None, help='only the first N scheduled groups (the smoke uses 1)')
    args = parser.parse_args()
    root = args.root.resolve()
    contract = json.loads((root / 'contract.json').read_text())
    ident, budget = contract['identity'], contract['budget']
    assert file_sha(__file__) == ident['runner_sha256'], 'runner changed after freeze'
    assert file_sha(root / 'execution-study.json') == ident['study_file_sha256']
    assert file_sha(root / 'dataset.json') == ident['dataset_file_sha256']
    assert all(file_sha(root / rel) == h for rel, h in ident['copied_files_sha256'].items())
    assert hashlib.sha256(canonical_json(studies.harness_pin(Path.cwd()))).hexdigest() == ident['harness_source_sha256'], 'harness changed'
    study = json.loads((root / 'execution-study.json').read_text())
    assert study['budget']['max_calls'] == budget['provider_attempts'] == 240 and study['final'] is None

    clock_file = root / 'run-clock.json'
    if not clock_file.exists():   # persisted before the first request; a restart reads it and never moves it
        started = now()
        write_new(clock_file, {'started_at': started.isoformat(),
            'admission_cutoff_at': (started + timedelta(minutes=budget['admission_cutoff_minutes'])).isoformat(),
            'deadline_at': (started + timedelta(minutes=budget['elapsed_minutes'])).isoformat()})
    clock = json.loads(clock_file.read_text())
    cutoff = datetime.fromisoformat(clock['admission_cutoff_at'])
    if now() >= cutoff:
        raise SystemExit('admission cutoff already passed; nothing may be dispatched')

    provider = studies.make_provider(study['provider'], root / 'out/cache')
    served = provider.identity['served'] or {}
    assert served.get('id') == served.get('root') == study['provider']['model'] and served.get('max_model_len') == 32768
    assert provider.counter is not None and provider.identity['context_tokens'] == 32768
    configs = studies.expand(study)
    cases = {c.id: c for c in studies.load_cases(root / 'dataset.json')}
    groups = sorted({s['group_index'] for s in contract['schedule']})[:args.groups]
    plan = [(s['arm'], configs[s['arm']], cases[s['case']]) for s in contract['schedule'] if s['group_index'] in groups]
    journal_calls(provider.chat, root / 'request-journal')
    stop = root / 'STOP_REQUESTS'
    original_order, original_allowance = studies.cells_to_run, studies.Allowance
    studies.cells_to_run = lambda *_: plan
    studies.Allowance = lambda calls: CutoffAllowance(calls, cutoff, stop)
    invocation = {'at': now().isoformat(), 'groups': groups, 'cells': len(plan)}
    try:   # force: the full schedule's nominal calls exceed 240 by design; the allowance, not the projection, is the cap
        outcome = studies.run_study(root / 'execution-study.json', root / 'out', execute=True, uncounted=False,
                                    splits=['dev'], variants=None, provider=provider, force=True)
        invocation |= {'status': 'finished', 'outcome': outcome, 'allowance_remaining': provider.allowance.remaining,
                       'allowance_denied': provider.allowance.denied}
    except BaseException as error:
        invocation |= {'status': 'failed', 'error_type': type(error).__name__, 'error': str(error)[:500]}
        raise
    finally:
        studies.cells_to_run, studies.Allowance = original_order, original_allowance
        invocation['finished_at'] = now().isoformat()
        with (root / 'invocations.jsonl').open('a') as log:
            log.write(json.dumps(invocation) + '\n')


if __name__ == '__main__':
    main()
