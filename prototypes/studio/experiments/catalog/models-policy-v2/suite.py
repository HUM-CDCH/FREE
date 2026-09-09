"""Freeze and run the approved matrix serially on the existing desktop runtimes."""
import argparse
import importlib.metadata
import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from common import ARMS, DEFAULT_ROOT, DOCS, HERE, OCR, OLD, REPO, REVISIONS, check_freeze, checkpoint_path, combinations, read, run_path, save, sha, verify

PYTHONS = {name: OLD / ('.venv-nanonets' if name in ['nanonets','navidc','nemotron'] else '.venv-modern') / 'Scripts/python.exe' for name in REVISIONS}
PYTHONS['gliner'] = REPO/'artifacts/catalog-lab/beier/verification-v1/.venv/Scripts/python.exe'
TSX = REPO/'packages/extraction/node_modules/tsx/dist/cli.mjs'


def runtime(python):
    code = f"import json,sys; sys.path.insert(0,{str(HERE)!r}); from common import current_runtime; print(json.dumps(current_runtime()))"
    return json.loads(subprocess.check_output([str(python), '-X', 'utf8', '-c', code], text=True, encoding='utf8'))


def freeze(root):
    if (root/'freeze.json').exists():
        raise ValueError('Already frozen: changed code/inputs need a new experiment root')
    for doc in DOCS:
        verify(read(root/'inputs'/doc/'manifest.json')['hashes'])
    for name in OCR:
        reused = read(root/'ocr'/name/'beier/manifest.json')
        if reused['revision'] != REVISIONS[name]:
            raise ValueError('Saved OCR checkpoint revision mismatch')
        verify(reused['reusedHashes'])
        verify(read(root/'inputs/beier'/name/'manifest.json')['rawHashes'])
    refs = read(root/'references-v1.json')
    if [len(refs['documents'][d]['records']) for d in DOCS] != [29,3,9,6,0,13]:
        raise ValueError('Source-reviewed inventory changed unexpectedly')
    code_files = [p for p in HERE.iterdir() if p.is_file()]
    code_files += list((REPO/'packages/extraction/src').rglob('*.ts'))
    code_files += list((REPO/'prototypes/studio/api').glob('_*.ts'))
    code_files += [HERE.parent/'schema.ts', HERE.parent/'beier.reference.json']
    code_files += [HERE.parent/'models-v1'/p for p in ['ocr.py','gliner.py','normalize_ocr.py','normalize_ocr_v2.py']]
    code_files += [REPO/'prototypes/parsing_service/app/docling_parser.py', REPO/'pnpm-lock.yaml']
    code_files += [REPO/'prototypes/studio/node_modules'/p/'package.json' for p in ['ai','zod','ai-sdk-ollama','typescript']]
    native_hashes, runtimes = {}, {}
    for name, revision in REVISIONS.items():
        checkpoint = checkpoint_path(name)
        metadata_path = (checkpoint/'verified-metadata.json' if name != 'gliner' else checkpoint.parent/'gliner-model-metadata.json')
        metadata = read(metadata_path)
        if metadata['sha'] != revision:
            raise ValueError(f'Checkpoint revision mismatch: {name}')
        hashes = {str(p):sha(p) for p in checkpoint.rglob('*') if p.is_file() and '.git' not in p.parts and '__pycache__' not in p.parts and p.suffix != '.pyc'}
        for item in metadata['siblings']:
            path = checkpoint/item['rfilename']
            if path.is_file() and item.get('lfs') and hashes[str(path)] != item['lfs']['sha256']:
                raise ValueError(f'Checkpoint does not match pinned upstream digest: {path}')
        hashes[str(metadata_path)] = sha(metadata_path)
        hashes[str(PYTHONS[name])] = sha(PYTHONS[name])
        if name == 'nemotron':
            radio = OLD/'hf-cache/hub/models--nvidia--C-RADIOv2-H'
            if (radio/'refs/main').read_text().strip() != '0d8f4c18c877166eda07ddae1386bcad256b7a6a':
                raise ValueError('Offline C-RADIO revision changed')
            hashes.update({str(p):sha(p) for p in radio.rglob('*') if p.is_file()})
        native_hashes[name] = hashes
        runtimes[name] = runtime(PYTHONS[name])
        expected_transformers = '4.57.6' if name in ['nanonets','navidc','nemotron','gliner'] else '5.17.0.dev0'
        if runtimes[name]['packages']['transformers'] != expected_transformers or runtimes[name]['packages']['torch'] != '2.8.0+cu128':
            raise ValueError(f'Runtime differs from the handoff: {name}')
        if expected_transformers == '5.17.0.dev0' and 'bd05a4b2baf8b37b8f64c0c2c70d2628583f7c2a' not in (runtimes[name]['transformersSource'] or ''):
            raise ValueError('Modern Transformers source revision differs from the handoff')
        print('VERIFIED', name, revision, len(hashes), 'files', flush=True)
    base_url = 'http://127.0.0.1:11434'
    with urllib.request.urlopen(base_url+'/api/tags', timeout=10) as response:
        tags = json.load(response)['models']
    qwen = next(m for m in tags if m['name'] == 'qwen3.8:latest')
    input_files = [p for p in (root/'inputs').rglob('*') if p.is_file()]
    input_files += [root/'schemas.json', root/'references-v1.json']
    # Beier source images live in the previous immutable experiment.
    input_files += [Path(i['path']) for doc in DOCS for i in read(root/'inputs'/doc/'images.json')]
    input_files += [Path(p) for doc in DOCS for p in read(root/'inputs'/doc/'manifest.json')['hashes']]
    save(root/'freeze.json', {'createdAt':datetime.now(timezone.utc).isoformat(), 'revision':'models-policy-v2',
        'head':subprocess.check_output(['git','rev-parse','HEAD'], cwd=REPO, text=True).strip(),
        'codeHashes':{p.relative_to(REPO).as_posix():sha(p) for p in code_files},
        'inputHashes':{p.resolve().as_posix():sha(p) for p in input_files},
        'nativeHashes':native_hashes, 'runtimes':runtimes,
        'qwen':{'name':qwen['name'],'digest':qwen['digest'],'baseUrl':base_url},
        'node':subprocess.check_output(['node','--version'],text=True).strip(),
        'arms':ARMS,'combinations':combinations(),'repetitions':[1,2],'plannedExecutorRuns':176})


