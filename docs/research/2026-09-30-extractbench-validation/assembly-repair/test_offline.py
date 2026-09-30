import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location('offline', Path(__file__).with_name('offline.py'))
offline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(offline)


def row(f1, gold=8, matched=8, duplicated=0, spurious=0, root=(1, 1, 0, 0)):
    scope = lambda g, m, d, s: {'gold_records': g, 'pred_records': m + d + s, 'matched_records': m, 'missing_records': g - m,
                                'duplicated_records': d, 'hallucinated_records': s, 'unadjudicated_records': 0, 'strict_records': 0}
    return {'raw_f1': f1, 'records': {'document_root': scope(*root), 'nested': scope(gold, matched, duplicated, spurious)}}


def test_f1_that_rises_because_nested_records_were_dropped_is_rejected_where_the_old_rule_only_needed_more_wins():
    reference = {'a': row(.30, matched=5, spurious=23), 'b': row(.40), 'c': row(.50)}
    dropped = {'a': row(.46, matched=0), 'b': row(.45), 'c': row(.55)}       # mission A1's shape, plus two favourable groups
    verdict = offline.gate_v2(reference, dropped)
    assert verdict['f1']['wins'] == 3 and verdict['f1']['mean_raw_f1_delta'] > 0      # F1 alone would call this a success
    assert verdict['result'] == 'rejected' and 'nested.no_loss' in verdict['reason']


def test_an_uninformative_guard_is_not_established_and_never_passes():
    empty = {g: row(f, gold=0, matched=0) for g, f in zip('abc', (.3, .4, .5))}
    better = {g: row(f + .1, gold=0, matched=0) for g, f in zip('abc', (.3, .4, .5))}
    assert offline.gate_v2(empty, better)['result'] == 'not established'
    assert offline.gate_v2({'a': row(.3)}, {'a': row(.9)})['result'] == 'not established'          # fewer than 3 groups


def test_a_real_gain_without_record_loss_or_excess_is_supported_and_overproduction_is_rejected():
    reference = {g: row(.4, matched=6, spurious=4) for g in 'abc'}
    assert offline.gate_v2(reference, {g: row(.5, matched=7, spurious=3) for g in 'abc'})['result'] == 'development-supported challenger'
    noisy = offline.gate_v2(reference, {g: row(.5, matched=7, spurious=9) for g in 'abc'})
    assert noisy['result'] == 'rejected' and 'nested.no_excess' in noisy['reason']
