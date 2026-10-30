"""Doubtful Catalog scalars stay reviewable without becoming verified Evidence."""
from copy import deepcopy

import pytest

from kei_exp.kie.extract.retained import publish_final
from tests.test_durable_extraction import MemoryLease
from tests.test_unified_catalog import Model, candidate, evidence, extract

SCHEMA = {"recordDescription": "A numbered entry", "schemaNodes": [
    {"id": "ref", "name": "reference", "type": "string"}]}


def retained(result, tree=SCHEMA):
    lease = MemoryLease(tree)
    lease.state["recordScopes"] = {str(i): [{"segment": "p1_s0", "start": i, "end": i + 1}]
                                   for i in range(len(result["records"]))}
    before = deepcopy(result)
    publish_final(lease, result)
    assert result == before
    return [value for publication in lease.publications.values() for value in publication["values"]]


@pytest.mark.parametrize('reply', [candidate(None, 'Reference: 42'), candidate('An invented value', 'Reference: 42')])
def test_an_answered_but_doubtful_scalar_remains_saved_for_review(reply):
    source = evidence('1. Reference: 42')
    model = Model(source, entry=lambda *_: {'reference': candidate('42', 'Reference: 42')}, verdict=lambda *_: reply)
    result, _ = extract(source, model, schema=SCHEMA, defaults=5)
    assert result['records'][0]['reference'] is None  # the accepted-only artifact keeps its meaning
    assert result['proposed'][0]['value'] == '42'
    value, = retained(result)
    assert (value['modelValue'], value['processing'], value['grounding'], value['evidence']) == ('42', 'saved', 'ungrounded', [])
    assert result['completeness']['processing']


def test_an_accepted_value_and_its_evidence_take_priority_over_proposals():
    source = evidence('1. Reference: 42')
    model = Model(source, entry=lambda *_: {'reference': candidate('42', 'Reference: 42')},
                  verdict=lambda *_: candidate('42', 'Reference: 42'))
    result, _ = extract(source, model, schema=SCHEMA, defaults=5)
    result['proposed'].append({'path': ['records', 0, 'reference'], 'value': 'wrong'})
    value, = retained(result)
    assert value['modelValue'] == '42' and value['grounding'] == 'grounded' and value['evidence']


@pytest.mark.parametrize(('proposals', 'expected'), [(['42', '42'], '42'), (['42', '43'], None), ([42], None)])
def test_only_one_distinct_typed_proposal_can_fill_an_absent_scalar(proposals, expected):
    result = {'strategy': 'catalog', 'options': {'unified': {'defaults': 5}}, 'records': [{'reference': None}],
              'proposed': [{'path': ['records', 0, 'reference'], 'value': value} for value in proposals]}
    value, = retained(result)
    assert value['modelValue'] == expected and value['grounding'] == 'ungrounded' and not value['evidence']


def test_proposals_follow_object_fields_without_inventing_list_identity():
    tree = {'recordDescription': 'An entry', 'schemaNodes': [
        {'id': 'group', 'name': 'details', 'type': 'object', 'children': SCHEMA['schemaNodes']},
        {'id': 'items', 'name': 'items', 'type': 'array', 'children': SCHEMA['schemaNodes']}]}
    result = {'strategy': 'catalog', 'options': {'unified': {'defaults': 5}},
              'records': [{'details': None, 'items': [{'reference': None}]}], 'proposed': [
                  {'path': ['records', 0, 'details', 'reference'], 'value': '42'},
                  {'path': ['records', 0, 'items', 0, 'reference'], 'value': '43'},
                  {'path': ['records', 0, 'items', None, 'reference'], 'value': '44'},
                  {'path': ['records', 1, 'details', 'reference'], 'value': 'another record'}]}
    values = {value['fieldId']: value for value in retained(result, tree)}
    assert values['group']['modelValue'] == {'reference': '42'}
    assert values['group']['grounding'] == 'ungrounded' and not values['group']['evidence']
    assert values['items']['modelValue'] == [{'reference': None}]


def test_recipe_proposals_keep_their_existing_contract():
    result = {'strategy': 'catalog', 'records': [{'reference': None}],
              'proposed': [{'path': ['records', 0, 'reference'], 'value': '42'}]}
    value, = retained(result)
    assert value['modelValue'] is None and value['processing'] == 'absent'


@pytest.mark.parametrize('reply', [{}, {'quote': 'Reference: 42'}])
def test_a_missing_verifier_value_is_not_an_explicit_null(reply):
    source = evidence('1. Reference: 42')
    model = Model(source, entry=lambda *_: {'reference': candidate('42', 'Reference: 42')}, verdict=lambda *_: reply)
    result, _ = extract(source, model, schema=SCHEMA, defaults=6)
    assert [(proposal['value'], proposal['reason']) for proposal in result['proposed']] == [('42', 'verification_unresolved')]
    value, = retained(result)
    assert value['modelValue'] == '42' and value['grounding'] == 'ungrounded' and not value['evidence']
