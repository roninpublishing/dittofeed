"""Focused Step 2 tests; stdlib only, Docker Compose required."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

class ComposeContract(unittest.TestCase):
    def resolve(self, password):
        env = {k: v for k, v in os.environ.items() if not k.startswith('CLICKHOUSE_')}
        if password is not None:
            env['CLICKHOUSE_PASSWORD'] = password
        return subprocess.run(['docker', 'compose', '--env-file', '/dev/null', '-f', str(ROOT / 'docker-compose.lite.yaml'), 'config', '--format', 'json'], env=env, capture_output=True, text=True)

    def test_internal_persistent_pinned_memory_and_matching_app_credentials(self):
        result = self.resolve('disposable-fixture-only-not-a-real-secret')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(result.stdout)
        ch = config['services']['clickhouse-server']
        self.assertFalse(ch.get('ports'), 'ClickHouse must not publish host ports')
        self.assertEqual(ch['image'], 'clickhouse/clickhouse-server:24.12.6.70-alpine')
        self.assertEqual(int(ch['deploy']['resources']['limits']['memory']), 2048 * 1024 * 1024)
        self.assertIn('/var/lib/clickhouse', [v['target'] for v in ch['volumes'] if v['type'] == 'volume'])
        app = config['services']['lite']['environment']
        self.assertEqual(app['CLICKHOUSE_HOST'], 'http://clickhouse-server:8123')
        self.assertEqual(app['CLICKHOUSE_PASSWORD'], ch['environment']['CLICKHOUSE_PASSWORD'])
        self.assertEqual(app['CLICKHOUSE_USER'], 'dittofeed')
        self.assertEqual(set(ch['networks']), set(config['services']['lite']['networks']))

    def test_password_required(self):
        self.assertNotEqual(self.resolve(None).returncode, 0)
        self.assertNotEqual(self.resolve('').returncode, 0)

class BackupContract(unittest.TestCase):
    def run_backup(self, failure=False, mode=0o600, missing=False, status='BACKUP_CREATED'):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            docker = p / 'docker'
            docker.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
if 'config' in sys.argv:
 print(json.dumps({'services': {'clickhouse-server': {'environment': {'CLICKHOUSE_USER': 'dittofeed', 'CLICKHOUSE_PASSWORD': 'fixture-ch-secret'}}}}))
else:
 Path(os.environ['CAPTURE']).write_text(json.dumps({'argv': sys.argv, 'stdin': sys.stdin.read()}))
 if os.environ.get('FAIL') == '1':
  print('sensitive fixture-spaces-secret error', file=sys.stderr)
  sys.exit(42)
 print('fixture-id\\t' + os.environ['STATUS'])
''')
            docker.chmod(0o700)
            secrets = p / 'spaces.json'
            secrets.write_text(json.dumps({'url': 'https://nyc3.digitaloceanspaces.com/fixture-bucket/ch', 'access_key': 'fixture-key', 'secret_key': 'fixture-spaces-secret'} if not missing else {}))
            secrets.chmod(mode)
            envfile = p / '.env'
            envfile.write_text('CLICKHOUSE_PASSWORD=fixture-ch-secret\n')
            envfile.chmod(0o600)
            env = dict(os.environ, PATH=d + ':' + os.environ['PATH'], CAPTURE=str(p / 'capture'), FAIL='1' if failure else '0', STATUS=status)
            result = subprocess.run(['python3', str(ROOT / 'deploy/clickhouse/backup.py'), '--env-file', str(envfile), '--spaces-file', str(secrets)], env=env, text=True, capture_output=True)
            capture = json.loads((p / 'capture').read_text()) if (p / 'capture').exists() else None
            return result, capture

    def test_native_backup_uses_stdin_not_secret_arguments(self):
        result, capture = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        assert capture is not None
        self.assertIn('BACKUP DATABASE', capture['stdin'])
        self.assertIn('TO S3(', capture['stdin'])
        self.assertNotIn('fixture-ch-secret', json.dumps(capture['argv']))
        self.assertNotIn('fixture-spaces-secret', json.dumps(capture['argv']))
        self.assertNotIn('fixture-spaces-secret', result.stdout + result.stderr)

    def test_backup_failure_nonzero_and_redacted(self):
        result, capture = self.run_backup(failure=True)
        self.assertIsNotNone(capture)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('fixture-spaces-secret', result.stdout + result.stderr)
        self.assertNotIn('BACKUP_CREATED', result.stdout)

    def test_unconfirmed_status_cannot_report_success(self):
        result, capture = self.run_backup(status='NOT_BACKUP_CREATED')
        self.assertIsNotNone(capture)
        self.assertNotEqual(result.returncode, 0)

    def test_public_secret_file_rejected_before_exec(self):
        result, capture = self.run_backup(mode=0o644)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(capture)

    def test_missing_spaces_fields_rejected_before_exec(self):
        result, capture = self.run_backup(missing=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(capture)

if __name__ == '__main__':
    unittest.main(verbosity=2)
