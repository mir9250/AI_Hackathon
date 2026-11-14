"""Start real local servers, check HTTP, then stop them. No external API calls.

Run explicitly: .venv/bin/python tests/smoke_local.py
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request


def main():
    root = Path(__file__).resolve().parents[1]
    local_node = root / '.tools/node-v22.16.0-darwin-arm64/bin/node'
    node = shutil.which('node') or (str(local_node) if local_node.exists() else None)
    if node is None:
        raise SystemExit('Node.js 22를 설치한 후 다시 실행하세요.')
    env = {**os.environ, 'SUPABASE_URL': 'https://offline-test.supabase.co',
           'SUPABASE_SECRET_KEY': 'offline-placeholder-not-real',
           'SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_offline_test'}
    commands = [
        ('uvicorn', [sys.executable, '-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '18080'],
         root / 'backend', 'http://127.0.0.1:18080/api/health'),
        ('vite', [node, str(root / 'frontend/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1',
                  '--port', '15173', '--strictPort'], root / 'frontend', 'http://127.0.0.1:15173/'),
    ]
    for label, command, cwd, url in commands:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True)
        try:
            for _ in range(60):
                if process.poll() is not None:
                    raise RuntimeError(process.stdout.read())
                try:
                    with urllib.request.urlopen(url, timeout=1) as response:
                        body = response.read().decode()
                        assert response.status == 200
                        assert ('"status":"ok"' in body if label == 'uvicorn' else '돌려받집' in body)
                        print(f'{label}: HTTP 200, local process smoke test passed')
                        break
                except (OSError, TimeoutError):
                    time.sleep(0.1)
            else:
                raise RuntimeError(f'{label} startup timeout')
        finally:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=5)
            process.stdout.close()
    print('All started processes stopped. No external service requests made.')


if __name__ == '__main__':
    main()
