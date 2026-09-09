"""User-requested scope amendment: preserve the original freeze and skip NaviDC.

Run: python .../without_navidc.py run
Rescore: python .../without_navidc.py report --out <new-directory> --adjudications <file>
The original extraction, reference and scoring rules remain unchanged.
"""
import argparse
import json
from pathlib import Path

import score
import suite
from common import ARMS, DEFAULT_ROOT, DOCS, HERE, OCR, check_freeze, combinations, read, sha, verify
from prepare import convert


def amendment(root):
    change=read(root/'execution-amendment-01.json')
    assert change['excludedArms']==['navidc']
    assert change['originalFreezeSha256']==sha(root/'freeze.json')
    verify({Path(__file__).resolve():change['scriptSha256']})
    check_freeze(root)
    assert len(combinations())*2*len([a for a in ARMS if a!='navidc'])==154
    return change


def report(root, out, adjudications=None):
    change=amendment(root)
    score.ARMS=[a for a in ARMS if a!='navidc']
    score.report(root,out,adjudications)
    # Scope metadata only; all per-run scoring is the unchanged frozen scorer.
    result=read(out/'results.json')
    result.update(executionAmendment=change,amendmentSha256=sha(root/'execution-amendment-01.json'),
        originalPlannedExecutorRuns=176,plannedExecutorRuns=154,
        excludedRuns=[{'doc':d,'schema':s,'arm':'navidc','repetition':r,'outcome':'SKIPPED_USER'}
                      for d,s in combinations() for r in [1,2]])
    assert len(result['runs'])==154 and len(result['excludedRuns'])==22
    for item in result['ocr']:
        if item['arm']=='navidc': item['excludedByUser']=True
    (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    path=out/'RESULTS.md'
    text=path.read_text(encoding='utf8').replace('Planned: 176.','Planned after amendment: 154 (originally 176).')
    path.write_text(text+'\nNaviDC was stopped and excluded at the user’s request. Its 22 executor runs are listed as SKIPPED_USER in excludedRuns; partial native OCR, including truncation flags, remains preserved. All other frozen scoring rules and references are unchanged.\n',encoding='utf8')


def run(root):
    amendment(root)
    frozen=check_freeze(root)
    for name in [m for m in OCR if m!='navidc']:
        if not all((root/'ocr'/name/d/'manifest.json').exists() for d in DOCS):
            suite.unload_qwen(frozen)
            if suite.command(root,f'native-{name}',[suite.PYTHONS[name],'-X','utf8',HERE/'native.py','--root',root,'--model',name]):
                raise RuntimeError(f'Native {name} failed; preserved logs require inspection')
        for doc in DOCS:
            if not (root/'inputs'/doc/name/'manifest.json').exists(): convert(root,name,doc)
    for rep in [1,2]:
        for doc,schema in combinations()[::1 if rep==1 else -1]:
            for name in [m for m in OCR if m!='navidc'][::1 if rep==1 else -1]:
                suite.execute(root,doc,schema,name,rep)
    suite.run(root,'native')
    report(root,root/'report-initial')


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('command',choices=['run','report'])
    parser.add_argument('--root',type=Path,default=DEFAULT_ROOT)
    parser.add_argument('--out',type=Path)
    parser.add_argument('--adjudications',type=Path)
    args=parser.parse_args()
    if args.command=='run': run(args.root.resolve())
    else:
        if args.out is None: parser.error('--out is required for report')
        report(args.root.resolve(),args.out.resolve(),args.adjudications)
