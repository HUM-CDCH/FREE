import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location('screen', Path(__file__).with_name('analyze.py'))
screen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(screen)


def cell(f1, **paths):
    """paths: name -> (gold, matched, duplicated, spurious); the root is always one structurally paired record."""
    records = {'document': dict.fromkeys(screen.RECORD_KEYS, 0) | {'gold_records': 1, 'pred_records': 1, 'matched_records': 1}}
    for name, (gold, matched, duplicated, spurious) in paths.items():
        records[f'document.{name}'] = dict.fromkeys(screen.RECORD_KEYS, 0) | {
            'gold_records': gold, 'matched_records': matched, 'missing_records': gold - matched, 'duplicated_records': duplicated,
            'hallucinated_records': spurious, 'pred_records': matched + duplicated + spurious}
    return {'values': {'raw': {'f1': f1}}, 'records_by_path': records}


def pair(group, a0, a3):
    return {'group': group, 'arms': {'base': a0, 'A3': a3}}


def test_f1_that_rises_because_correct_nested_records_were_withheld_is_a_loss():
    rows = [pair('mission', cell(.40, items=(8, 8, 0, 20)), cell(.60, items=(8, 0, 0, 0))), pair('grafton', cell(.8, items=(1, 1, 0, 0)), cell(.8, items=(1, 1, 0, 0)))]
    verdict = screen.gate(rows)
    assert verdict['raw_f1_delta_by_group']['mission'] > 0 and verdict['result'] == 'loss observed'
    assert verdict['losses'] == ['mission:document.items matched 8->0']


def test_a_gain_in_one_collection_cannot_offset_a_loss_in_another():
    a0, a3 = cell(.5, left=(4, 2, 0, 0), right=(4, 4, 0, 0)), cell(.5, left=(4, 4, 0, 0), right=(4, 2, 0, 0))
    verdict = screen.gate([pair('g', a0, a3), pair('h', a0, a0)])
    assert verdict['result'] == 'loss observed' and verdict['losses'] == ['g:document.right matched 4->2']


def test_untested_paths_never_pass_and_one_group_is_not_established():
    a0 = cell(.5, items=(3, 3, 0, 0), extras=(0, 0, 0, 2))
    verdict = screen.gate([pair('g', a0, a0), pair('h', a0, a0)])
    assert verdict['result'] == 'no material loss on tested paths' and verdict['untested_paths'] == ['g:document.extras', 'h:document.extras']
    assert screen.gate([pair('g', a0, a0)])['result'] == 'not established'


def test_a_fragmented_root_or_a_value_drop_beyond_tolerance_is_a_loss():
    a0 = cell(.5, items=(3, 3, 0, 0))
    split = cell(.5, items=(3, 3, 0, 0))
    split['records_by_path']['document']['pred_records'] = 2
    assert screen.gate([pair('g', a0, split), pair('h', a0, a0)])['losses'] == ['g: A3 has 2 root records']
    assert screen.gate([pair('g', a0, cell(.44, items=(3, 3, 0, 0))), pair('h', a0, a0)])['losses'] == ['g: raw F1 -0.060']


def test_auxiliary_requests_are_journalled_and_completions_are_not(tmp_path, monkeypatch):
    import requests
    spec = importlib.util.spec_from_file_location('run', Path(__file__).with_name('run.py'))
    run = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(run)
    reply = type('R', (), {'status_code': 200})()
    monkeypatch.setattr(requests, 'post', lambda url, *a, **k: reply)
    monkeypatch.setattr(requests, 'get', lambda url, *a, **k: reply)
    run.journal_auxiliary(tmp_path)
    requests.get('http://h/v1/models')
    requests.post('http://h/tokenize', json={})
    requests.post('http://h/v1/chat/completions', json={})
    entries = [json.loads(p.read_text()) for p in sorted(tmp_path.glob('aux-*.json'))]
    assert [(e['method'], e['endpoint'], e['status']) for e in entries] == [('GET', 'models', 200), ('POST', 'tokenize', 200)]
