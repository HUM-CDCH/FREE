"""Regressions from real quoted replies and source structure lost at unit boundaries."""
import json
import re
from dataclasses import replace

import pytest

from kei_exp.kie.extract import assembly, run
from kei_exp.kie.extract.article import RootUnanswered
from kei_exp.kie.extract.contexts import partition
from kei_exp.kie.extract.llm import ModelOutputError, parse_json
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.grounding import verify
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages


@pytest.mark.parametrize('control', ['\t', '\n', '\r', '\x00', '\x06', '\x0e'])
def test_source_controls_decode_losslessly_in_literal_and_escaped_forms(control):
    value = {'quote': '6.4' + control + '0.13%', 'path': r'C:\notes'}
    escaped = json.dumps(value)
    literal = escaped.replace(json.dumps(control)[1:-1], control, 1)
    assert parse_json(literal) == parse_json(escaped) == value


@pytest.mark.parametrize('reply', ['{"a": "tab\there"', '{"a": "ok",}',
                                   '{"a": 1}\x00', '{"a": "bad\\q"}', '{"a": 1} {"b": 2}'])
def test_control_decoding_does_not_repair_other_malformed_json(reply):
    with pytest.raises(ModelOutputError):
        parse_json(reply)


@pytest.mark.parametrize('quote,accepted', [('Hill\t1827', True), ('hill\t1827', False),
                                           ('Hill 1827', False), ('Hill\t1828', False)])
def test_quoted_grounding_uses_literal_candidate_text(quote, accepted):
    class LiteralReply(CountingChat):
        def complete(self, **kwargs):
            reply = super().complete(**kwargs)
            return replace(reply, text=reply.text.replace('\\t', '\t'))

    chat = LiteralReply(lambda s, u, schema: {
        claim: {'label': 'E1', 'quote': quote, 'attribution': True} for claim in schema['properties']})
    links, calls, issues = verify(passages(['Hill\t1827']), {'year': 1827}, SCHEMA, chat,
                                  record=0, counter=WordCounter(), record_context='Hill', quoted=True)
    assert all(call.ok for call in calls)
    assert bool(links) == accepted
    assert bool(issues) != accepted
    assert 'whose value is exactly one evidence label' not in chat.calls[0]['system']
    assert 'Escape control characters' in chat.calls[0]['system']


def test_literal_controls_do_not_make_a_length_cut_reply_successful():
    class CutReply(CountingChat):
        def complete(self, **kwargs):
            return replace(super().complete(**kwargs), text='{"C1":"Hill\t1827"}', finish='length')

    links, calls, issues = verify(passages(['Hill\t1827']), {'year': 1827}, SCHEMA,
                                  CutReply(lambda *_: {}), record=0, counter=WordCounter(),
                                  record_context='Hill', quoted=True)
    assert not links and not calls[-1].ok and issues[0].code == 'call_failed'


def structured_passages():
    labels = ['SectionHeader', 'Text', 'Text', 'Caption', 'Table', 'Footnote', 'Text', 'SectionHeader', 'Text']
    return [replace(p, label=label) for p, label in zip(passages([
        'Methods', 'First paragraph', 'More methods', 'Table 1', 'A 37 B 42', '* in water',
        'Concluding paragraph', 'Results', 'Final result']), labels, strict=True)]


@pytest.mark.parametrize('budget', [3, 4, 5])
def test_table_qualifiers_and_required_heading_remain_together_even_when_oversized(budget):
    source = structured_passages()
    groups = partition(source, lambda p: len(p) <= budget, structural=True, overlap=2)
    assert [p for group in groups for p in group.primary] == source
    table_group = next(g for g in groups if source[4] in g.primary)
    assert all(p in table_group.primary for p in source[3:6])
    assert source[0] in table_group.passages
    assert table_group.dumped()['heading'] == source[0].id
    assert all(len({p.id for p in g.passages}) == len(g.passages) for g in groups)
    assert all(list(g.passages) == sorted(g.passages, key=lambda p: (p.page, p.index)) for g in groups)
    if budget == 3:
        assert len(table_group.passages) > budget  # mandatory qualifier/heading cannot be dropped to fit


def test_structure_never_leaves_a_heading_without_its_first_body_block():
    source = structured_passages()
    groups = partition(source, lambda p: len(p) <= 1, structural=True)
    for heading, body in [(source[0], source[1]), (source[7], source[8])]:
        assert any(heading in group.primary and body in group.primary for group in groups)
    assert partition([], lambda p: True, structural=True) == []


