#!/usr/bin/env python3
"""Parse a supplied PDF once, retain immutable inputs, and render source pages for review."""
import argparse
import hashlib
import json
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--parser-url', default='http://127.0.0.1:8055')
    parser.add_argument('--task-id', help='Reuse an already completed parser task after source hash verification')
    args = parser.parse_args()
    source = args.pdf.resolve().read_bytes()
    sha = hashlib.sha256(source).hexdigest()
    args.out.mkdir(parents=True, exist_ok=True)
    base = args.parser_url.rstrip('/')

    def get(path):
        with urllib.request.urlopen(base + path, timeout=30) as response:
            return response.read()

    existing = args.out / 'parsed_document.json'
    if existing.exists():
        document = json.loads(existing.read_bytes())
        if document['document']['content_sha256'] != sha:
            raise ValueError('Output directory already belongs to another PDF')
        print('Reusing frozen parser snapshot', existing, flush=True)
    else:
        task = args.task_id
        if not task:
            boundary = 'catalog-' + uuid.uuid4().hex
            # A fixed multipart filename avoids escaping user-controlled names in headers.
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="catalog.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode()
                    + source + f'\r\n--{boundary}--\r\n'.encode())
            request = urllib.request.Request(base + '/tasks', data=body, headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
            with urllib.request.urlopen(request, timeout=30) as response:
                created = json.load(response)
            (args.out / 'parse-task.json').write_text(json.dumps(created, indent=2))
            task = created['task_id']
        # Only task UUIDs returned by the service or explicitly supplied are accepted.
        task = str(uuid.UUID(task))
        while True:
            status = json.loads(get('/tasks/' + task))
            if status.get('content_sha256') != sha:
                raise ValueError('Parser task belongs to another PDF')
            (args.out / 'parse-status.json').write_text(json.dumps(status, indent=2))
            print('Parsing:', status['status'], flush=True)
            if status['status'] == 'completed':
                break
            if status['status'] not in ('pending', 'running'):
                raise RuntimeError(status.get('error') or status['status'])
            time.sleep(5)
        existing.write_bytes(get('/tasks/' + task + '/document'))
        (args.out / 'document.md').write_bytes(get('/tasks/' + task + '/markdown'))
    subprocess.run(['pdftoppm', '-scale-to', '2000', '-png', str(args.pdf.resolve()), str((args.out / 'page').resolve())], check=True)
    document = json.loads(existing.read_bytes())
    page_sizes = {p['page_number']: (p['width_pt'], p['height_pt']) for p in document['pages']}
    observations = [o for a in document['evidence_index']['anchors'] for o in a['producer_observations']]
    geometry_errors = []
    for observation in observations:
        box = observation.get('bbox')
        size = page_sizes.get(observation['page_number'])
        if box and (not size or not (0 <= box['x0'] < box['x1'] <= size[0] + .01 and 0 <= box['y0'] < box['y1'] <= size[1] + .01)):
            geometry_errors.append(observation['occurrence_id'])
    (args.out / 'input-manifest.json').write_text(json.dumps({
        'sourcePath': str(args.pdf.resolve()), 'sourceSha256': sha,
        'parsedDocumentSha256': hashlib.sha256(existing.read_bytes()).hexdigest(),
        'pageCount': document['page_count'], 'blockCount': len(document['content_stream']),
        'anchorCount': len(document['evidence_index']['anchors']),
        'observationCount': len(observations), 'outOfBoundsObservations': geometry_errors,
        'parserDiagnostics': document['diagnostics'],
        'reviewNote': 'Geometry bounds checks do not prove that a box visually encloses the correct text. Use the rendered source pages for review.',
    }, ensure_ascii=False, indent=2))
    print('Prepared source pages and input manifest:', args.out, flush=True)


if __name__ == '__main__':
    main()
