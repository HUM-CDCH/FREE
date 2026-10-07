import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('free_deploy', Path(__file__).with_name('free-deploy.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL).decode().strip()


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.up = self.base / 'author'
        self.bare = self.base / 'origin.git'
        self.root = self.base / 'deployment'
        subprocess.run(['git', 'init', '--bare', str(self.bare)], check=True, capture_output=True)
        subprocess.run(['git', 'init', '-b', 'dev', str(self.up)], check=True, capture_output=True)
        for key, value in (('user.name', 'Fixture'), ('user.email', 'fixture@example.invalid')):
            git(self.up, 'config', key, value)
        (self.up / 'app.txt').write_text('old\n')
        (self.up / '.gitignore').write_text('.env\n')
        git(self.up, 'add', '.')
        git(self.up, 'commit', '-m', 'seed')
        git(self.up, 'remote', 'add', 'origin', str(self.bare))
        git(self.up, 'push', 'origin', 'dev')
        self.attest()
        subprocess.run(['git', 'clone', '--branch', 'dev', str(self.bare), str(self.root)], check=True, capture_output=True)
        for key, value in (('user.name', 'Fixture'), ('user.email', 'fixture@example.invalid')):
            git(self.root, 'config', key, value)
        self.head = git(self.root, 'rev-parse', 'HEAD')
        self.original_capture = module.capture
        self.calls = []
        self.fetch_failure = False
        self.fetch_failures_remaining = 0
        def capture(args, env=None, timeout=None):
            self.calls.append(args)
            if args[-3:] == ['remote', 'get-url', 'origin']:
                return b'https://github.com/HUM-CDCH/FREE.git\n'
            if 'fetch' in args and self.fetch_failure:
                raise RuntimeError('fixture network failure')
            if 'fetch' in args and self.fetch_failures_remaining:
                self.fetch_failures_remaining -= 1
                raise RuntimeError('fixture transient network failure')
            kwargs = {} if timeout is None else {'timeout': timeout}
            return self.original_capture(args, env=env, **kwargs)
        original_is_file = Path.is_file
        def is_file(path):
            return True if str(path) == '/srv/free/secrets/github.env' else original_is_file(path)
        self.patches = [patch.object(module, 'ROOT', self.root),
                        patch.object(module, 'GIT', ('git', '-C', str(self.root))),
                        patch.object(module, 'capture', capture),
                        patch.object(Path, 'is_file', is_file)]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def attest(self, body=None, target=None):
        head = git(self.up, 'rev-parse', 'HEAD')
        body = body or {'version': 1, 'repository': 'HUM-CDCH/FREE', 'commit': head,
                       'checks': {'verify': 'success', 'verify-python': 'success'}}
        tag = 'free-verified/' + head
        git(self.up, 'tag', '-a', tag, '-m', json.dumps(body), target or head)
        git(self.up, 'push', 'origin', 'refs/tags/' + tag)

    def publish(self, name='app.txt', contents='new\n', force=False, branch='dev', verified=True):
        (self.up / name).write_text(contents)
        git(self.up, 'add', *(('-f',) if force else ()), name)
        git(self.up, 'commit', '-m', 'upstream update')
        git(self.up, 'push', 'origin', branch)
        if verified:
            self.attest()
    def update(self, branch='dev'):
        with contextlib.redirect_stdout(io.StringIO()):module.update_source(branch)
    def test_clean_fast_forward(self):
        self.publish()
        self.update()
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), git(self.up, 'rev-parse', 'HEAD'))
        self.assertEqual((self.root / 'app.txt').read_text(), 'new\n')
        self.assertEqual(git(self.root, 'status', '--porcelain'), '')

    def test_a_commit_without_passing_ci_preserves_source_and_branch(self):
        self.publish(verified=False)
        with self.assertRaisesRegex(RuntimeError, 'verification'):
            self.update()
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual(git(self.root, 'branch', '--show-current'), 'dev')

    def test_a_failed_python_attestation_cannot_release(self):
        self.publish(verified=False)
        head = git(self.up, 'rev-parse', 'HEAD')
        self.attest({'version': 1, 'repository': 'HUM-CDCH/FREE', 'commit': head,
                     'checks': {'verify': 'success', 'verify-python': 'failure'}})
        with self.assertRaisesRegex(RuntimeError, 'verification'):
            self.update()
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)

    def test_an_attestation_for_another_commit_cannot_release(self):
        self.publish(verified=False)
        self.attest(target=self.head)
        with self.assertRaisesRegex(RuntimeError, 'verification'):
            self.update()
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
    def test_dirty_source_is_preserved_without_fetch(self):
        (self.root / 'app.txt').write_text('local edit\n')
        with self.assertRaisesRegex(RuntimeError, 'local edits'):self.update()
        self.assertFalse(any('fetch' in a for a in self.calls))
        self.assertEqual((self.root / 'app.txt').read_text(), 'local edit\n')
    def test_detached_checkout_refuses_fetch(self):
        git(self.root, 'switch', '--detach', 'HEAD')
        with self.assertRaisesRegex(RuntimeError, 'must be on a branch'):self.update()
        self.assertFalse(any('fetch' in a for a in self.calls))
    def test_new_remote_branch_is_checked_out_and_tracked(self):
        git(self.up, 'switch', '-c', 'feature/evaluation')
        self.publish(branch='feature/evaluation')
        self.update('feature/evaluation')
        self.assertEqual(git(self.root, 'branch', '--show-current'), 'feature/evaluation')
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), git(self.up, 'rev-parse', 'HEAD'))
        self.assertEqual(git(self.root, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/evaluation')
        self.assertEqual(git(self.root, 'status', '--porcelain'), '')
    def test_default_returns_to_dev_and_keeps_other_local_commits(self):
        git(self.root, 'switch', '-c', 'experiment')
        (self.root / 'experiment.txt').write_text('local experiment\n')
        git(self.root, 'add', 'experiment.txt');git(self.root, 'commit', '-m', 'local experiment')
        experiment = git(self.root, 'rev-parse', 'HEAD')
        self.publish()
        self.update()
        self.assertEqual(git(self.root, 'branch', '--show-current'), 'dev')
        self.assertEqual(git(self.root, 'rev-parse', 'experiment'), experiment)
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), git(self.up, 'rev-parse', 'HEAD'))
    def test_existing_selected_branch_fast_forwards(self):
        git(self.up, 'switch', '-c', 'feature/evaluation')
        self.publish(branch='feature/evaluation')
        self.update('feature/evaluation')
        git(self.root, 'switch', 'dev')
        self.publish(contents='second feature commit\n', branch='feature/evaluation')
        self.update('feature/evaluation')
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), git(self.up, 'rev-parse', 'HEAD'))
        self.assertEqual((self.root / 'app.txt').read_text(), 'second feature commit\n')
    def test_diverged_selected_branch_preserves_current_branch_and_commits(self):
        git(self.up, 'switch', '-c', 'feature/evaluation')
        self.publish(branch='feature/evaluation')
        git(self.root, 'switch', '-c', 'feature/evaluation')
        (self.root / 'local.txt').write_text('preserved feature work\n')
        git(self.root, 'add', 'local.txt');git(self.root, 'commit', '-m', 'local feature work')
        local = git(self.root, 'rev-parse', 'HEAD')
        git(self.root, 'switch', 'dev')
        with self.assertRaisesRegex(RuntimeError, 'cannot fast-forward'):
            self.update('feature/evaluation')
        self.assertEqual(git(self.root, 'branch', '--show-current'), 'dev')
        self.assertEqual(git(self.root, 'rev-parse', 'feature/evaluation'), local)
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
    def test_invalid_branch_names_refuse_fetch(self):
        for branch in ('', '-option', 'feature invalid', '@{-1}'):
            with self.subTest(branch=branch):
                with self.assertRaisesRegex(RuntimeError, 'Invalid branch'):
                    self.update(branch)
        self.assertFalse(any('fetch' in args for args in self.calls))
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
    def test_missing_remote_branch_keeps_current_checkout(self):
        with self.assertRaisesRegex(RuntimeError, 'Cannot fetch missing'):
            self.update('missing')
        self.assertEqual(git(self.root, 'branch', '--show-current'), 'dev')
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
    def test_branch_switch_preserves_ignored_runtime_symlink(self):
        configuration = self.base / 'production.env'
        configuration.write_text('private fixture configuration\n')
        (self.root / '.env').symlink_to(configuration)
        git(self.up, 'switch', '-c', 'feature/unsafe-config')
        self.publish('.env', 'upstream fixture\n', force=True, branch='feature/unsafe-config')
        with self.assertRaisesRegex(RuntimeError, 'cannot fast-forward cleanly'):
            self.update('feature/unsafe-config')
        self.assertTrue((self.root / '.env').is_symlink())
        self.assertEqual(configuration.read_text(), 'private fixture configuration\n')
        self.assertEqual(git(self.root, 'branch', '--show-current'), 'dev')
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
    def test_failed_merge_restores_previous_branch(self):
        configuration = self.base / 'production.env'
        configuration.write_text('private fixture configuration\n')
        (self.root / '.env').symlink_to(configuration)
        git(self.root, 'branch', 'feature/unsafe-config')
        git(self.up, 'switch', '-c', 'feature/unsafe-config')
        self.publish('.env', 'upstream fixture\n', force=True, branch='feature/unsafe-config')
        with self.assertRaisesRegex(RuntimeError, 'cannot fast-forward cleanly'):
            self.update('feature/unsafe-config')
        self.assertEqual(git(self.root, 'branch', '--show-current'), 'dev')
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual(git(self.root, 'rev-parse', 'feature/unsafe-config'), self.head)
        self.assertTrue((self.root / '.env').is_symlink())
        self.assertEqual(configuration.read_text(), 'private fixture configuration\n')
    def test_branch_name_can_also_exist_as_a_tag(self):
        git(self.root, 'tag', 'dev')
        self.publish()
        self.update()
        self.assertEqual(git(self.root, 'branch', '--show-current'), 'dev')
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), git(self.up, 'rev-parse', 'HEAD'))
    def test_concurrent_fetch_cannot_substitute_a_different_branch(self):
        git(self.up, 'switch', '-c', 'different')
        self.publish(contents='wrong branch\n', branch='different')
        git(self.up, 'switch', 'dev')
        self.publish(contents='requested branch\n')
        original_capture = module.capture
        def concurrent_fetch(args, **kwargs):
            result = original_capture(args, **kwargs)
            if 'fetch' in args:
                git(self.root, 'fetch', 'origin', 'refs/heads/different')
            return result
        with patch.object(module, 'capture', concurrent_fetch):
            with self.assertRaisesRegex(RuntimeError, 'fetched branch changed'):
                self.update()
        self.assertEqual(git(self.root, 'branch', '--show-current'), 'dev')
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual((self.root / 'app.txt').read_text(), 'old\n')
    def test_network_failure_keeps_old_revision(self):
        self.fetch_failure = True
        with self.assertRaisesRegex(RuntimeError, 'Cannot fetch dev'):self.update()
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
    def test_transient_fetch_failure_is_retried_before_deployment(self):
        self.publish()
        self.fetch_failures_remaining = 1
        self.update()
        self.assertEqual(sum('fetch' in args and '--no-write-fetch-head' not in args for args in self.calls), 2)
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), git(self.up, 'rev-parse', 'HEAD'))
        self.assertEqual(git(self.root, 'status', '--porcelain'), '')
    def test_stalled_transport_times_out_without_orphan_or_source_changes(self):
        transport = self.base / 'stalled-ssh'
        pid_file = self.base / 'transport.pid'
        transport.write_text('#!/usr/bin/env python3\nimport os,time\n'
                             f'open({str(pid_file)!r},"w").write(str(os.getpid()))\n'
                             'time.sleep(60)\n')
        transport.chmod(0o700)
        git(self.root, 'remote', 'set-url', 'origin', 'ssh://git@127.0.0.1/fixture.git')
        with patch.object(module, 'FETCH_TIMEOUT_SECONDS', 0.5, create=True), patch.dict(
                os.environ, {'GIT_SSH_COMMAND': str(transport), 'GIT_SSH_VARIANT': 'ssh'}):
            with self.assertRaisesRegex(RuntimeError, 'timed out'):
                self.update()
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual((self.root / 'app.txt').read_text(), 'old\n')
        self.assertEqual(git(self.root, 'status', '--porcelain'), '')
        pid = int(pid_file.read_text())
        status = Path(f'/proc/{pid}/status')
        if status.exists():
            state = next(line for line in status.read_text().splitlines() if line.startswith('State:'))
            self.assertIn('Z', state, 'The stalled SSH transport was left running')
    def test_divergence_preserves_committed_local_work(self):
        (self.root / 'local.txt').write_text('local commit\n')
        git(self.root, 'add', 'local.txt');git(self.root, 'commit', '-m', 'local work')
        local = git(self.root, 'rev-parse', 'HEAD')
        self.publish()
        with self.assertRaisesRegex(RuntimeError, 'cannot fast-forward'):self.update()
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), local)
        self.assertEqual((self.root / 'local.txt').read_text(), 'local commit\n')
    def test_ignored_runtime_configuration_is_preserved(self):
        (self.root / '.env').write_text('private fixture configuration\n')
        self.publish('.env', 'upstream fixture\n', force=True)
        with self.assertRaisesRegex(RuntimeError, 'cannot fast-forward'):self.update()
        self.assertEqual((self.root / '.env').read_text(), 'private fixture configuration\n')
        self.assertEqual(git(self.root, 'rev-parse', 'HEAD'), self.head)


