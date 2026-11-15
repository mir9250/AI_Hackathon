// 저장된 실행 방법. 인증값 없이 공개 판례와 기존 읽기 전용 화면 미리보기만 제공한다.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
if (!existsSync('frontend/node_modules/vite')) {
  const install = spawnSync('npm', ['--prefix', 'frontend', 'ci', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status || 1);
}
const children = [
  spawn('uv', ['run', '--no-project', '--with', 'fastapi==0.121.3', '--with', 'uvicorn==0.38.0',
    'uvicorn', 'legal_preview:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', '8787'], { stdio: 'inherit' }),
  spawn('npm', ['--prefix', 'frontend', 'run', 'dev', '--', '--host', '0.0.0.0'], {
    stdio: 'inherit', env: { ...process.env, VITE_UI_PREVIEW: 'true' },
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
