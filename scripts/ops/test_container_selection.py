import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('free_deploy_selection', Path(__file__).with_name('free-deploy.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class ContainerSelectionTests(unittest.TestCase):
    def setUp(self):
        names = ('db', 'nginx', 'ocr_model', 'nuextract_model', 'gliformer_model', 'phoenix', *deploy.APPS)
        self.config = {'name': 'free', 'services': {
            'extraction_model': {'scale': 0},
            'studio': {'environment': {'FREE_DEPLOYMENT_INSTRUCT_URL': 'http://extraction_nvfp4:8000/v1'}},
            'nginx': {'networks': {'humanizer': {}}},
        }, 'volumes': {name: {'name': f'free_{name}'} for name in (
            'postgres-data', 'source-inbox', 'parsing-runs', 'studio-data', 'studio-config', 'studio-claude')}}
        self.live = [self.service(name) for name in names]
        self.live.append({'Name': '/free-nvfp4-live', 'Id': 'nvfp4', 'Image': 'nvfp4-image',
            'State': {'Running': True}, 'Config': {'Labels': {}}})
        def capture(args):
            if args == [deploy.COMPOSE, 'config', '--format', 'json']:
                return json.dumps(self.config).encode()
            if args == [deploy.COMPOSE, 'config', '--hash', '*']:
                return '\n'.join(f'{name} hash' for name in names).encode()
            if args[-2:] == ['rev-parse', 'HEAD']:
                return b'fixture-head'
            if args[-2:] == ['branch', '--show-current']:
                return b'dev'
            return b''
        for p in (
            patch.object(deploy, 'capture', capture),
            patch.object(deploy, 'containers', lambda: self.live),
            patch.object(deploy, 'source_digest', return_value='source'),
            patch.object(deploy, 'database_counts', return_value={'studio_active': 0, 'parsing_active': 0}),
            patch.object(deploy.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')),
            patch.dict(os.environ, {'USER': 'fixture'}),
        ):
            p.start()
            self.addCleanup(p.stop)

    @staticmethod
    def service(name, number='1', running=True):
        return {'Name': f'/free-{name}-{number}', 'Id': f'{name}-{number}', 'Image': 'image',
            'State': {'Running': running, 'Health': {'Status': 'healthy'}}, 'Config': {'Labels': {
                'com.docker.compose.project': 'free', 'com.docker.compose.service': name,
                'com.docker.compose.oneoff': 'False', 'com.docker.compose.container-number': number,
                'com.docker.compose.config-hash': 'hash',
            }}}

    def test_experiments_with_inherited_image_labels_are_not_service_duplicates(self):
        for running in (False, True):
            with self.subTest(running=running):
                experiment = self.service('parsing_service')
                experiment['Name'] = '/free-ablation-fixture'
                experiment['State']['Running'] = running
                experiment['Config']['Labels'] = {
                    'com.docker.compose.project': 'free', 'com.docker.compose.service': 'parsing_service',
                }
                self.live.append(experiment)
                try:
                    _, ours, _ = deploy.preflight()
                    self.assertEqual(ours['parsing_service']['Name'], '/free-parsing_service-1')
                finally:
                    self.live.pop()

    def test_real_compose_duplicates_are_refused_even_if_one_is_stopped(self):
        for running in (True, False):
            with self.subTest(running=running):
                self.live.append(self.service('parsing_service', number='2', running=running))
                try:
                    with self.assertRaisesRegex(RuntimeError, 'Duplicate parsing_service'):
                        deploy.preflight()
                finally:
                    self.live.pop()

    def test_compose_oneoffs_do_not_count_as_services(self):
        oneoff = self.service('parsing_service', number='2')
        oneoff['Config']['Labels']['com.docker.compose.oneoff'] = 'True'
        self.live.append(oneoff)
        _, ours, _ = deploy.preflight()
        self.assertEqual(ours['parsing_service']['Id'], 'parsing_service-1')

    def test_unexpected_extraction_model_still_refuses_release(self):
        self.live.append(self.service('extraction_model'))
        with self.assertRaisesRegex(RuntimeError, 'unexpected extraction_model'):
            deploy.preflight()


if __name__ == '__main__':
    unittest.main()