class ReleaseLockTests(unittest.TestCase):
    def test_same_lock_covers_fetch_checks_and_deployment(self):
        with tempfile.TemporaryDirectory() as d:
            ops = Path(d)
            (ops / 'state').mkdir();(ops / 'state/deploy.lock').touch()
            calls = []
            def contend():
                p = subprocess.run([sys.executable, '-c',
                    "import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)",
                    str(ops / 'state/deploy.lock')], capture_output=True)
                self.assertNotEqual(p.returncode, 0)
            def preflight(recover=False):
                contend();calls.append('check')
                return {}, {}, {'counts': {'studio_active':0,'parsing_active':0}}
            def update(branch):
                self.assertEqual(branch, 'feature/evaluation')
                contend();calls.append('fetch')
            def deploy(*args, **kwargs):contend();calls.append('deploy')
            with patch.object(module,'OPS',ops), patch.object(module,'preflight',preflight), patch.object(module,'update_source',update), patch.object(module,'deploy',deploy), patch.object(sys,'argv',['free-deploy','release','--branch','feature/evaluation']):
                module.main()
            self.assertEqual(calls,['check','fetch','check','deploy'])
    def test_source_failure_never_deploys(self):
        with tempfile.TemporaryDirectory() as d:
            ops=Path(d);(ops/'state').mkdir();(ops/'state/deploy.lock').touch()
            with patch.object(module,'OPS',ops), patch.object(module,'preflight',return_value=({}, {}, {'counts':{'studio_active':0,'parsing_active':0}})), patch.object(module,'update_source',side_effect=RuntimeError('fetch failed')), patch.object(module,'deploy') as deploy, patch.object(sys,'argv',['free-deploy','release']):
                with self.assertRaisesRegex(RuntimeError,'fetch failed'):module.main()
                deploy.assert_not_called()


if __name__ == '__main__':unittest.main()
