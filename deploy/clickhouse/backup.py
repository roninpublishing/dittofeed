#!/usr/bin/env python3
"""Synchronous native ClickHouse backup. No secrets in argv or operator output."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from urllib.parse import urlsplit
import uuid
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
# First stdin line is client XML; remaining stdin is SQL. Both stay out of argv.
CLIENT = '''set -eu
umask 077
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT HUP INT TERM
IFS= read -r config
printf '%s\\n' "$config" > "$d/client.xml"
clickhouse-client --config-file "$d/client.xml" --multiquery
'''


def private_file(path):
    path = Path(path)
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ValueError('Secret files must be regular files with mode 0600 or stricter')
    if info.st_uid != os.geteuid():
        raise ValueError('Secret files must belong to the invoking user')
    return path


def run(command, **kwargs):
    # Never relay captured client/compose stderr: it can contain SQL/credentials.
    return subprocess.run(command, capture_output=True, text=True, timeout=3600, **kwargs)


def sql_string(value):
    return "'" + value.replace('\\', '\\\\').replace("'", "\\'") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', required=True, type=Path)
    parser.add_argument('--spaces-file', required=True, type=Path)
    parser.add_argument('--project-name', default=None)
    parser.add_argument('--compose-file', type=Path, default=ROOT / 'docker-compose.lite.yaml')
    parser.add_argument('--database', default='dittofeed')
    args = parser.parse_args()
    try:
        envfile = private_file(args.env_file)
        spaces_path = private_file(args.spaces_file)
        # Lock is next to private credentials, not a shared world-writable /tmp path.
        with open(str(spaces_path) + '.lock', 'a') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            spaces = json.loads(spaces_path.read_text())
            for key in ('url', 'access_key', 'secret_key'):
                if not isinstance(spaces.get(key), str) or not spaces[key] or any(ord(c) < 32 for c in spaces[key]):
                    raise ValueError('Missing or invalid Spaces configuration')
            url = urlsplit(spaces['url'])
            if (url.scheme != 'https' or not re.fullmatch(r'[a-z0-9-]+\.digitaloceanspaces\.com', url.netloc)
                    or url.query or url.fragment or not re.fullmatch(r'/[a-z0-9][a-z0-9/_.-]*', url.path)):
                raise ValueError('Use a regional HTTPS Spaces endpoint with bucket/prefix path')
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', args.database):
                raise ValueError('Invalid database identifier')
            compose = ['docker', 'compose', '--project-directory', str(ROOT), '--env-file', str(envfile.resolve()), '-f', str(args.compose_file.resolve())]
            if args.project_name:
                compose += ['--project-name', args.project_name]
            resolved = run(compose + ['config', '--format', 'json'])
            if resolved.returncode:
                raise ValueError('Compose configuration failed; check private configuration')
            config = json.loads(resolved.stdout)
            credentials = config['services']['clickhouse-server']['environment']
            user, password = credentials['CLICKHOUSE_USER'], credentials['CLICKHOUSE_PASSWORD']
            if not user or not password or password == 'password':
                raise ValueError('A non-default ClickHouse password is required')
            def xml(value):
                return escape(value).replace('\n', '&#10;').replace('\r', '&#13;')
            client = '<config><user>' + xml(user) + '</user><password>' + xml(password) + '</password></config>\n'
            suffix = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H%M%SZ') + '-' + uuid.uuid4().hex
            destination = spaces['url'].rstrip('/') + '/' + suffix
            query = 'SET log_queries=0;\nBACKUP DATABASE `' + args.database + '` TO S3(' + ', '.join(sql_string(v) for v in (destination, spaces['access_key'], spaces['secret_key'])) + ');\n'
            result = run(compose + ['exec', '-T', 'clickhouse-server', 'sh', '-c', CLIENT], input=client + query)
            confirmed = any(line.split('\t')[-1] == 'BACKUP_CREATED' for line in result.stdout.splitlines())
            if result.returncode or not confirmed:
                raise ValueError('Native backup failed or completion not confirmed; no success recorded')
            print('ClickHouse native backup completed: ' + suffix)
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('ClickHouse backup FAILED: check private configuration, service, permissions and destination; client output suppressed', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
