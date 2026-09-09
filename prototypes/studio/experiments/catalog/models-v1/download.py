"""Download pinned checkpoints; bounded HTTP ranges avoid stalled large responses."""
import argparse
import concurrent.futures
import hashlib
import json
import time
import urllib.request
from pathlib import Path
from inspect_models import ROOT, get

def fetch_range(url, start, stop):
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={'Range': f'bytes={start}-{stop}'})
            with urllib.request.urlopen(request, timeout=60) as response:
                if response.status != 206 or not response.headers.get('Content-Range', '').startswith(f'bytes {start}-{stop}/'):
                    raise ValueError('Unexpected HTTP byte range')
                data = response.read()
            if len(data) != stop - start + 1:
                raise ValueError('Incomplete HTTP range')
            return start, data
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('model')
    args = parser.parse_args()
    source = ROOT / 'sources' / args.model
    info = json.loads((source / 'metadata.json').read_bytes())
    detailed = json.loads(get(f'https://huggingface.co/api/models/{info["id"]}/revision/{info["sha"]}?blobs=true'))
    target = ROOT / 'checkpoints' / args.model
    target.mkdir(parents=True, exist_ok=True)
    for item in detailed['siblings']:
        name = item['rfilename']
        if not (('/' not in name and name.endswith(('.json', '.jinja', '.txt', '.model', '.safetensors', '.py'))) or name.startswith('colpali/') and name.endswith('.py')):
            continue
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        url = f'https://huggingface.co/{info["id"]}/resolve/{info["sha"]}/{name}'
        size = item.get('size', 0)
        sha = item.get('lfs', {}).get('sha256')
        if path.exists() and (not sha or hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() == sha):
            continue
        if size < 8 * 1024**2:
            path.write_bytes(get(url))
        else:
            partial = path.with_suffix(path.suffix + '.partial')
            journal = path.with_suffix(path.suffix + '.ranges.json')
            done = set(json.loads(journal.read_bytes())) if journal.exists() else set()
            chunk = 8 * 1024**2
            ranges = [(start, min(size-1, start+chunk-1)) for start in range(0, size, chunk) if start not in done]
            with partial.open('r+b' if partial.exists() else 'w+b') as output:
                output.truncate(size)
                with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                    futures = {pool.submit(fetch_range, url, start, stop): start for start, stop in ranges}
                    for future in concurrent.futures.as_completed(futures):
                        start, data = future.result()
                        del futures[future]
                        output.seek(start)
                        output.write(data)
                        output.flush()
                        done.add(start)
                        journal.write_text(json.dumps(sorted(done)))
                        if len(done) % 16 == 0:
                            print(args.model, name, round(len(done)*chunk/size*100), '%', flush=True)
            if sha and hashlib.file_digest(partial.open('rb'), 'sha256').hexdigest() != sha:
                raise ValueError(f'Weight checksum mismatch: {name}')
            partial.replace(path)
        print('Saved', args.model, name, flush=True)
    (target / 'verified-metadata.json').write_text(json.dumps(detailed, indent=2))
