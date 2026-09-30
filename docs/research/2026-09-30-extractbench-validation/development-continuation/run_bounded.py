"""Run this registered continuation with a request-admission deadline and durable usage journal.

No prompt, model payload, extraction, scoring, or recovery setting is changed.
Run from prototypes/parsing_service: python PATH/run_bounded.py DATA_ROOT --hours 8
"""
import argparse
import hashlib
import json
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from experiments.extraction.manifest import write_new
from experiments.harness import study as studies
from experiments.harness.model import Allowance, BudgetExceeded
from kei_exp.canonical import canonical_json


class DeadlineAllowance(Allowance):
    def __init__(self, calls, deadline, stop_file):
        super().__init__(calls)
        self.deadline, self.stop_file = deadline, stop_file

    def take(self):
        if time.monotonic() >= self.deadline or self.stop_file.exists():
            with self._lock:
                self.remaining = 0
                self.denied += 1
            raise BudgetExceeded('continuation request-admission deadline or stop file reached')
        super().take()


def journal_calls(chat, directory):
    """Keep this ResearchChat instance/class and arguments unchanged; journal fresh HTTP attempts only."""
    original = chat.complete
    serial = 0

    def complete(**request):
        nonlocal serial
        serial += 1
        prefix = directory / f'request-{serial:04}'
        write_new(prefix.with_suffix('.started.json'), {
            'at': datetime.now(UTC).isoformat(),
            'adapter_input_sha256': hashlib.sha256(canonical_json(request)).hexdigest(),
            'max_output_tokens': request['max_tokens'],
            'unknown_token_upper_bound': 32768 + request['max_tokens']})
        try:
            reply = original(**request)
        except BaseException as error:
            write_new(prefix.with_suffix('.finished.json'), {'status': 'failed',
                'error_type': type(error).__name__, 'unknown_usage': 1,
                'at': datetime.now(UTC).isoformat()})
            raise
        write_new(prefix.with_suffix('.finished.json'), {'status': 'completed',
            'input_tokens': reply.input_tokens, 'output_tokens': reply.output_tokens,
            'unknown_usage': int(reply.input_tokens is None or reply.output_tokens is None),
            'seconds': reply.seconds, 'finish': reply.finish, 'at': datetime.now(UTC).isoformat()})
        return reply

    chat.complete = complete


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--hours', type=float, default=8)
    args = parser.parse_args()
    root = args.root.resolve()
    assert 0 < args.hours <= 8
    assert not (root / 'runner-started.json').exists(), 'An existing run needs explicit reconciliation, not automatic restart.'
    study = json.loads((root / 'execution-study.json').read_text())
    assert study['budget']['max_calls'] == 400
    assert study['final'] is None
    assert all(c.budget.workers == 1 for c in studies.expand(study).values())
    preflight = json.loads((root / 'preflight.json').read_text())
    assert preflight['study_nominal_calls_fit'] and preflight['fresh_completion_calls'] == 0
    provider = studies.make_provider(study['provider'], root / 'out/cache')
    assert provider.identity == preflight['provider'], 'Provider identity changed after admission.'
    assert provider.counter is not None
    launch = json.loads((root / 'launch-manifest.json').read_text())
    assert hashlib.sha256((root / 'preflight.json').read_bytes()).hexdigest() == launch['preflight_sha256'], 'Preflight changed after admission.'
    assert studies.pins_of(root / 'execution-study.json', study, provider.identity) == launch['pins']
    assert hashlib.sha256((root / 'execution-study.json').read_bytes()).hexdigest() == launch['study_file_sha256']
    assert hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == launch['runner_sha256']
    started = datetime.now(UTC)
    deadline = time.monotonic() + args.hours * 3600
    write_new(root / 'runner-started.json', {'at': started.isoformat(), 'hours': args.hours,
        'admission_deadline_utc': (started + timedelta(hours=args.hours)).isoformat(),
        'fresh_call_cap': 400, 'drain_timeout_seconds': study['provider']['timeout'],
        'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'launch_manifest_sha256': hashlib.sha256((root / 'launch-manifest.json').read_bytes()).hexdigest(),
        'source_aggregate_sha256': hashlib.sha256(canonical_json(studies.harness_pin(Path.cwd()))).hexdigest(),
        'stop_file': 'STOP_REQUESTS'})
    journal_calls(provider.chat, root / 'request-journal')
    original = studies.Allowance
    studies.Allowance = lambda calls: DeadlineAllowance(calls, deadline, root / 'STOP_REQUESTS')
    try:
        outcome = studies.run_study(root / 'execution-study.json', root / 'out',
            execute=True, uncounted=False, splits=['dev'], variants=None, provider=provider)
        write_new(root / 'report-v2.json', studies.compare_study(root / 'execution-study.json', root / 'out', 'dev'))
        write_new(root / 'runner-finished.json', {'at': datetime.now(UTC).isoformat(), 'status': 'finished',
            'admission_deadline_reached': time.monotonic() >= deadline, 'outcome': outcome})
    except BaseException as error:
        write_new(root / 'runner-finished.json', {'at': datetime.now(UTC).isoformat(),
            'status': 'failed', 'error_type': type(error).__name__})
        raise
    finally:
        studies.Allowance = original


if __name__ == '__main__':
    main()
