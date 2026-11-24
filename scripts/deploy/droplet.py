#!/usr/bin/python3
"""Root-owned, forced-command app-only deploy endpoint. Requests arrive on stdin."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time

CONTAINER = 'dittofeed-production-lite-1'
RELEASES = Path('/opt/dittofeed-releases')
RUNTIME = Path('/etc/dittofeed/runtime.env')


def docker(*args, **kwargs):
    result = subprocess.run(['docker', *args], text=True, capture_output=True,
                            timeout=600, **kwargs)
    if result.returncode:
        # Never echo registry credentials, runtime config or application logs.
        raise RuntimeError('Docker operation failed: ' + args[0])
    return result.stdout


def healthy(revision):
    for _ in range(30):
        try:
            result = subprocess.run(['curl', '--silent', '--fail', '--max-time', '4',
                                     'http://127.0.0.1:3000/api/'],
                                    capture_output=True, text=True, timeout=6)
            if result.returncode == 0 and json.loads(result.stdout).get('version') == revision:
                return True
        except (ValueError, subprocess.TimeoutExpired):
            pass
        time.sleep(5)
    return False


def compose(path):
    docker('compose', '-p', 'dittofeed-production', '-f', str(path),
           'up', '-d', '--no-deps', 'lite')


def deploy(request):
    # Probe exercises the restricted SSH identity without Docker mutation.
    if request == {'check': True}:
        print('Dittofeed deploy endpoint ready (no release performed)')
        return
    revision, image = request['revision'], request['image']
    if not re.fullmatch(r'[0-9a-f]{40}', revision) or not re.fullmatch(
        r'ghcr\.io/roninpublishing/dittofeed-lite@sha256:[0-9a-f]{64}', image
    ):
        raise ValueError('Expected full source SHA and Ronin image digest')
    before = RUNTIME.read_bytes()
    env = dict(line.split('=', 1) for line in shlex.split(before.decode(), comments=True) if '=' in line)
    if env.get('BOOTSTRAP') != 'false' or env.get('BOOTSTRAP_EVENTS') != 'false':
        raise ValueError('Existing runtime must keep bootstrap disabled')
    current = json.loads(docker('inspect', CONTAINER))[0]
    previous = Path(current['Config']['Labels']['com.docker.compose.project.config_files'])
    contract = json.loads(previous.read_text())
    if set(contract['services']) != {'lite'}:
        raise ValueError('Expected app-only existing Compose contract')
    # Preserve the actually running image, even if its old tag has moved.
    rollback = json.loads(json.dumps(contract))
    rollback['services']['lite']['image'] = current['Image']
    with tempfile.TemporaryDirectory(prefix='dittofeed-registry-') as auth:
        registry_env = dict(os.environ, DOCKER_CONFIG=auth)
        docker('login', 'ghcr.io', '-u', request['registry_user'], '--password-stdin',
               input=request['registry_token'], env=registry_env)
        docker('pull', image, env=registry_env)
    metadata = json.loads(docker('image', 'inspect', image))[0]
    if metadata['Config']['Labels'].get('org.opencontainers.image.revision') != revision:
        raise ValueError('Image revision does not match requested source')
    # Unique directory also makes repeat deployments of one SHA rollback-safe.
    RELEASES.mkdir(parents=True, exist_ok=True)
    release = Path(tempfile.mkdtemp(prefix=revision + '-', dir=RELEASES))
    rollback_file = release / 'compose.rollback.json'
    rollback_file.write_text(json.dumps(rollback, indent=2) + '\n')
    contract['services']['lite']['image'] = image
    target = release / 'compose.production.json'
    target.write_text(json.dumps(contract, indent=2) + '\n')
    if RUNTIME.read_bytes() != before:
        raise RuntimeError('Runtime config changed during preparation')
    try:
        compose(target)
        if not healthy(revision):
            raise RuntimeError('New image failed health check')
        if RUNTIME.read_bytes() != before:
            raise RuntimeError('Runtime config changed during activation')
    except Exception:
        # Never stop data services; restore the exact previous image and contract.
        try:
            compose(rollback_file)
            old_revision = current['Config']['Labels'].get('org.opencontainers.image.revision')
            if not old_revision or not healthy(old_revision):
                raise RuntimeError('Rollback health check failed')
        except Exception:
            raise RuntimeError('Activation failed; rollback failed, operator required') from None
        raise RuntimeError('Activation failed; previous image restored and healthy') from None
    print(json.dumps({'revision': revision, 'image': image, 'previous_compose': str(previous),
                      'runtime_sha256': hashlib.sha256(before).hexdigest(), 'healthy': True}))


if __name__ == '__main__':
    try:
        import fcntl
        # Local lock protects rollback even if someone bypasses Actions concurrency.
        with open('/run/dittofeed-deploy.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Bounds input; SSH_ORIGINAL_COMMAND is never interpreted.
            deploy(json.loads(sys.stdin.read(16384)))
    except Exception as error:
        # Validation errors can contain supplied strings. Never echo arbitrary input.
        message = str(error) if type(error) is RuntimeError else 'invalid request or endpoint unavailable'
        print('Deployment failed: ' + message, file=sys.stderr)
        sys.exit(1)
