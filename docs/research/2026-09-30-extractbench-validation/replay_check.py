"""Recheck this frozen smoke archive on the final accounting revision.

Run from prototypes/parsing_service: python PATH/replay_check.py SMOKE_ROOT REPORT NEW_REPLAY_DIR
Both cache misses and direct completion calls are blocked. Provider/tokenizer identity reads remain.
"""
import json
import sys
from pathlib import Path

from experiments.extraction.manifest import digest, write_new
from experiments.harness.study import compare_study, make_provider, run_study
from kei_exp.canonical import canonical_json

root = Path(sys.argv[1])
reference_report = Path(sys.argv[2])
out = Path(sys.argv[3]) / 'out'
study = json.loads((root / 'study.json').read_text())
provider = make_provider(study['provider'], root / 'out/cache')
original_lookup = provider.lookup

def saved_only(key):
    reply = original_lookup(key)
    if reply is None:
        raise RuntimeError('Missing saved reply; fresh completion requests are disabled')
    return reply

def no_generation(**kwargs):
    raise AssertionError('Fresh completion requests are disabled')

provider.lookup = saved_only
provider.chat.complete = no_generation
execution = run_study(root / 'study.json', out, execute=True, uncounted=False,
                      splits=['dev'], variants=None, provider=provider)
assert execution['fresh_calls_spent'] == 0 and execution['executed'] == {'completed': 12}
rows = []
for result in sorted((root / 'out/cells').glob('*/result.json')):
    before = json.loads(result.read_text())['artifact']
    after = json.loads((out / 'cells' / result.parent.name / 'result.json').read_text())['artifact']
    content = lambda a: {k: v for k, v in a.items() if k not in ('calls', 'tokens', 'cost')}
    assert content(before) == content(after), result.parent.name
    assert after['cost']['fresh']['calls'] == 0
    rows.append({'cell': result.parent.name, 'prediction_sha256': digest(canonical_json(content(before))),
                 'fresh_calls': 0, 'replayed_calls': after['cost']['replayed']['calls']})
prior = json.loads(reference_report.read_text())
report = compare_study(root / 'study.json', out, 'dev')
for name, variant in report['variants'].items():
    for case, document in variant['documents'].items():
        quality = lambda c: {k: v for k, v in c.items() if not k.startswith(('fresh_', 'replayed_'))}
        assert quality(document['counts']) == quality(prior['variants'][name]['documents'][case]['counts'])
old_manifest = json.loads((root / 'out/manifest.json').read_text())
new_manifest = json.loads((out / 'manifest.json').read_text())
changed = [k for k in old_manifest['code'] if old_manifest['code'][k] != new_manifest['code'][k]]
assert changed == ['experiments/harness/model.py']
summary = {'execution_commit': '2a2b6d4586179919accbae7800d5071a7df6cb00',
           'compatibility_commit': '677ec96f6fc0765d0396df977098b0d373ac0edb',
           'changed_source_files': changed, 'source_aggregate_sha256': digest(canonical_json(new_manifest['code'])),
           'cells': rows, 'fresh_completion_calls': 0, 'replayed_calls': sum(r['replayed_calls'] for r in rows),
           'prediction_and_quality_counts_unchanged': True,
           'excluded_from_prediction_hash': ['calls', 'tokens', 'cost'],
           'usage_gate': 'The original interruption and unknown usage remain; this replay does not reopen expansion.',
           'execution': execution}
write_new(out.parent / 'compatibility.json', summary)
write_new(out.parent / 'report-v2.json', report)
print(json.dumps(summary, indent=2))
