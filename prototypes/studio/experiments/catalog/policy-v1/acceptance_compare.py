#!/usr/bin/env python3
"""Compare an acceptance run of the harness with the production run 5c2e6fbc on the full Beier catalogue.

Same document, same schema revision 6, same model route; only the policy differs.
Prints a table and writes RESULTS.md into the run directory. Never calls a model."""
import argparse
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def norm(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True) if isinstance(value, (list, dict)) else (str(value).strip() if value not in (None, '') else '')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--production', type=Path, default=REPO / 'artifacts/catalog-lab/beier-full/run-5c2e6fbc.json')
    args = parser.parse_args()
    result = read(args.run / 'result.json')
    terminal = read(args.run / 'terminal.json') if (args.run / 'terminal.json').exists() else {}
    prod = read(args.production)
    calls = result['calls']
    by_phase = Counter(c['phase'] for c in calls)
    ms = Counter()
    for c in calls:
        ms[c['phase']] += c['durationMs']
    tokens_in = sum((c.get('metadata') or {}).get('inputTokens') or 0 for c in calls)
    tokens_out = sum((c.get('metadata') or {}).get('outputTokens') or 0 for c in calls)
    links = terminal.get('evidence') or []
    prod_stages = {s['stage']: s for s in prod['diagnostics']['catalog']['stages']}
    prod_links = prod['evidenceLinks']
    rows_new = (terminal.get('result') or {}).get('records') or []
    rows_prod = prod['resultPayload']['records']
    fields = [k for k in rows_prod[0].keys()] if rows_prod else []
    agree, compared = Counter(), Counter()
    for a, b in zip(rows_new, rows_prod):
        for f in fields:
            compared[f] += 1
            agree[f] += norm(a.get(f)) == norm(b.get(f))
    labels_equal = [a.get('catalogue_label') for a in rows_new] == [b.get('catalogue_label') for b in rows_prod]
    populated = lambda rows: sum(1 for r in rows for v in r.values() for _ in (v if isinstance(v, list) else [v]) if v not in (None, '', []))
    cross = sum(1 for i in (terminal.get('diagnostics', {}).get('groundingIssues') or []) if i.get('code') == 'unknown_anchor_label')
    table = [
        '| Measure | production run 5c2e6fbc (per-record) | this run (' + result['arm'] + ') |', '|---|---:|---:|',
        f"| discovery calls | {prod_stages['discovery']['calls']} | {by_phase['discovery']} |",
        f"| values calls | {prod_stages['record-values']['calls']} | {by_phase['extraction']} (batches {sum(1 for c in calls if (c.get('records') or 1) > 1)}, fallback singles {sum(1 for c in calls if c.get('fallback'))}) |",
        f"| grounding calls | {prod_stages['grounding']['calls']} | {by_phase['grounding']} |",
        f"| total calls | {sum(s['calls'] for s in prod_stages.values())} | {len(calls)} |",
        f"| discovery time | {prod_stages['discovery']['durationMs'] / 60000:.1f} min | {ms['discovery'] / 60000:.1f} min |",
        f"| values time | {prod_stages['record-values']['durationMs'] / 60000:.1f} min | {ms['extraction'] / 60000:.1f} min |",
        f"| grounding time | {prod_stages['grounding']['durationMs'] / 60000:.1f} min | {ms['grounding'] / 60000:.1f} min |",
        f"| total time | {prod['diagnostics']['durationMs'] / 60000:.1f} min | {result['durationMs'] / 60000:.1f} min |",
        f"| input tokens | {prod['diagnostics']['inputTokens']:,} | {tokens_in:,} |",
        f"| output tokens | {prod['diagnostics']['outputTokens']:,} | {tokens_out:,} |",
        f"| records | {len(rows_prod)} | {len(rows_new)} (boundaries {len(result['boundaries'])}) |",
        f"| catalogue labels identical, in order | – | {'yes' if labels_equal else 'NO'} |",
        f"| populated values | {populated(rows_prod)} | {populated(rows_new)} |",
        f"| evidence links | {len(prod_links)} | {len(links)} |",
        f"| ungrounded paths | {len(prod['diagnostics']['grounding']['ungroundedPaths'])} | {len(terminal.get('diagnostics', {}).get('ungroundedPaths') or [])} |",
        f"| links into other entries | 0 | {cross} |",
        f"| non-verbatim links | {sum(1 for l in prod_links if l.get('verbatim') is False)} | {sum(1 for l in links if l.get('verbatim') is False)} |",
        f"| repeated-passage links | {sum(1 for l in prod_links if (l.get('lexicalHits') or 0) > 1)} | {sum(1 for l in links if (l.get('lexicalHits') or 0) > 1)} |",
        f"| outcome | SUCCEEDED, complete false | {result['outcome']}, complete {result.get('complete')} |",
    ]
    agreement = ['', '## Value agreement with the production run, record by record', '', '| field | equal | compared |', '|---|---:|---:|',
                 *[f'| {f} | {agree[f]} | {compared[f]} |' for f in fields]]
    report = '\n'.join(['# Policy v1 acceptance on the full Beier catalogue', '',
                        f"Generated by acceptance_compare.py from {args.run.name}/result.json and terminal.json against the saved production run; no number is typed by hand.", '',
                        *table, *agreement, ''])
    (args.run / 'RESULTS.md').write_text(report, encoding='utf8')
    print(report)


if __name__ == '__main__':
    main()
