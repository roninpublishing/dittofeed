#!/usr/bin/env python3
"""Disposable real-engine qualification. Creates/removes ONLY unique test resources.
Native Disk backup is a local fixture, NOT DigitalOcean Spaces acceptance.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('backup', ROOT / 'deploy/clickhouse/backup.py')
assert spec is not None and spec.loader is not None
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def main():
    project = 'ditto-step2-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix=project) as directory:
        path = Path(directory)
        password = secrets.token_hex(32)
        envfile = path / '.env'
        envfile.write_text('CLICKHOUSE_USER=dittofeed\nCLICKHOUSE_PASSWORD=' + password + '\nCLICKHOUSE_CONTAINER_MEM_LIMIT=2048\n')
        envfile.chmod(0o600)
        xml = path / 'backup.xml'
        xml.write_text('<clickhouse><storage_configuration><disks><step2_backup><type>local</type><path>/var/lib/clickhouse/step2-backups/</path></step2_backup></disks></storage_configuration><backups><allowed_disk>step2_backup</allowed_disk></backups></clickhouse>')
        override = path / 'override.json'
        override.write_text(json.dumps({'services': {'clickhouse-server': {'volumes': [str(xml) + ':/etc/clickhouse-server/config.d/step2-backup.xml:ro']}}, 'networks': {'dittofeed-network-lite': {'name': project, 'internal': True}}}))
        compose = ['docker', 'compose', '--project-name', project, '--env-file', str(envfile), '-f', str(ROOT / 'docker-compose.lite.yaml'), '-f', str(override)]
        def command(argv, **kwargs):
            result = subprocess.run(argv, capture_output=True, text=True, timeout=180, **kwargs)
            if result.returncode:
                raise RuntimeError('fixture command failed: ' + result.stderr.replace(password, '[redacted]'))
            return result.stdout.strip()
        def query(sql, success=True):
            payload = '<config><user>dittofeed</user><password>' + password + '</password></config>\n' + sql + '\n'
            result = subprocess.run(compose + ['exec', '-T', 'clickhouse-server', 'sh', '-c', backup.CLIENT], input=payload, capture_output=True, text=True, timeout=120)
            if success and result.returncode:
                raise RuntimeError('native query failed: ' + result.stderr.replace(password, '[redacted]'))
            return result
        try:
            command(compose + ['up', '-d', '--no-deps', 'clickhouse-server'])
            for _ in range(90):
                ready = query('SELECT 1', success=False)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError('ClickHouse not ready within 90 seconds')
            cid = command(compose + ['ps', '-q', 'clickhouse-server'])
            info = json.loads(command(['docker', 'inspect', cid]))[0]
            assert not any(info['HostConfig']['PortBindings'].values()), 'Host ports published'
            assert info['HostConfig']['Memory'] == 2048 * 1024 * 1024
            assert any(m['Type'] == 'volume' and m['Destination'] == '/var/lib/clickhouse' for m in info['Mounts'])
            print('PASS pinned image startup, 2048 MiB actual cgroup memory, no host-published ports, named volume', flush=True)
            assert command(['docker', 'run', '--rm', '--network', project, '--entrypoint', 'wget', 'clickhouse/clickhouse-server:24.12.6.70-alpine', '-qO-', 'http://clickhouse-server:8123/ping']) == 'Ok.'
            print('PASS internal Docker DNS/HTTP from separate disposable container', flush=True)
            assert query("EXISTS DATABASE dittofeed").stdout.strip() == '0'
            # Same idempotent statement as backend-lib/src/clickhouse.ts createClickhouseDb.
            query('CREATE DATABASE IF NOT EXISTS dittofeed; CREATE DATABASE IF NOT EXISTS dittofeed; CREATE TABLE dittofeed.step2_fixture (id UInt64, value String) ENGINE=MergeTree ORDER BY id; INSERT INTO dittofeed.step2_fixture VALUES (1, \'disposable\');')
            assert query("BACKUP DATABASE dittofeed TO Disk('step2_backup', 'native-fixture')").stdout.strip().endswith('BACKUP_CREATED')
            print('PASS native local Disk backup BACKUP_CREATED (not Spaces)', flush=True)
            failed = query("BACKUP DATABASE dittofeed TO Disk('step2_backup', 'native-fixture')", success=False)
            assert failed.returncode != 0
            print('PASS real duplicate backup fails nonzero', flush=True)
            command(compose + ['restart', 'clickhouse-server'])
            persisted = None
            for _ in range(90):
                persisted = query('SELECT value FROM dittofeed.step2_fixture WHERE id=1', success=False)
                if persisted.returncode == 0:
                    break
                time.sleep(1)
            assert persisted is not None and persisted.returncode == 0 and persisted.stdout.strip() == 'disposable'
            print('PASS restart persistence', flush=True)
            assert query("RESTORE DATABASE dittofeed AS step2_restored FROM Disk('step2_backup', 'native-fixture')").stdout.strip().endswith('RESTORED')
            assert query('SELECT value FROM step2_restored.step2_fixture WHERE id=1').stdout.strip() == 'disposable'
            print('PASS actual native restore and data readback', flush=True)
        finally:
            command(compose + ['down', '--volumes', '--remove-orphans'])
            assert command(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]) == ''
            assert command(['docker', 'volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + project]) == ''
            print('PASS owned fixture containers/volumes/network cleaned: ' + project, flush=True)

if __name__ == '__main__':
    main()
