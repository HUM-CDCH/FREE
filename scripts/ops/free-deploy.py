#!/usr/bin/env python3
"""Operate the existing Baratheon deployment without changing its model topology."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys

ROOT = Path('/srv/free/checkout')
OPS = Path('/srv/free/ops')
COMPOSE = '/srv/free/ops/bin/free-compose'
APPS = ('studio', 'parsing_service', 'parsing_worker')
VOLUMES = ('free_source-inbox', 'free_parsing-runs', 'free_studio-data',
           'free_studio-config', 'free_studio-claude')
GIT = ('git', '-c', f'safe.directory={ROOT}', '--no-optional-locks', '-C', str(ROOT))
FETCH_TIMEOUT_SECONDS = 60


def compose_environment():
    """Mirror buildRevision's Git contract using its shared context definitions.

    The shared operator wrapper deliberately supplies only system Python/Git;
    neither Node nor a Node workspace installation is required on this host.
    """
    names = ('FREE_REVISION_STUDIO', 'FREE_REVISION_PARSING')
    try:
        manifest = ROOT / 'scripts/build-revisions.json'
        if not manifest.exists() and (ROOT / 'scripts/free.mjs').is_file():
            # Bootstrap/rollback for the pre-manifest launcher. Its contexts
            # were fixed to these paths; release checks that checkout before
            # fetching the new verified source and its shared manifest.
            contexts = {'FREE_REVISION_STUDIO': ['.'],
                        'FREE_REVISION_PARSING': ['prototypes/parsing_service']}
        else:
            contexts = json.loads(manifest.read_text())
    except (OSError, ValueError):
        raise RuntimeError('Cannot read application build contexts.') from None
    if not isinstance(contexts, dict) or set(contexts) != set(names) or any(
            not isinstance(paths, list) or not paths or any(not isinstance(path, str) or not path
                or Path(path).is_absolute() or '..' in Path(path).parts for path in paths)
            for paths in contexts.values()):
        raise RuntimeError('Cannot determine application image revisions.')
    revisions = {}
    for name, paths in contexts.items():
        commit = capture([*GIT, 'log', '-1', '--format=%H', '--', *paths]).decode().strip()
        dirty = capture([*GIT, 'status', '--porcelain', '--untracked-files=no', '--', *paths]).strip()
        revisions[name] = commit + ('-dirty' if dirty else '')
    if any(not re.fullmatch(r'[a-f0-9]{40}(?:-dirty)?', revisions[name]) for name in names):
        raise RuntimeError('Cannot determine application image revisions.')
    return {**os.environ, **{name: revisions[name] for name in names}}


def require_verified_commit(commit):
    """The trusted CI workflow publishes this exact SHA only after both jobs pass.

    Fetch with the operator's existing Git SSH access, without replacing the
    branch's FETCH_HEAD. No API token or extra operator credential is needed.
    """
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise RuntimeError('A full GitHub commit is required for verification.')
    origin = capture([*GIT, 'remote', 'get-url', 'origin']).decode().strip()
    if origin not in ('git@github.com:HUM-CDCH/FREE.git', 'https://github.com/HUM-CDCH/FREE.git'):
        raise RuntimeError('The deployment origin must be the configured FREE GitHub repository.')
    ref = f'refs/free-deploy-verified/{commit}'
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/false'}
    try:
        capture([*GIT, 'fetch', '--no-tags', '--no-write-fetch-head', 'origin',
                 f'refs/tags/free-verified/{commit}:{ref}'], env=env, timeout=FETCH_TIMEOUT_SECONDS)
        kind = capture([*GIT, 'cat-file', '-t', ref]).decode().strip()
        target = capture([*GIT, 'rev-parse', f'{ref}^{{commit}}']).decode().strip()
        record = json.loads(capture([*GIT, 'for-each-ref', '--format=%(contents)', ref]))
    except (RuntimeError, subprocess.TimeoutExpired, ValueError):
        raise RuntimeError('Commit verification is unavailable. Wait for both GitHub CI jobs and their release tag; no services were changed.') from None
    if (kind != 'tag' or target != commit or not isinstance(record, dict) or type(record.get('version')) is not int or record != {
            'version': 1, 'repository': 'HUM-CDCH/FREE', 'commit': commit,
            'checks': {'verify': 'success', 'verify-python': 'success'}}):
        raise RuntimeError('Commit verification does not prove both required checks passed; no services were changed.')


def verify_built_images(config):
    expected = compose_environment()
    for service in APPS:
        image = config['services'][service].get('image', f'free-{service}')
        actual = capture(['docker', 'image', 'inspect', '--format',
                          '{{index .Config.Labels "org.opencontainers.image.revision"}}', image]).decode().strip()
        revision = expected['FREE_REVISION_STUDIO' if service == 'studio' else 'FREE_REVISION_PARSING']
        if actual != revision or revision.endswith('-dirty'):
            raise RuntimeError(f'{service} image revision does not match reviewed source; no containers were stopped.')


def verify_running_images(ours):
    expected = compose_environment()
    for service in APPS:
        revision = expected['FREE_REVISION_STUDIO' if service == 'studio' else 'FREE_REVISION_PARSING']
        actual = (ours[service]['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')
        if actual != revision:
            raise RuntimeError(f'{service} running image revision does not match reviewed source.')


def capture(args, env=None, timeout=None):
    if args[0] == COMPOSE:
        env = compose_environment()
    result = subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env=env,
                              start_new_session=timeout is not None)
    try:
        stdout, _ = result.communicate(timeout=timeout)
    except BaseException:
        # A bounded Git fetch owns its transport children; do not orphan SSH.
        try:
            if timeout is not None:
                os.killpg(result.pid, signal.SIGKILL)
            else:
                result.kill()
        except ProcessLookupError:
            pass
        result.communicate()
        raise
    if result.returncode:
        # Compose rendering and Docker inspect contain secrets; never echo them.
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode}).')
    return stdout


def update_source(branch='dev'):
    """Fast-forward the clean deployment checkout while main holds its lock."""
    try:
        checked = capture([*GIT, 'check-ref-format', '--branch', branch]).decode().strip()
        if not branch or checked != branch:
            raise RuntimeError('Invalid branch')
    except RuntimeError:
        raise RuntimeError('Invalid branch name; specify a literal remote branch name.') from None
    try:
        before_branch = capture([*GIT, 'branch', '--show-current']).decode().strip()
        if not before_branch:
            raise RuntimeError('Detached checkout')
    except RuntimeError:
        raise RuntimeError('The deployment checkout must be on a branch; no services were changed.') from None
    if capture([*GIT, 'status', '--porcelain']).strip():
        raise RuntimeError('The deployment checkout has local edits; commit/review them before releasing.')
    origin = capture([*GIT, 'remote', 'get-url', 'origin']).decode().strip()
    if origin not in ('git@github.com:HUM-CDCH/FREE.git', 'https://github.com/HUM-CDCH/FREE.git'):
        raise RuntimeError('The deployment origin must be the configured FREE GitHub repository.')
    before = capture([*GIT, 'rev-parse', 'HEAD']).decode().strip()
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': '/bin/false'}
    for attempt in range(1, 4):
        print(f'Fetching {branch} from GitHub (attempt {attempt}/3)...', flush=True)
        try:
            capture([*GIT, 'fetch', '--no-tags', 'origin',
                     f'refs/heads/{branch}:refs/remotes/origin/{branch}'], env=env,
                    timeout=FETCH_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f'Fetching {branch} from GitHub timed out; check network access and retry. No services were changed.') from None
        except RuntimeError:
            if attempt == 3:
                raise RuntimeError(f'Cannot fetch {branch} after 3 attempts. Check that the branch exists and network access works; free-deploy auth can check your account. No services were changed.') from None
        else:
            break
    # Read once and verify the requested branch: a manual fetch can replace this file.
    entries = (ROOT / '.git/FETCH_HEAD').read_text().splitlines()
    fields = entries[0].split('\t', 2) if len(entries) == 1 else []
    if (len(fields) != 3 or not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', fields[0])
            or not fields[2].startswith(f"branch '{branch}' of ")):
        raise RuntimeError('The fetched branch changed; retry the release. No merge or deployment was attempted.')
    target = fields[0]
    require_verified_commit(target)
    if (capture([*GIT, 'status', '--porcelain']).strip() or
            capture([*GIT, 'rev-parse', 'HEAD']).decode().strip() != before or
            capture([*GIT, 'branch', '--show-current']).decode().strip() != before_branch):
        raise RuntimeError('The source changed while fetching; no merge or deployment was attempted.')
    try:
        local_head = capture([*GIT, 'rev-parse', '--verify', '--quiet',
                              f'refs/heads/{branch}']).decode().strip()
    except RuntimeError:
        local_head = None
    if local_head:
        try:
            capture([*GIT, 'merge-base', '--is-ancestor', local_head, target])
        except RuntimeError:
            raise RuntimeError(f'{branch} cannot fast-forward cleanly; local commits and the current checkout were preserved.') from None
    switched = False
    try:
        if before_branch != branch:
            if local_head:
                capture([*GIT, 'switch', '--no-overwrite-ignore', branch])
                switched = True
            else:
                capture([*GIT, 'switch', '--no-overwrite-ignore', '-c', branch, target])
                switched = True
                capture([*GIT, 'branch', f'--set-upstream-to=refs/remotes/origin/{branch}', branch])
        capture([*GIT, 'merge', '--ff-only', '--no-overwrite-ignore', target])
    except RuntimeError:
        if switched:
            try:
                capture([*GIT, 'switch', '--no-overwrite-ignore', before_branch])
            except RuntimeError:
                raise RuntimeError(f'{branch} could not be updated and the previous branch could not be restored; check the checkout. No deployment was attempted.') from None
        raise RuntimeError(f'{branch} cannot fast-forward cleanly; source edits and deployment files were preserved.') from None
    if (capture([*GIT, 'status', '--porcelain']).strip() or
            capture([*GIT, 'branch', '--show-current']).decode().strip() != branch or
            capture([*GIT, 'rev-parse', 'HEAD']).decode().strip() != target):
        raise RuntimeError('The source changed during the update; no deployment was attempted.')
    print(f'Updated {branch}: {before[:12]} -> {target[:12]}', flush=True)


def command(args):
    env = compose_environment() if args[0] == COMPOSE else None
    result = subprocess.run(args, cwd=ROOT, check=False, env=env)
    if result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {result.returncode}).')


def containers():
    ids = capture(['docker', 'ps', '-aq']).decode().split()
    return json.loads(capture(['docker', 'inspect', *ids])) if ids else []


def source_digest():
    digest = hashlib.sha256(capture([*GIT, 'diff', '--binary', 'HEAD']))
    for raw in capture([*GIT, 'ls-files', '--others', '--exclude-standard', '-z']).split(b'\0'):
        if not raw:
            continue
        path = ROOT / os.fsdecode(raw)
        digest.update(raw + b'\0')
        if path.is_symlink():
            digest.update(os.fsencode(os.readlink(path)))
        else:
            with open(path, 'rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(block)
    return digest.hexdigest()


def database_counts():
    sql = '''SELECT json_build_object(
      'projects', (SELECT count(*) FROM public."projectContext"),
      'sources', (SELECT count(*) FROM public."sourceDocument"),
      'extractions', (SELECT count(*) FROM public."extraction"),
      'studio_active', (SELECT count(*) FROM dbos.workflow_status WHERE status IN ('ENQUEUED','DELAYED','PENDING')),
      'parsing_active', (SELECT count(*) FROM kei_dbos.workflow_status WHERE status IN ('ENQUEUED','DELAYED','PENDING')));'''
    return json.loads(capture(['docker', 'exec', 'free-db-1', 'psql', '-X', '-U',
                              'postgres', '-d', 'free', '-At', '-v',
                              'ON_ERROR_STOP=1', '-c', sql]))


def preflight(recover=False):
    capture([COMPOSE, 'config', '--quiet'])
    config = json.loads(capture([COMPOSE, 'config', '--format', 'json']))
    services = config['services']
    if config['name'] != 'free' or services['extraction_model'].get('scale') != 0:
        raise RuntimeError('The project must be free and extraction_model must stay disabled.')
    if services['studio']['environment'].get('FREE_DEPLOYMENT_INSTRUCT_URL') != 'http://extraction_nvfp4:8000/v1':
        raise RuntimeError('The existing NVFP4 deployment route must be preserved.')
    if 'humanizer' not in services['nginx'].get('networks', {}):
        raise RuntimeError('The shared Humanizer nginx network must be preserved.')
    for name in ('postgres-data', 'source-inbox', 'parsing-runs', 'studio-data',
                 'studio-config', 'studio-claude'):
        if config['volumes'][name].get('name') != f'free_{name}':
            raise RuntimeError(f'The existing {name} volume must be preserved.')
    live = containers()
    ours = {}
    for c in live:
        labels = c['Config'].get('Labels') or {}
        # docker run inherits project/service image labels. Only Compose service
        # instances have both the replica number and the non-oneoff marker.
        if (labels.get('com.docker.compose.project') != 'free'
                or labels.get('com.docker.compose.oneoff') != 'False'
                or not labels.get('com.docker.compose.container-number')):
            continue
        name = labels.get('com.docker.compose.service')
        if name in ours:
            raise RuntimeError(f'Duplicate {name} containers require investigation.')
        ours[name] = c
    for name in ('db', 'nginx', 'ocr_model', 'nuextract_model', 'gliformer_model', 'phoenix', *APPS):
        c = ours.get(name)
        if recover and name in APPS:
            continue
        if not c or not c['State']['Running']:
            raise RuntimeError(f'{name} is not running; investigate before deploying.')
        if c['State'].get('Health', {}).get('Status', 'healthy') != 'healthy':
            raise RuntimeError(f'{name} is unhealthy; investigate before deploying.')
    if 'extraction_model' in ours:
        raise RuntimeError('An unexpected extraction_model container exists.')
    if not any(x['Name'] == '/free-nvfp4-live' and x['State']['Running'] for x in live):
        raise RuntimeError('The external NVFP4 server is not running.')
    hashes = dict(line.split(maxsplit=1) for line in capture([COMPOSE, 'config', '--hash', '*']).decode().splitlines())
    plan = subprocess.run([COMPOSE, '--dry-run', '--progress', 'plain', 'up', '--no-build',
                           '--no-deps', '-d', *APPS], cwd=ROOT, capture_output=True, text=True)
    if plan.returncode or re.search(r'\b(?:Network|Volume)\s', plan.stdout + plan.stderr):
        raise RuntimeError('The dry-run includes network/volume changes or failed; investigate before deploying.')
    diff = capture([*GIT, 'diff', '--binary', 'HEAD'])
    report = {
        'project': 'free', 'operator': os.environ['USER'],
        'commit': capture([*GIT, 'rev-parse', 'HEAD']).decode().strip(),
        'branch': capture([*GIT, 'branch', '--show-current']).decode().strip(),
        'operator_patch_sha256': hashlib.sha256(diff).hexdigest(),
        'source_sha256': source_digest(),
        'configuration_sha256': hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest(),
        'changed_service_configs': sorted(name for name, c in ours.items()
            if hashes.get(name) != c['Config']['Labels'].get('com.docker.compose.config-hash')),
        'counts': database_counts(),
        'containers': {x['Name'].lstrip('/'): {'id': x['Id'], 'image': x['Image']}
                       for x in live if x['State']['Running'] and (
                           (x['Config'].get('Labels') or {}).get('com.docker.compose.project') in ('free', 'humanizer')
                           or x['Name'] == '/free-nvfp4-live')},
    }
    report['image_revisions'] = {service: (container['Config'].get('Labels') or {}).get(
        'org.opencontainers.image.revision', 'unknown') for service, container in ours.items()}
    return config, ours, report


def save_json(path, value):
    with open(path, 'x') as f:
        os.chmod(path, 0o600)
        json.dump(value, f, indent=2)


def backup_command(args, path):
    with open(path, 'xb') as output:
        os.chmod(path, 0o600)
        result = subprocess.run(args, cwd=ROOT, stdout=output,
                                stderr=subprocess.PIPE, check=False)
    if result.returncode or path.stat().st_size == 0:
        raise RuntimeError(f'Backup failed: {path.name}; the previous containers will be restarted.')


def deploy(config, ours, before, recover=False):
    if not recover and (before['counts']['studio_active'] or before['counts']['parsing_active']):
        raise RuntimeError('Active work remains; let the workflows finish before deploying.')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = OPS / 'backups' / f'{stamp}-{os.getuid()}'
    backup.mkdir(mode=0o700)
    save_json(backup / 'before.json', before)
    with open(backup / 'operator.patch', 'xb') as f:
        os.chmod(f.name, 0o600)
        f.write(capture([*GIT, 'diff', '--binary', 'HEAD']))
    for source in (ROOT / '.env', Path(COMPOSE),
                   Path('/srv/free/config') / 'free-dev-nvfp4.yaml', Path('/srv/free/config') / 'free-dev-gliformer.yaml',
                   Path('/srv/free/secrets/studio.crt'),
                   Path('/srv/free/secrets/studio.key'),
                   Path('/srv/free/secrets/entra-client.pem')):
        destination = backup / source.name
        shutil.copyfile(source, destination)
        os.chmod(destination, 0o600)
    for name in APPS:
        if name in ours:
            capture(['docker', 'image', 'tag', ours[name]['Image'], f'free-rollback-{name}:{stamp}'])
    # A build failure leaves the current application serving. Do not build GPU services.
    command([COMPOSE, 'build', *APPS])
    counts = database_counts()
    if not recover and (counts['studio_active'] or counts['parsing_active']):
        raise RuntimeError('Work was admitted during the build; no containers were stopped.')
    current_config = json.loads(capture([COMPOSE, 'config', '--format', 'json']))
    if (capture([*GIT, 'rev-parse', 'HEAD']).decode().strip() != before['commit'] or
            source_digest() != before['source_sha256'] or hashlib.sha256(
                json.dumps(current_config, sort_keys=True).encode()).hexdigest() != before['configuration_sha256']):
        raise RuntimeError('The source/configuration changed during the build; no containers were stopped.')
    verify_built_images(current_config)
    old_ids = [ours[name]['Id'] for name in APPS if name in ours and ours[name]['State']['Running']]
    archive_image = ours.get('parsing_worker', {}).get('Image') or json.loads(
        capture(['docker', 'image', 'inspect', 'free-parsing_worker']))[0]['Id']
    try:
        command([COMPOSE, 'stop', '--timeout', '60', *APPS])
        stopped_counts = database_counts()
        if not recover and (stopped_counts['studio_active'] or stopped_counts['parsing_active']):
            raise RuntimeError('Work arrived before shutdown; the previous apps will resume it.')
        backup_command(['docker', 'exec', 'free-db-1', 'pg_dump', '-U', 'postgres', '-Fc', 'free'],
                       backup / 'free.dump')
        with open(backup / 'free.dump', 'rb') as dump:
            result = subprocess.run(['docker', 'exec', '-i', 'free-db-1', 'pg_restore', '--list'],
                                    stdin=dump, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, check=False)
        if result.returncode:
            raise RuntimeError('The database backup could not be read.')
        for volume in VOLUMES:
            backup_command(['docker', 'run', '--rm', '--network', 'none', '--read-only',
                            '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
                            '--security-opt', 'no-new-privileges',
                            '--mount', f'type=volume,src={volume},dst=/backup,readonly',
                            '--entrypoint', 'tar', archive_image,
                            '-C', '/backup', '-cf', '-', '.'], backup / f'{volume}.tar')
    except BaseException:
        # This is before migration/recreation: restarting the original IDs is safe.
        if old_ids:
            capture(['docker', 'start', *old_ids])
        raise
    print(f'Consistent backup saved to {backup}', flush=True)
    # Explicit app services and --no-deps preserve nginx, models, DB and Humanizer.
    # After migration starts, failures require a forward fix or the full backup.
    command([COMPOSE, 'up', '--no-build', '--no-deps', '-d', '--wait', '--wait-timeout', '900', *APPS])
    _, running, after = preflight()
    verify_running_images(running)
    protected = {name: value for name, value in before['containers'].items()
                 if name not in {f'free-{service}-1' for service in APPS}}
    if any(after['containers'].get(name) != value for name, value in protected.items()):
        raise RuntimeError('A protected container changed; investigate before further deployment.')
    origin = config['services']['studio']['environment']['STUDIO_ORIGIN']
    base = config['services']['studio']['environment']['STUDIO_BASE_PATH']
    cert = config['services']['nginx']['volumes']
    ca = next((x['source'] for x in cert if x.get('target') == '/etc/nginx/tls/studio.crt'), None)
    if not ca:
        raise RuntimeError('The nginx TLS certificate mount is missing; verify health manually.')
    capture(['curl', '--fail', '--silent', '--show-error', '--cacert', ca,
             '--connect-timeout', '10', '--max-time', '30', f'{origin}{base}/api/healthz'])
    save_json(backup / 'after.json', after)
    print(json.dumps({'result': 'deployed', 'commit': after['commit'],
                      'counts': after['counts'], 'backup': str(backup)}, indent=2))


def main():
    parser = argparse.ArgumentParser(prog='free-deploy', description=__doc__)
    parser.add_argument('action', choices=('check', 'status', 'deploy', 'release', 'auth'))
    parser.add_argument('--recover', action='store_true', help='Allow a forward fix with unhealthy/missing app containers.')
    parser.add_argument('--branch', metavar='NAME', help='Release this remote branch (default: dev).')
    args = parser.parse_args()
    action = args.action
    if args.recover and action not in ('deploy', 'release'):
        parser.error('--recover is only valid for deploy or release')
    if args.branch is not None and action != 'release':
        parser.error('--branch is only valid for release')
    if action == 'auth':
        os.execv(str(OPS / 'bin/github-access-setup'), [str(OPS / 'bin/github-access-setup')])
    with open(OPS / 'state' / 'deploy.lock', 'r+') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another deployment or check is in progress.')
        if action == 'release':
            _, _, previous = preflight(recover=args.recover)
            if not args.recover and (previous['counts']['studio_active'] or previous['counts']['parsing_active']):
                raise RuntimeError('Workflows are active; try releasing after they finish.')
            update_source(args.branch if args.branch is not None else 'dev')
        config, ours, report = preflight(recover=args.recover)
        if action == 'deploy':
            if capture([*GIT, 'status', '--porcelain']).strip():
                raise RuntimeError('Commit/review local edits before deployment.')
            require_verified_commit(report['commit'])
        record = {'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'action': action, **report}
        with open(OPS / 'state' / 'deploy.log', 'a') as log:
            log.write(json.dumps(record) + '\n')
        if action in ('deploy', 'release'):
            deploy(config, ours, report, recover=args.recover)
        else:
            print(json.dumps(report, indent=2))


if __name__ == '__main__':
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f'Interrupted by signal {signum}')
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        print('free-deploy: interrupted; check service status before continuing.', file=sys.stderr)
        sys.exit(130)
    except (RuntimeError, OSError, KeyError, ValueError) as error:
        print(f'free-deploy: {error}', file=sys.stderr)
        sys.exit(1)
