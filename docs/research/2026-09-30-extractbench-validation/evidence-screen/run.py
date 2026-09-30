"""Run the frozen A0/A3 evidence screen group by group through the existing run_study/execute_cell accounting.

Reuses the prior run's CutoffAllowance and completion journal unchanged; adds a journal of the auxiliary /tokenize and
/models requests and sets the allowance to the contract's attempts minus every journalled attempt, so a restart resumes
the same counters and clock and never renews them. Run from prototypes/parsing_service, under a hard kill at the
deadline (see README): python PATH/run.py RUN_ROOT [--groups N]
"""
import argparse
import hashlib
import importlib.util
import json
from datetime import datetime, timedelta
from pathlib import Path

import requests

from experiments.extraction.manifest import write_new
from experiments.harness import study as studies
from kei_exp.canonical import canonical_json

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('run_paired', HERE.parent / 'corrected-comparison/run_paired.py')
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)
now, file_sha = prior.now, prior.file_sha


def journal_auxiliary(directory):
    """Journal every /tokenize POST and /models GET (they spend no completion slot but are work on the model server)."""
    directory.mkdir(exist_ok=True)
    serial = len(list(directory.glob('*.json')))
    post, get = requests.post, requests.get

    def logged(method, send):
        def call(url, *args, **kwargs):
            nonlocal serial
            if not (url.endswith('/tokenize') or url.endswith('/models')):
                return send(url, *args, **kwargs)
            serial += 1
            entry = {'at': now().isoformat(), 'method': method, 'endpoint': url.rsplit('/', 1)[1]}
            try:
                response = send(url, *args, **kwargs)
                entry['status'] = response.status_code
                return response
            except BaseException as error:
                entry['error_type'] = type(error).__name__
                raise
            finally:
                write_new(directory / f'aux-{serial:05}.json', entry | {'finished_at': now().isoformat()})
        return call
    requests.post, requests.get = logged('POST', post), logged('GET', get)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--groups', type=int, default=None, help='only the first N scheduled groups (the smoke uses 1)')
    args = parser.parse_args()
    root = args.root.resolve()
    contract = json.loads((root / 'contract.json').read_text())
    ident, budget = contract['identity'], contract['budget']
    assert file_sha(__file__) == ident['runner_sha256'], 'runner changed after freeze'
    assert file_sha(HERE.parent / 'corrected-comparison/run_paired.py') == ident['prior_runner_helpers_sha256']
    assert file_sha(root / 'execution-study.json') == ident['study_file_sha256']
    assert file_sha(root / 'dataset.json') == ident['dataset_file_sha256']
    assert all(file_sha(root / rel) == h for rel, h in ident['copied_files_sha256'].items())
    assert hashlib.sha256(canonical_json(studies.harness_pin(Path.cwd()))).hexdigest() == ident['harness_source_sha256'], 'harness changed'
    study = json.loads((root / 'execution-study.json').read_text())
    assert study['budget']['max_calls'] == budget['provider_attempts'] and study['final'] is None

    clock_file = root / 'run-clock.json'
    if not clock_file.exists():   # persisted before the first model-service contact; a restart reads it and never moves it
        started = now()
        write_new(clock_file, {'started_at': started.isoformat(),
            'admission_cutoff_at': (started + timedelta(minutes=budget['admission_cutoff_minutes'])).isoformat(),
            'deadline_at': (started + timedelta(minutes=budget['elapsed_minutes'])).isoformat()})
    clock = json.loads(clock_file.read_text())
    cutoff = datetime.fromisoformat(clock['admission_cutoff_at'])
    if now() >= cutoff:
        raise SystemExit('admission cutoff already passed; nothing may be dispatched')

    journal = root / 'request-journal'
    journal_auxiliary(root / 'auxiliary-journal')
    provider = studies.make_provider(study['provider'], root / 'out/cache')
    served = provider.identity['served'] or {}
    assert served.get('id') == served.get('root') == study['provider']['model'] and served.get('max_model_len') == 32768
    assert provider.counter is not None and provider.identity['context_tokens'] == 32768
    configs = studies.expand(study)
    cases = {c.id: c for c in studies.load_cases(root / 'dataset.json')}
    groups = sorted({s['group_index'] for s in contract['schedule']})[:args.groups]
    plan = [(s['arm'], configs[s['arm']], cases[s['case']]) for s in contract['schedule'] if s['group_index'] in groups]
    prior.journal_calls(provider.chat, journal)
    left = budget['provider_attempts'] - len(list(journal.glob('*.started.json')))    # every attempt ever journalled is spent
    stop = root / 'STOP_REQUESTS'
    original_order, original_allowance = studies.cells_to_run, studies.Allowance
    studies.cells_to_run = lambda *_: plan
    studies.Allowance = lambda calls: prior.CutoffAllowance(max(0, min(calls, left)), cutoff, stop)
    invocation = {'at': now().isoformat(), 'groups': groups, 'cells': len(plan), 'attempts_left_at_start': left}
    try:
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