def command(root, label, args):
    log = root/'logs'/f'{label}.log'
    log.parent.mkdir(exist_ok=True)
    if log.exists():
        if not label.startswith('native-'):
            raise ValueError(f'Job log already exists without a completed result: {label}')
        attempt=2
        while log.exists():
            log=root/'logs'/f'{label}-attempt{attempt}.log'
            attempt+=1
    started = time.perf_counter()
    print('JOB START', label, flush=True)
    with log.open('x',encoding='utf8') as output:
        result = subprocess.run([str(a) for a in args],cwd=REPO,stdout=output,stderr=subprocess.STDOUT)
    save(log.with_suffix('.json'), {'command':[str(a) for a in args],'cwd':str(REPO),'exitCode':result.returncode,
                                  'seconds':time.perf_counter()-started,'finishedAt':datetime.now(timezone.utc).isoformat()})
    print('JOB END', label, result.returncode, round(time.perf_counter()-started,1), flush=True)
    return result.returncode


def ts_args(root, doc, schema, arm, rep):
    return ['node', TSX, HERE/'run.ts','--root',root,'--document',doc,'--schema',schema,'--arm',arm,'--repetition',str(rep)]


def execute(root, doc, schema, arm, rep):
    out = run_path(root,doc,schema,arm,rep)
    if (out/'result.json').exists():
        print('EXISTS', doc,schema,arm,rep,flush=True)
        return
    if out.exists():
        raise ValueError(f'Interrupted executor run: preserve it and use a new revision: {out}')
    code = command(root,f'{doc}-{schema}-{arm}-r{rep}',ts_args(root,doc,schema,arm,rep))
    if code or not (out/'result.json').exists():
        raise RuntimeError(f'Executor process failed; inspect {out} and logs before a new revision')


def unload_qwen(frozen):
    request = urllib.request.Request(frozen['qwen']['baseUrl']+'/api/generate',
        data=json.dumps({'model':frozen['qwen']['name'],'keep_alive':0}).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=60) as response:
        response.read()


def run(root, stage):
    frozen = check_freeze(root)
    if stage in ['all','baseline']:
        for rep in [1,2]:
            for doc,schema in combinations()[::1 if rep == 1 else -1]:
                execute(root,doc,schema,'baseline',rep)
    if stage in ['all','ocr']:
        from prepare import convert
        for name in OCR:
            if not all((root/'ocr'/name/d/'manifest.json').exists() for d in DOCS):
                unload_qwen(frozen)
                if command(root,f'native-{name}',[PYTHONS[name],'-X','utf8',HERE/'native.py','--root',root,'--model',name]):
                    raise RuntimeError(f'Native {name} failed; retain failure logs, inspect before continuing')
            for doc in DOCS:
                if not (root/'inputs'/doc/name/'manifest.json').exists(): convert(root,name,doc)
        for rep in [1,2]:
            for doc,schema in combinations()[::1 if rep == 1 else -1]:
                for name in OCR[::1 if rep == 1 else -1]: execute(root,doc,schema,name,rep)
    if stage in ['all','native']:
        for name in ['evie','neomme','gliner']:
            for rep in [1,2]:
                for doc,schema in combinations():
                    path = root/'native-inputs'/name/f'{doc}-{schema}-r{rep}.json'
                    if not path.exists():
                        if command(root,f'prepare-{name}-{doc}-{schema}-r{rep}',[*ts_args(root,doc,schema,name,rep),'--prepare-native']):
                            raise RuntimeError('Native task preparation failed')
        for rep in [1,2]:
            for name in ['evie','neomme','gliner'][::1 if rep==1 else -1]:
                if not all((root/'native-outputs'/name/f'{d}-{s}-r{rep}.json').exists() for d,s in combinations()):
                    unload_qwen(frozen)
                    if command(root,f'native-{name}-r{rep}',[PYTHONS[name],'-X','utf8',HERE/'native.py','--root',root,'--model',name,'--repetition',str(rep)]):
                        raise RuntimeError(f'Native {name} failed')
        for rep in [1,2]:
            for doc,schema in combinations()[::1 if rep == 1 else -1]:
                for name in ['evie','neomme','gliner'][::1 if rep == 1 else -1]: execute(root,doc,schema,name,rep)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command',choices=['freeze','check','run'])
    parser.add_argument('--root',type=Path,default=DEFAULT_ROOT)
    parser.add_argument('--stage',choices=['all','baseline','ocr','native'],default='all')
    args = parser.parse_args()
    if args.command == 'freeze': freeze(args.root.resolve())
    elif args.command == 'check': check_freeze(args.root.resolve())
    else: run(args.root.resolve(),args.stage)
