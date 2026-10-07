import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('free_deploy', Path(__file__).with_name('free-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
verify_built_images = deploy.verify_built_images


class DeploymentFailures(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'checkout'
        self.ops = Path(self.tmp.name) / 'ops'
        self.root.mkdir()
        (self.ops / 'backups').mkdir(parents=True)
        self.config = {'services': {'studio': {'environment': {
            'STUDIO_ORIGIN': 'https://fixture.invalid', 'STUDIO_BASE_PATH': '/free'}},
            'nginx': {'volumes': [{'target': '/etc/nginx/tls/studio.crt', 'source': '/fixture.crt'}]}}}
        self.ours = {name: {'Id': 'old-' + name, 'Image': 'image-' + name,
                            'State': {'Running': True}} for name in deploy.APPS}
        self.before = {'commit': 'head', 'counts': {'studio_active': 0, 'parsing_active': 0},
            'source_sha256': 'source', 'operator_patch_sha256': 'patch',
            'configuration_sha256': hashlib.sha256(json.dumps(self.config, sort_keys=True).encode()).hexdigest(),
            'containers': {'free-nvfp4-live': {'id': 'model', 'image': 'model-image'}}}
        self.after = copy.deepcopy(self.before)
        self.command_calls = []
        self.capture_calls = []
        self.stack = []
        def install(target, value):
            p = patch.object(deploy, target, value)
            p.start()
            self.addCleanup(p.stop)
        install('ROOT', self.root)
        install('OPS', self.ops)
        install('capture', self.capture)
        install('command', self.command)
        install('compose_environment', lambda: {'FREE_REVISION_STUDIO': 'a' * 40, 'FREE_REVISION_PARSING': 'b' * 40})
        install('verify_built_images', lambda config: None)
        install('verify_running_images', lambda ours: None)
        install('source_digest', lambda: 'source')
        install('database_counts', lambda: {'studio_active': 0, 'parsing_active': 0})
        install('preflight', lambda: (self.config, self.ours, self.after))
        install('backup_command', lambda args, path: path.write_bytes(b'fixture'))
        p = patch.object(deploy.shutil, 'copyfile', lambda src, dst: Path(dst).write_text('fixture'))
        p.start(); self.addCleanup(p.stop)
        p = patch.object(deploy.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a, 0))
        p.start(); self.addCleanup(p.stop)

    def capture(self, args):
        self.capture_calls.append(args)
        if args[-2:] == ['rev-parse', 'HEAD']:
            return b'head\n'
        if '--format' in args:
            return json.dumps(self.config).encode()
        return b'fixture'

    def command(self, args):
        self.command_calls.append(args)

    def run_deploy(self):
        deploy.deploy(self.config, self.ours, self.before)

    def assert_not_stopped(self):
        self.assertFalse(any('stop' in c or 'up' in c for c in self.command_calls))

    def test_build_failure_keeps_application_running(self):
        with patch.object(deploy, 'command', side_effect=RuntimeError('build failed')):
            with self.assertRaisesRegex(RuntimeError, 'build failed'):
                self.run_deploy()
        self.assertFalse(any(c[:2] == ['docker', 'start'] for c in self.capture_calls))

    def test_work_admitted_during_build_never_stops_application(self):
        with patch.object(deploy, 'database_counts', return_value={'studio_active': 1, 'parsing_active': 0}):
            with self.assertRaisesRegex(RuntimeError, 'admitted'):
                self.run_deploy()
        self.assert_not_stopped()

    def test_source_changed_during_build_never_stops_application(self):
        with patch.object(deploy, 'source_digest', return_value='changed'):
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                self.run_deploy()
        self.assert_not_stopped()

    def test_config_changed_during_build_never_stops_application(self):
        self.before['configuration_sha256'] = 'previous'
        with self.assertRaisesRegex(RuntimeError, 'changed'):
            self.run_deploy()
        self.assert_not_stopped()

    def test_an_unknown_built_image_revision_never_stops_application(self):
        with patch.object(deploy, 'verify_built_images', verify_built_images), patch.object(
                deploy, 'capture', lambda args: b'unknown' if '--format' in args and 'inspect' in args
                else self.capture(args)):
            with self.assertRaisesRegex(RuntimeError, 'image revision'):
                self.run_deploy()
        self.assert_not_stopped()

    def test_backup_failure_restarts_only_original_app_containers(self):
        with patch.object(deploy, 'backup_command', side_effect=RuntimeError('backup failed')):
            with self.assertRaisesRegex(RuntimeError, 'backup failed'):
                self.run_deploy()
        starts = [c for c in self.capture_calls if c[:2] == ['docker', 'start']]
        self.assertEqual(starts, [['docker', 'start', *['old-' + name for name in deploy.APPS]]])
        self.assertFalse(any('up' in c for c in self.command_calls))

    def test_late_admission_is_resumed_by_original_apps(self):
        with patch.object(deploy, 'database_counts', side_effect=[
                {'studio_active': 0, 'parsing_active': 0},
                {'studio_active': 1, 'parsing_active': 0}]):
            with self.assertRaisesRegex(RuntimeError, 'arrived'):
                self.run_deploy()
        self.assertTrue(any(c[:2] == ['docker', 'start'] for c in self.capture_calls))
        self.assertFalse(any('up' in c for c in self.command_calls))

    def test_interrupted_backup_restarts_previous_application(self):
        with patch.object(deploy, 'backup_command', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.run_deploy()
        self.assertTrue(any(c[:2] == ['docker', 'start'] for c in self.capture_calls))

    def test_failure_after_migration_never_restarts_old_images(self):
        def fail_up(args):
            self.command_calls.append(args)
            if 'up' in args:
                raise RuntimeError('startup failed')
        with patch.object(deploy, 'command', fail_up):
            with self.assertRaisesRegex(RuntimeError, 'startup failed'):
                self.run_deploy()
        self.assertFalse(any(c[:2] == ['docker', 'start'] for c in self.capture_calls))

    def test_success_updates_only_apps_and_preserves_models(self):
        self.run_deploy()
        up = next(c for c in self.command_calls if 'up' in c)
        self.assertIn('--no-deps', up)
        self.assertEqual(up[-3:], list(deploy.APPS))
        self.assertFalse(any('down' in c or '--remove-orphans' in c for c in self.command_calls))

    def test_changed_model_is_reported_after_deployment(self):
        self.after['containers']['free-nvfp4-live']['id'] = 'changed'
        with self.assertRaisesRegex(RuntimeError, 'protected container'):
            self.run_deploy()

    def test_recovery_can_checkpoint_pending_durable_work(self):
        self.before['counts']['studio_active'] = 1
        with patch.object(deploy, 'database_counts', return_value=self.before['counts']):
            deploy.deploy(self.config, self.ours, self.before, recover=True)


if __name__ == '__main__':
    unittest.main()
