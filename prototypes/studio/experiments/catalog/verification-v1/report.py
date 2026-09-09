"""Score frozen runs and a declared post-hoc semantic-only policy; never feeds gold to models."""
import argparse
import copy
import html
import json
import sys
from pathlib import Path
from run import read, sha

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from evaluate import bind, score, normalize


def semantic_projection(baseline, decisions):
    run = copy.deepcopy(baseline)
    by_id = {d['catalog_number']: d for d in decisions}
    for row in run['rows']:
        d = by_id.get(row['values']['catalog_number'])
        if d:
            if d['modelVerdict'] != 'supported':
                row['values']['burial_axis'] = None
                row['evidence']['burial_axis'] = []
            row['verification'] = {'modelVerdict': d['modelVerdict'], 'originalValue': d['originalValue'],
                                   'reviewRequired': d['modelVerdict'] not in ('supported', 'unsupported')}
    elapsed = sum(d['durationMs'] for d in decisions)
    run['strategy'] = 'post-hoc-semantic-only-gate'
    run['verification'] = {'wallMs': elapsed, 'derivedPolicy': True}
    run['durationMs'] += elapsed
    run['calls'] += [{'model': 'nuextract', 'phase': 'reused-verification', 'durationMs': d['durationMs'],
                     'status': 'succeeded', 'providerInvocations': 1} for d in decisions]
    return run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--document', type=Path, required=True)
    args = parser.parse_args()
    root = args.input_dir
    baseline = read(root/'local-baseline.json')
    reference = bind(args.document)
    truth = {r['values']['catalog_number']: r['values']['burial_axis'] for r in reference['rows']}
    runs = [('Local baseline (derived)', root/'local-baseline.json', baseline)]
    for path in sorted(root.glob('*/result.json')):
        if not path.parent.name.startswith('semantic-derived'):
            runs.append((path.parent.name, path, read(path)))
    for n in (1, 2):
        source = root/f'nuextract-r{n}'/'decisions.json'
        run = semantic_projection(baseline, read(source)['decisions'])
        run['provenance']['verificationSource'] = str(source.resolve())
        run['provenance']['postHocPolicySha256'] = sha(__file__)
        out = root/f'semantic-derived-r{n}'
        out.mkdir(exist_ok=True)
        path = out/'result.json'
        path.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding='utf-8')
        runs.append((out.name, path, run))
    summary = []
    for name, path, run in runs:
        metrics = score(run, reference, 'all')
        output = root/'baseline-metrics.json' if path.name == 'local-baseline.json' else path.with_name('metrics-all.json')
        output.write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding='utf-8')
        axes = {r['values']['catalog_number']: r['values']['burial_axis'] for r in run['rows']}
        good = sum(normalize(axes.get(i), 'burial_axis') == normalize(v, 'burial_axis') for i, v in truth.items() if v is not None)
        review = sum(bool(r.get('verification', {}).get('reviewRequired')) for r in run['rows'])
        measurement = path.with_name('encoder-forwards.json')
        item = {'run': name, 'correctValues': metrics['correctFields'], 'supportedFields': metrics['supportedCorrectFields'],
                'correctAxesRetained': good, 'axis225': axes.get(225), 'reviewFields': review,
                'verificationMs': run.get('verification', {}).get('wallMs', 0),
                'pipelineLlmCalls': len(run['calls']),
                'encoderForwards': read(measurement)['count'] if measurement.exists() else None,
                'evidencePrecision': metrics['evidencePrecision']}
        summary.append(item)
    (root/'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    esc = lambda value: html.escape(str(value))
    table = ''.join('<tr>' + ''.join(f'<td>{esc(v)}</td>' for v in [s['run'], f"{s['correctValues']}/203",
        f"{s['supportedFields']}/164", f"{s['correctAxesRetained']}/6", s['axis225'] or 'null', s['reviewFields'],
        f"{s['verificationMs']/1000:.3f}", s['pipelineLlmCalls'], s['encoderForwards'] if s['encoderForwards'] is not None else '—']) + '</tr>' for s in summary)
    details = []
    for claim in read(root/'claims.json')['claims']:
        rows = []
        for name, path, run in runs:
            row = next(r for r in run['rows'] if r['values']['catalog_number'] == claim['catalog_number'])
            v = row.get('verification', {})
            rows.append(f"<tr><td>{esc(name)}</td><td>{esc(row['values']['burial_axis'])}</td><td>{esc(v.get('modelVerdict','—'))}</td><td>{esc(v.get('decision','—'))}</td><td>{esc(row['evidence']['burial_axis'])}</td></tr>")
        details.append(f"<details><summary>Voce {claim['catalog_number']} · proposto {esc(claim['value'])} · riferimento {esc(truth[claim['catalog_number']])}</summary><div class='scroll'><table><thead><tr><th>Variante</th><th>Valore</th><th>Giudizio modello</th><th>Esito controllo</th><th>Evidenza</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div><h3>Contesto comune inviato ai modelli</h3><pre>{esc(claim['text'])}</pre></details>")
    document = f'''<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Verifica locale degli orientamenti</title>
<style>body{{font:16px/1.55 system-ui,sans-serif;margin:0;background:#f5f6f7;color:#19262c}}main{{max-width:1400px;margin:auto;padding:32px}}h1{{line-height:1.2}}p{{max-width:100ch}}.scroll{{overflow:auto}}table{{border-collapse:collapse;background:white;width:100%;font-size:14px}}th,td{{text-align:left;padding:10px;border-bottom:1px solid #dce1e4}}th{{background:#e6edef}}td:first-child{{white-space:nowrap}}details{{background:white;margin:16px 0;padding:16px;border:1px solid #dce1e4;border-radius:8px}}summary{{cursor:pointer;font-weight:650}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.6 system-ui}}.note{{padding:16px;border-left:4px solid #805a00;background:#fff4d4}}a{{color:#075985}}</style>
<main><h1>Verifica degli orientamenti con modelli locali</h1><p>Esperimento del 8 settembre 2026 · RTX 4090 · sette orientamenti proposti da NuExtract · nessuna chiamata a Luna.</p>
<p class="note">La verifica NuExtract con oggetto e incertezza distingue i sei orientamenti corretti dal falso positivo 225. Il controllo delle citazioni genera tre ulteriori astensioni. GLiNER si astiene su tutti i casi. La variante semantic-derived conserva i sei valori corretti e rimuove la 225, mantenendo le evidenze locali esistenti: è una politica derivata dopo l’osservazione dei risultati, non una nuova esecuzione né una validazione indipendente.</p>
<div class="scroll"><table><thead><tr><th>Variante</th><th>Valori corretti</th><th>Campi supportati</th><th>Assi corretti conservati</th><th>Asse 225</th><th>Campi in revisione</th><th>Verifica (s)</th><th>LLM totali*</th><th>Encoder misurati</th></tr></thead><tbody>{table}</tbody></table></div>
<p>* Include dieci chiamate NuExtract di estrazione riutilizzate. Tempi: sola verifica, escluso caricamento modello e parsing. Le varianti derivate riutilizzano anche le sette chiamate di verifica: non sono chiamate aggiuntive. I campi in revisione contano le sole decisioni semantiche incerte; non includono le evidenze mancanti.</p>
<p>Il riferimento locale ha tre evidenze mancanti: località 225 e orientamenti 214 e 223. La variante semantic-derived le conserva visibilmente mancanti. Tutti i dati erano già noti: i risultati sono diagnostici, non una stima di generalizzazione. Non si verificano valori originariamente nulli.</p>
<p>GLiNER: checkpoint fissato, FP32, inferenza offline; fallback automatico da SDPA a eager. Il contatore top-level dei primi tentativi non intercettava l’encoder: gliner-r4 riporta sette forward realmente misurati. I tentativi falliti e tutti gli output grezzi restano negli artefatti.</p>
<h2>Ispezione dei sette casi</h2>{''.join(details)}</main></html>'''
    (root/'report.html').write_text(document, encoding='utf-8')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
