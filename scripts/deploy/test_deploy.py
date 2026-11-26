"""Hermetic deployment fixtures. No SSH, registry, app or database is contacted."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent

def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.module = load('droplet')
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.old = self.root / 'old.json'
        self.contract = {'services': {'lite': {'image': 'old:tag', 'env_file': ['/etc/dittofeed/runtime.env'], 'volumes': ['/ca:/ca:ro'], 'ports': ['127.0.0.1:3000:3000'], 'mem_limit': '2g', 'cpus': 2}}, 'networks': {'existing': {'external': True}}}
        self.old.write_text(json.dumps(self.contract))
        self.env = self.root / 'runtime.env'
        self.before = 'BOOTSTRAP="false"\nBOOTSTRAP_EVENTS="false"\nSECRET=unchanged\n'
        self.env.write_text(self.before)
        self.data = self.root / 'clickhouse.data'
        self.data.write_text('unchanged persistent data')
        self.calls = []
        self.revision = 'a' * 40
        self.old_revision = 'c' * 40
        self.request = {'revision': self.revision, 'image': 'ghcr.io/roninpublishing/dittofeed-lite@sha256:' + 'b' * 64, 'registry_user': 'fixture', 'registry_token': 'test-only-token'}
        self.failure = None
        self.image_revision = self.revision
        self.health = [True]
        self.health_revisions = []
        for name, value in [('docker', self.docker), ('healthy', self.healthy), ('RELEASES', self.root / 'releases'), ('RUNTIME', self.env)]:
            p = patch.object(self.module, name, value)
            p.start()
            self.addCleanup(p.stop)

    def docker(self, *args, **kwargs):
        self.calls.append(args)
        if self.failure == args[0]:
            self.failure = None
            raise RuntimeError('Fixture operation failed')
        if args[:2] == ('inspect', self.module.CONTAINER):
            return json.dumps([{'Image': 'sha256:old', 'Config': {'Labels': {'com.docker.compose.project.config_files': str(self.old), 'org.opencontainers.image.revision': self.old_revision}}}])
        if args[:2] == ('image', 'inspect'):
            return json.dumps([{'Config': {'Labels': {'org.opencontainers.image.revision': self.image_revision}}}])
        if args[0] == 'login':
            self.assertEqual(kwargs['input'], 'test-only-token')
            self.assertIn('DOCKER_CONFIG', kwargs['env'])
            self.assertNotIn('test-only-token', args)
        return ''

    def healthy(self, revision):
        self.health_revisions.append(revision)
        return self.health.pop(0)

    def deploy(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.module.deploy(self.request)

    def assert_preserved(self):
        self.assertEqual(self.env.read_text(), self.before)
        self.assertEqual(self.data.read_text(), 'unchanged persistent data')
        self.assertEqual(json.loads(self.old.read_text()), self.contract)
        self.assertFalse(any('down' in c or 'prune' in c or 'clickhouse' in c for c in self.calls))
        for c in self.calls:
            if c[0] == 'compose':
                self.assertEqual(c[-4:], ('up', '-d', '--no-deps', 'lite'))

    def test_success_preserves_data_and_contract(self):
        self.deploy()
        target = next((self.root / 'releases').glob('*/compose.production.json'))
        expected = json.loads(json.dumps(self.contract))
        expected['services']['lite']['image'] = self.request['image']
        self.assertEqual(json.loads(target.read_text()), expected)
        self.assertEqual(self.health_revisions, [self.revision])
        self.assert_preserved()

    def test_health_failure_restores_exact_previous_image(self):
        self.health = [False, True]
        with self.assertRaisesRegex(RuntimeError, 'previous image restored and healthy'):
            self.deploy()
        rollback = next((self.root / 'releases').glob('*/compose.rollback.json'))
        expected = json.loads(json.dumps(self.contract))
        expected['services']['lite']['image'] = 'sha256:old'
        self.assertEqual(json.loads(rollback.read_text()), expected)
        self.assertEqual(self.health_revisions, [self.revision, self.old_revision])
        self.assertEqual(len([c for c in self.calls if c[0] == 'compose']), 2)
        self.assert_preserved()

    def test_compose_failure_also_rolls_back(self):
        self.failure = 'compose'
        with self.assertRaisesRegex(RuntimeError, 'previous image restored and healthy'):
            self.deploy()
        self.assertEqual(self.health_revisions, [self.old_revision])
        self.assert_preserved()

    def test_rollback_failure_is_not_reported_healthy(self):
        self.health = [False, False]
        with self.assertRaisesRegex(RuntimeError, 'rollback failed, operator required'):
            self.deploy()
        self.assert_preserved()

    def test_pull_failure_never_activates(self):
        self.failure = 'pull'
        with self.assertRaises(RuntimeError):
            self.deploy()
        self.assertFalse(any(c[0] == 'compose' for c in self.calls))
        self.assert_preserved()

    def test_revision_mismatch_never_activates(self):
        self.image_revision = self.old_revision
        with self.assertRaises(ValueError):
            self.deploy()
        self.assertFalse(any(c[0] == 'compose' for c in self.calls))
        self.assert_preserved()

    def test_bootstrap_enabled_never_contacts_docker(self):
        self.env.write_text('BOOTSTRAP=true\nBOOTSTRAP_EVENTS=false\n')
        with self.assertRaises(ValueError):
            self.deploy()
        self.assertEqual(self.calls, [])

    def test_untrusted_image_is_rejected(self):
        self.request['image'] = 'other/image:latest; id'
        with self.assertRaises(ValueError):
            self.deploy()
        self.assertEqual(self.calls, [])

    def test_probe_is_read_only(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.module.deploy({'check': True})
        self.assertEqual(self.calls, [])
        self.assert_preserved()

    def test_same_sha_gets_distinct_rollback_files(self):
        self.health = [True, True]
        self.deploy()
        self.deploy()
        self.assertEqual(len(list((self.root / 'releases').glob('*/compose.rollback.json'))), 2)


class HealthTests(unittest.TestCase):
    def test_health_requires_exact_revision(self):
        m = load('droplet')
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{"version":"wrong"}')), patch.object(m.time, 'sleep'):
            self.assertFalse(m.healthy('expected'))
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '{"version":"expected"}')):
            self.assertTrue(m.healthy('expected'))

    def test_curl_error_and_invalid_json_fail_health(self):
        m = load('droplet')
        for rc, body in [(1, ''), (0, 'not json')]:
            with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], rc, body)), patch.object(m.time, 'sleep'):
                self.assertFalse(m.healthy('expected'))


class ClientTests(unittest.TestCase):
    def test_pinned_ssh_and_credentials_on_stdin_only(self):
        m = load('client')
        env = {'REVISION': 'a' * 40, 'IMAGE_DIGEST': 'sha256:' + 'b' * 64, 'DEPLOY_SSH_KEY': 'fixture-private-key', 'DEPLOY_KNOWN_HOSTS': 'fixture-pinned-host', 'REGISTRY_USER': 'fixture', 'REGISTRY_TOKEN': 'fixture-registry-token'}
        def run(command, **kwargs):
            self.assertIn('StrictHostKeyChecking=yes', command)
            self.assertIn('HostKeyAlias=159.203.185.52', command)
            key = Path(command[command.index('-i') + 1])
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)
            self.assertEqual(key.read_text(), 'fixture-private-key\n')
            self.assertNotIn('fixture-registry-token', command)
            self.assertEqual(json.loads(kwargs['input'])['registry_token'], 'fixture-registry-token')
        with patch.dict(os.environ, env), patch.object(m.subprocess, 'run', side_effect=run):
            m.main()

    def test_preflight_never_submits_a_release_or_requires_registry_credentials(self):
        m = load('client')
        env = {'DEPLOY_SSH_KEY': 'fixture-private-key', 'DEPLOY_KNOWN_HOSTS': 'fixture-pinned-host'}
        with patch.dict(os.environ, env, clear=True), patch.object(m.subprocess, 'run') as run:
            m.main(['--check'])
        self.assertEqual(json.loads(run.call_args.kwargs['input']), {'check': True})

    def test_preflight_failure_stops_the_command(self):
        m = load('client')
        env = {'DEPLOY_SSH_KEY': 'fixture-private-key', 'DEPLOY_KNOWN_HOSTS': 'fixture-pinned-host'}
        with patch.dict(os.environ, env, clear=True), patch.object(m.subprocess, 'run', side_effect=subprocess.CalledProcessError(255, ['ssh'])):
            with self.assertRaises(subprocess.CalledProcessError):
                m.main(['--check'])


if __name__ == '__main__':
    unittest.main()
