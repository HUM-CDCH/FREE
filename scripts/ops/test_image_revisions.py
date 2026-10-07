import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('free_deploy_images', Path(__file__).with_name('free-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class ImageRevisions(unittest.TestCase):
    def test_compose_uses_the_existing_launcher_revision_calculation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            (root / 'prototypes/parsing_service').mkdir(parents=True)
            (root / 'scripts/build-revisions.json').write_text((Path(__file__).parent.parent / 'build-revisions.json').read_text())
            (root / 'prototypes/parsing_service/code.py').write_text('initial')
            git = ['git', '-C', directory]
            def run(*args):
                return subprocess.check_output([*git, *args], stderr=subprocess.DEVNULL).decode().strip()
            run('init')
            run('add', '.')
            run('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial')
            parsing = run('rev-parse', 'HEAD')
            (root / 'other.txt').write_text('studio')
            run('add', '.')
            run('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'studio')
            studio = run('rev-parse', 'HEAD')
            with patch.object(deploy, 'ROOT', root), patch.object(deploy, 'GIT', tuple(git)):
                env = deploy.compose_environment()
                self.assertEqual(env['FREE_REVISION_STUDIO'], studio)
                self.assertEqual(env['FREE_REVISION_PARSING'], parsing)
                (root / 'untracked.txt').write_text('operator note')
                self.assertEqual(deploy.compose_environment(), env)
                (root / 'prototypes/parsing_service/code.py').write_text('edited')
                dirty = deploy.compose_environment()
                self.assertEqual(dirty['FREE_REVISION_PARSING'], parsing + '-dirty')
                self.assertEqual(dirty['FREE_REVISION_STUDIO'], studio + '-dirty')
        with patch.object(deploy, 'ROOT', Path('/nonexistent')):
            with self.assertRaisesRegex(RuntimeError, 'contexts'):
                deploy.compose_environment()

    def test_only_images_matching_the_reviewed_context_revision_are_accepted(self):
        env = {'FREE_REVISION_STUDIO': 'a' * 40, 'FREE_REVISION_PARSING': 'b' * 40}
        config = {'services': {name: {} for name in deploy.APPS}}
        def capture(args):
            return env['FREE_REVISION_STUDIO' if args[-1] == 'free-studio' else 'FREE_REVISION_PARSING'].encode()
        with patch.object(deploy, 'compose_environment', return_value=env), patch.object(deploy, 'capture', capture):
            deploy.verify_built_images(config)
        for revision in ('unknown', '', 'c' * 40, 'a' * 40 + '-dirty'):
            with self.subTest(revision=revision), patch.object(deploy, 'compose_environment', return_value=env), patch.object(
                    deploy, 'capture', return_value=revision.encode()):
                with self.assertRaisesRegex(RuntimeError, 'image revision'):
                    deploy.verify_built_images(config)

    def test_running_containers_must_also_match_the_source_revision(self):
        env = {'FREE_REVISION_STUDIO': 'a' * 40, 'FREE_REVISION_PARSING': 'b' * 40}
        ours = {name: {'Config': {'Labels': {'org.opencontainers.image.revision': env[
            'FREE_REVISION_STUDIO' if name == 'studio' else 'FREE_REVISION_PARSING']}}} for name in deploy.APPS}
        with patch.object(deploy, 'compose_environment', return_value=env):
            deploy.verify_running_images(ours)
            ours['parsing_worker']['Config']['Labels']['org.opencontainers.image.revision'] = 'unknown'
            with self.assertRaisesRegex(RuntimeError, 'running image revision'):
                deploy.verify_running_images(ours)
