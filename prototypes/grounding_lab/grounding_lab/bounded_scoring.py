"""Frozen E replay and quote/E candidate fallback. Reads no evaluation labels."""
import json
import shutil
import sys
import time
from pathlib import Path
from .holdout_evaluation import LAB, read, write, verify_freeze
from .raw_claims import labeling_sheet


def hybrid_proposals(rows, quotes):
    by_path = {tuple(q['resultPath']): q for q in quotes}
    result = []
    for row in rows:
        quote = by_path[tuple(row['path'])]
        mapped = quote['status'] == 'mapped'
        result.append({'path': row['path'], 'value': row['value'],
                       'route': 'quote' if mapped else 'E-fallback',
                       'quoteStatus': quote['status'],
                       'proposedAnchorSets': quote['proposedAnchorSets'] if mapped else
                       ([[row['bestCandidateAnchorId']]] if row['bestCandidateAnchorId'] else []),
                       'reviewRequired': True, 'autoAccept': False})
    return result


def main(source, run):
    started = time.perf_counter()
    from .harness import load_dataset
    from .model_benchmark import RETRIEVERS, RERANKERS, _load_reranker, _warm_reranker, _score_entries, dump_outcomes
    from .review_risk import score_frozen
    frozen = verify_freeze(LAB / 'experiments/2026-09-05')
    shutil.copyfile(source / 'anchors.json', run / 'anchors.json')
    write(run / 'claims_unlabelled.json', labeling_sheet(read(run / 'raw_extracted.json')))
    documents = [doc for doc in load_dataset(run.parent, ('claims_unlabelled.json',)) if doc[0] == run.name]
    if len(documents) != 1:
        raise ValueError('Expected exactly one label-free extraction')
    spec = RERANKERS['nemotron-1b']
    model = _load_reranker(spec)
    _warm_reranker(model, spec)
    entries, latencies = _score_entries(documents, None, RETRIEVERS['mini'], model, spec, 'rich-hitset')
    output = run / 'e-proposals.jsonl'
    dump_outcomes(output, entries, {run.name: (frozen['thresholds']['abstain'], frozen['thresholds']['legacyAccept'])}, documents, latencies)
    rows = [json.loads(line) for line in output.read_text(encoding='utf8').splitlines()]
    for row in rows:
        row['routingDecision'] = 'linked' if row['outcome'].startswith('link-') else row['outcome']
        for key in ('supported', 'goldAnchorIds', 'outcome'):
            row.pop(key)
    rows = score_frozen(rows, frozen['riskModel'])
    output.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows), encoding='utf8')
    if (run / 'quote_mappings.json').exists():
        write(run / 'hybrid-proposals.json', hybrid_proposals(rows, read(run / 'quote_mappings.json')))
    write(run / 'grounding_meta.json', {'durationThroughOutputWriteSeconds': time.perf_counter() - started,
          'reranker': frozen['reranker'], 'neuralClaimCalls': sum(tier == 'neural' for _, tier, _ in latencies),
          'timingScope': 'imports, freeze verification, load/warm model, full E replay, frozen risk and output writes; hybrid reuses replay, no standalone hybrid latency claim', 'autoAccept': False})


if __name__ == '__main__':
    main(Path(sys.argv[1]), Path(sys.argv[2]))
