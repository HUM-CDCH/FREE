"""Catalog completeness: page cuts do not hide starts, and verification can repair a scalar."""
import pytest

from tests.test_unified_catalog import Model, candidate, evidence, extract


SCHEMA = {"recordDescription": "One numbered catalogue entry.", "schemaNodes": [
    {"id": "body", "name": "description", "type": "string", "description": "Complete description."},
]}


def test_budget_discovery_sees_entries_across_physical_pages():
    source = evidence("1. Alpha.\nThe description continues", "on this page.\n2. Beta.")
    new, _ = extract(source, defaults=5)
    old, _ = extract(source, defaults=4)
    assert [r['label'] for r in new['records']] == ['1', '2']
    assert len([c for c in new['calls'] if c['stage'] == 'discovery']) == 1
    assert len([c for c in old['calls'] if c['stage'] == 'discovery']) == 2
    assert new['prompt_version'] == 6 and old['prompt_version'] == 5


def test_budget_discovery_still_splits_a_long_source_without_losing_entries():
    source = evidence(*[f'{n}. Site{n}. ' + 'Description ' * 100 + f' Material: M{n}.' for n in range(1, 11)])
    result, _ = extract(source, defaults=5, input_tokens=1000, output_tokens=256)
    assert result['processing']['discovery']['windows'] > 1
    assert [r['label'] for r in result['records']] == [str(n) for n in range(1, 11)]
    assert [r['material'] for r in result['records']] == [f'M{n}' for n in range(1, 11)]


def test_verification_completes_the_description_with_source_evidence():
    complete = 'The first sentence. The continuation is also part of the description.'
    source = evidence('1. ' + complete)
    model = Model(source, entry=lambda *_: {'description': candidate('The first sentence.', 'The first sentence.')},
                  verdict=lambda *_: candidate(complete, complete))
    result, _ = extract(source, model, schema=SCHEMA, defaults=5)
    assert result['records'][0]['description'] == complete
    assert any(p['reason'] == 'verification_corrected' for p in result['rejected'])
    assert len([c for c in result['calls'] if c['stage'] == 'verification']) == 1


@pytest.mark.parametrize('correction', [
    candidate('Invented text.', 'Invented text.'),
    candidate(123, 'The first sentence.'),
    candidate('Text from another record.', 'Text from another record.'),
    candidate('Invented text.', 'The first sentence.'),
])
def test_invalid_correction_never_becomes_an_accepted_value(correction):
    source = evidence('1. The first sentence.\n2. Text from another record.')
    model = Model(source, entry=lambda *_: {'description': candidate('The first sentence.', 'The first sentence.')},
                  verdict=lambda *_: correction)
    result, _ = extract(source, model, schema=SCHEMA, defaults=5)
    assert result['records'][0]['description'] is None
    assert any(p['reason'] == 'verification_unresolved' for p in result['proposed'])


def test_old_admissions_keep_verdict_only_verification():
    source = evidence('1. The first sentence.')
    model = Model(source, entry=lambda *_: {'description': candidate('The first sentence.', 'The first sentence.')})
    result, _ = extract(source, model, schema=SCHEMA, defaults=4)
    assert result['records'][0]['description'] == 'The first sentence.'


def test_disabled_verification_keeps_the_original_proposal():
    source = evidence('1. The first sentence.')
    model = Model(source, entry=lambda *_: {'description': candidate('The first sentence.', 'The first sentence.')},
                  verdict=lambda *_: pytest.fail('verification is disabled'))
    result, _ = extract(source, model, schema=SCHEMA, defaults=5, verification=False)
    assert result['records'][0]['description'] is None
    assert result['proposed'][0]['value'] == 'The first sentence.'


def test_nested_scalar_corrections_preserve_the_field_path():
    schema = {'recordDescription': SCHEMA['recordDescription'], 'schemaNodes': [
        {'id': 'details', 'name': 'details', 'type': 'object', 'children': SCHEMA['schemaNodes']}]}
    source = evidence('1. First sentence. Second sentence.')
    full = 'First sentence. Second sentence.'
    model = Model(source, entry=lambda *_: {'details': {'description': candidate('First sentence.', 'First sentence.')}},
                  verdict=lambda *_: candidate(full, full))
    result, _ = extract(source, model, schema=schema, defaults=5)
    assert result['records'][0]['details']['description'] == full
    assert result['evidence'][0]['path'] == ['records', 0, 'details', 'description']


def test_a_verifier_cannot_change_a_list_items_identity():
    source = evidence('1. Site. Find: Bowl (1) Find: Cup (2)')
    model = Model(source, verdict=lambda path, *_: candidate('Cup', 'Cup') if path == 'finds.name' else 'supported')
    result, _ = extract(source, model, defaults=5)
    assert all(row['name'] is None for row in result['records'][0]['finds'])
    assert [row['count'] for row in result['records'][0]['finds']] == [1, 2]
