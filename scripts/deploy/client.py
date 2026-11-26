#!/usr/bin/env python3
"""Send a bounded request over pinned, forced-command SSH; never log credentials."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def main(argv=()):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check SSH access without deploying')
    args = parser.parse_args(argv)
    request = {'check': True}
    if not args.check:
        revision, digest = os.environ['REVISION'], os.environ['IMAGE_DIGEST']
        if not re.fullmatch(r'[0-9a-f]{40}', revision) or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
            raise SystemExit('Invalid revision or registry digest')
        request = {'revision': revision, 'image': 'ghcr.io/roninpublishing/dittofeed-lite@' + digest,
                   'registry_user': os.environ['REGISTRY_USER'], 'registry_token': os.environ['REGISTRY_TOKEN']}
    with tempfile.TemporaryDirectory(prefix='dittofeed-ssh-') as directory:
        key, hosts = Path(directory) / 'key', Path(directory) / 'known_hosts'
        key.write_text(os.environ['DEPLOY_SSH_KEY'].rstrip() + '\n')
        key.chmod(0o600)
        hosts.write_text(os.environ['DEPLOY_KNOWN_HOSTS'].rstrip() + '\n')
        subprocess.run(['ssh', '-T', '-i', str(key), '-o', 'IdentitiesOnly=yes',
                        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20',
                        '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlias=159.203.185.52',
                        '-o', 'UserKnownHostsFile=' + str(hosts),
                        'root@129.212.198.152', 'deploy'],
                       input=json.dumps(request), text=True, check=True, timeout=1800)


if __name__ == '__main__':
    main(sys.argv[1:])