def test_structural_grouping_is_explicit_validated_and_fingerprinted():
    with pytest.raises(ValueError, match='bounded'):
        ArticleOptions(grouping='structural')
    base = run.ExtractRequest(schema=SCHEMA, options={'strategy': 'article', 'article': {'context': 'bounded'}})
    grouped = base.model_copy(update={'options': base.options.model_copy(update={
        'article': ArticleOptions(context='bounded', grouping='structural')})})
    assert 'grouping' not in base.options.dumped()['article']
    assert assembly.fingerprint({'generation': 'g', 'digest': 'd'}, base, {}) != assembly.fingerprint(
        {'generation': 'g', 'digest': 'd'}, grouped, {})


def test_assembled_structural_calls_retain_labels_heading_and_table_qualifiers(monkeypatch):
    source = structured_passages()
    source[1] = replace(source[1], text='first ' * 3000)
    source[2] = replace(source[2], text='second ' * 3000)
    monkeypatch.setattr(run, 'load', lambda _: evidence(source))
    reason = CountingChat(lambda *_: {'records': [
        {'label': 'Hill', 'identity': {'site': 'Hill'}, 'passages': [source[0].id]}]})
    fields = CountingChat(lambda *_: {'year': 1827})
    method = {'context': 'bounded', 'context_tokens': 8192, 'grouping': 'structural',
              'rendering': 'structured', 'identity': 'conservative', 'identity_fields': ['site'],
              'prompt': 'schema', 'grounding': 'off'}
    result = run.extract(None, run.ExtractRequest(schema=SCHEMA, options={'strategy': 'article', 'article': method}),
                         Router(fields, reason), counter={r: WordCounter() for r in ['fields', 'reasoning']})
    assert result['grouping_version'] == 1
    assert any('heading' in context for context in result['contexts'])
    assert [p for c in result['contexts'] for p in c['primary']] == [p.id for p in source]
    assert all(c['counted_input_tokens'] + c['max_output_tokens'] <= 8192 for c in result['calls'])
    for call in fields.calls + reason.calls:
        if f'id="{source[4].id}"' in call['user']:
            assert 'Table 1' in call['user'] and '* in water' in call['user']
            assert 'label="Table"' in call['user'] and 'Methods' in call['user']


def test_reply_envelope_removal_preserves_thinking_tags_inside_source_strings():
    value = {'quote': 'Literal <think>source</think> and ```json markup'}
    assert parse_json('<think>model reasoning</think>\n```json\n' + json.dumps(value) + '\n```') == value


def test_oversized_table_with_qualifier_is_refused_before_any_model_call(monkeypatch):
    source = [replace(p, label=label) for p, label in zip(
        passages(['Methods', 'table ' * 5000, 'qualifier ' * 2000]),
        ['SectionHeader', 'Table', 'Footnote'], strict=True)]
    monkeypatch.setattr(run, 'load', lambda _: evidence(source))
    chat = CountingChat(lambda *_: pytest.fail('oversized structural unit reached the model'))
    method = {'context': 'bounded', 'context_tokens': 8192, 'grouping': 'structural',
              'rendering': 'structured', 'grounding': 'off'}
    # The one context it is kept in cannot be read, so the Article has no root and fails rather than publish one.
    with pytest.raises(RootUnanswered, match='none of the 1 value context') as refused:
        run.extract(None, run.ExtractRequest(schema=SCHEMA, options={'strategy': 'article', 'article': method}),
                    chat, counter={r: WordCounter() for r in ['fields', 'reasoning']})
    counted = int(re.search(r'(\d+) input \+ 4096 output tokens exceed the served context 8192', str(refused.value))[1])
    assert counted > 7000  # the table kept its qualifier: the unit was refused intact
    assert not chat.calls


def test_page_furniture_does_not_separate_a_table_from_adjacent_footnote():
    source = [replace(p, label=label) for p, label in zip(
        passages(['Methods', 'body', 'Table 1', 'data', 'footer', 'header', '* note', 'tail']),
        ['SectionHeader', 'Text', 'Caption', 'Table', 'PageFooter', 'PageHeader', 'Footnote', 'Text'], strict=True)]
    source[5:] = [replace(p, page=2, id=f'p2_s{i}', index=i) for i, p in enumerate(source[5:])]
    groups = partition(source, lambda p: len(p) <= 3, structural=True)
    group = next(g for g in groups if source[3] in g.primary)
    assert group.primary == tuple(source[2:7])
    assert group.heading == source[0]
    assert [p for g in groups for p in g.primary] == source
