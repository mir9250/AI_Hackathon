import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPhotos } from '../src/photos.js';
import { createApi } from '../src/api.js';
import { analysisMarkup } from '../src/analysis.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const photo = { photo_id: 'photo-1', location: '<거실>', created_at: '2026-11-14T00:00:00Z',
  mime_type: 'image/png', size_bytes: 100, signed_url: 'https://storage.example/photo?token=test',
  analysis_status: 'not_analyzed', analysis: null };

async function setup() {
  const dom = new JSDOM('<div id="photos"></div>', { url: 'http://localhost:5173' });
  const names = ['window', 'document', 'FormData'];
  const old = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData });
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  let revoked = 0;
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => { revoked++; };
  let saved = [];
  let failSecond = true;
  const attempts = [];
  let aiCalls = 0;
  let aiFailure = '';
  let aiWait;
  let releaseAI;

  const api = async (path, options = {}) => {
    if (path.endsWith('/analyze')) {
      aiCalls++;
      assert.equal(options.method, 'POST');
      assert.equal(options.timeoutMs, 180000);
      if (aiWait) await aiWait;
      if (aiFailure) {
        saved[0].analysis = { status: 'failed', error_code: 'AI_CREDIT_REQUIRED' };
        saved[0].analysis_status = 'failed';
        throw new Error(aiFailure);
      }
      const result = { status: 'completed', overall_result: 'suspected', damages: [
        { type: '얼룩', status: '의심', description: '<벽 얼룩>', recommendation: '추가 촬영' }] };
      saved[0].analysis = result;
      saved[0].analysis_status = 'completed';
      return result;
    }
    assert.equal(path, '/api/move-in/photos');
    if (options.method === 'POST') {
      assert.ok(options.body instanceof dom.window.FormData);
      const name = options.body.get('file').name;
      attempts.push({ name, id: options.body.get('upload_id'), location: options.body.get('location') });
      if (name === 'second.png' && failSecond) throw new Error('테스트 저장 실패');
      saved.push({ ...photo, photo_id: name, location: options.body.get('location') });
      return { photo_id: name, upload_status: 'stored', already_uploaded: false };
    }
    return saved;
  };
  const root = document.querySelector('#photos');
  const controller = new AbortController();
  let dispose = mountPhotos(root, api, controller.signal);
  await settle();
  return { dom, root, attempts, get aiCalls() { return aiCalls; },
    failAI(text) { aiFailure = text; },
    pauseAI() { aiWait = new Promise((resolve) => { releaseAI = resolve; }); },
    releaseAI() { releaseAI?.(); },
    setFiles(files) {
    Object.defineProperty(root.querySelector('#photo-files'), 'files', { configurable: true, value: files });
    root.querySelector('#photo-files').onchange({ target: root.querySelector('#photo-files') });
  }, retry() { failSecond = false; }, async submit() {
    const form = root.querySelector('#photo-upload-form');
    await form.onsubmit({ preventDefault() {}, currentTarget: form });
  }, async remount() { dispose(); dispose = mountPhotos(root, api, controller.signal); await settle(); },
  close() { dispose(); assert.ok(revoked >= 0); dom.window.close(); Object.assign(globalThis, old);
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; } };
}

test('independent upload, failure retry keeps upload ID, remount queries saved photos', async () => {
  const app = await setup();
  try {
    app.setFiles(['first.png', 'second.png'].map((name) => new app.dom.window.File(['test'], name, { type: 'image/png' })));
    assert.equal(app.root.querySelectorAll('#photo-selection img').length, 2);
    app.root.querySelectorAll('#photo-selection input').forEach((input, i) => { input.value = i ? '침실' : '<거실>'; });
    await app.submit();
    assert.equal(app.attempts.length, 2);
    assert.match(app.root.textContent, /저장 완료/);
    assert.match(app.root.textContent, /실패: 테스트 저장 실패/);
    assert.equal(app.root.querySelectorAll('#photo-list article').length, 1);
    app.retry();
    await app.submit();
    assert.equal(app.attempts.length, 3);
    assert.equal(app.attempts[1].id, app.attempts[2].id);
    assert.equal(app.root.querySelectorAll('#photo-list article').length, 2);
    await app.remount();
    assert.equal(app.root.querySelectorAll('#photo-list article').length, 2);
    assert.match(app.root.textContent, /미분석/);
    assert.equal(app.root.querySelectorAll('거실').length, 0);
  } finally { app.close(); }
});

test('ten-file cap, invalid formats and missing locations block requests', async () => {
  const app = await setup();
  try {
    const file = new app.dom.window.File(['test'], 'room.png', { type: 'image/png' });
    app.setFiles(Array(11).fill(file));
    assert.match(app.root.textContent, /한 번에 최대 10장까지/);
    app.setFiles([new app.dom.window.File(['bad'], 'bad.txt', { type: 'text/plain' })]);
    assert.equal(app.root.querySelector('#upload-photos').disabled, true);
    app.setFiles([file]);
    await app.submit();
    assert.equal(app.attempts.length, 0);
    assert.match(app.root.textContent, /촬영 위치를 1~80자/);
  } finally { app.close(); }
});

test('oversize selection is rejected and HEIC explains server preview', async () => {
  const app = await setup();
  try {
    const large = new app.dom.window.File(['a'], 'big.png', { type: 'image/png' });
    Object.defineProperty(large, 'size', { value: 20 * 1024 * 1024 + 1 });
    app.setFiles([large]);
    assert.equal(app.root.querySelector('#upload-photos').disabled, true);
    app.setFiles([new app.dom.window.File(['heic'], 'room.heic', { type: 'image/heic' })]);
    assert.match(app.root.textContent, /업로드 후 JPEG 미리보기/);
  } finally { app.close(); }
});

test('API client sends multipart unchanged with JWT and lets browser set boundary', async () => {
  const body = new FormData();
  body.append('location', '거실');
  const api = createApi({ baseUrl: 'https://api.example',
    auth: { getSession: async () => ({ data: { session: { access_token: 'user-jwt' } } }) },
    fetcher: async (url, options) => {
      assert.equal(options.body, body);
      assert.equal(options.headers.Authorization, 'Bearer user-jwt');
      assert.equal(options.headers['Content-Type'], undefined);
      return Response.json({ data: { photo_id: 'test' } });
    } });
  assert.equal((await api('/api/move-in/photos', { method: 'POST', body })).photo_id, 'test');
});


async function uploadOne(app) {
  app.setFiles([new app.dom.window.File(['image'], 'first.png', { type: 'image/png' })]);
  app.root.querySelector('#photo-selection input').value = '거실';
  await app.submit();
}

test('AI button blocks duplicate clicks, renders returned findings and reloads saved result', async () => {
  const app = await setup();
  try {
    await uploadOne(app);
    app.pauseAI();
    const button = app.root.querySelector('[data-analyze]');
    const finished = button.onclick();
    assert.equal(app.root.querySelector('[data-analyze]').disabled, true);
    await button.onclick();
    assert.equal(app.aiCalls, 1);
    assert.match(app.root.textContent, /AI가 사진을 분석/);
    app.releaseAI();
    await finished;
    assert.match(app.root.textContent, /하자 의심/);
    assert.match(app.root.textContent, /<벽 얼룩>/);
    assert.match(app.root.textContent, /권장 조치.*추가 촬영/);
    assert.equal(app.root.querySelector('[data-analyze]'), null);
    assert.equal(app.root.querySelector('벽'), null);
    await app.remount();
    assert.match(app.root.textContent, /하자 의심/);
    assert.equal(app.aiCalls, 1);
  } finally { app.close(); }
});

test('AI failure shows cause and retry control without pretending damage was absent', async () => {
  const app = await setup();
  try {
    await uploadOne(app);
    app.failAI('API 크레딧을 확인해 주세요.');
    await app.root.querySelector('[data-analyze]').onclick();
    assert.match(app.root.textContent, /API 크레딧을 확인/);
    assert.match(app.root.textContent, /AI 분석 다시 시도/);
    assert.doesNotMatch(app.root.textContent, /의심 흔적 미발견/);
    await app.remount();
    assert.match(app.root.textContent, /크레딧/);
  } finally { app.close(); }
});

test('stale analysis can retry; completed none is distinct; pending does not get stuck', () => {
  assert.match(analysisMarkup({ ...photo, analysis: { status: 'analyzing', started_at: '2000-01-01T00:00:00Z' } }), /3분 이상/);
  assert.doesNotMatch(analysisMarkup({ ...photo, analysis: { status: 'analyzing', started_at: '2000-01-01T00:00:00Z' } }), /disabled/);
  assert.doesNotMatch(analysisMarkup({ ...photo, analysis: { status: 'pending' } }), /disabled/);
  const none = analysisMarkup({ ...photo, analysis: { status: 'completed', overall_result: 'none', damages: [] } });
  assert.match(none, /의심 흔적 미발견/);
  assert.doesNotMatch(none, /data-analyze/);
});
