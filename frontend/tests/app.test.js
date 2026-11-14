import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountApp } from '../src/app.js';

const env = { VITE_API_BASE_URL: 'https://api.example', VITE_SUPABASE_URL: 'https://test.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'public-test-key' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

async function setup({ signupSession = null, initialSession = null } = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://frontend.example' });
  const old = Object.fromEntries(['window','document','FormData','fetch'].map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, FormData: dom.window.FormData });
  let callback;
  let session = initialSession;
  let savedProfile = null;
  let savedHouse = null;
  const calls = [];
  const userSession = { access_token: 'test-session-token', user: { id: 'user-A' } };
  const auth = {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: (listener) => { callback = listener; queueMicrotask(() => callback('INITIAL_SESSION', session)); },
    signUp: async (credentials) => { calls.push(['signup',credentials]); return { data: { session: signupSession } }; },
    signInWithPassword: async (credentials) => {
      calls.push(['signin',credentials]); session = userSession; callback('SIGNED_IN', session);
      return { data: { session } };
    },
    signOut: async () => { session = null; callback('SIGNED_OUT', null); return {}; },
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${session.access_token}`);
    calls.push([url,options.method]);
    if (url.endsWith('/contracts')) return Response.json({ data: [] });
    if (url.endsWith('/move-in/photos') || url.endsWith('/move-out/photos')) return Response.json({ data: [] });
    const kind = url.endsWith('/profile') ? 'profile' : 'house';
    if (options.method === 'PUT') {
      const value = { ...JSON.parse(options.body), updated_at: '2026-11-14T00:00:00Z' };
      if (kind === 'profile') savedProfile = value; else savedHouse = value;
    }
    return Response.json({ data: kind === 'profile' ? savedProfile : savedHouse });
  };
  mountApp(document.querySelector('#app'), env, (url, key, options) => {
    assert.equal(options.auth.autoRefreshToken,true);
    assert.equal(options.auth.persistSession,true);
    return { auth };
  });
  await settle();
  return { dom, calls, auth, emit: (event, value) => { session = value; callback(event,value); },
    close: () => { dom.window.close(); Object.assign(globalThis,old); } };
}

test('sign in, load null records, save both forms, edit, sign out and sign in again', async () => {
  const app = await setup();
  try {
    document.querySelector('#email').value = 'tenant@example.com';
    document.querySelector('#password').value = 'secret';
    await document.querySelector('#auth-form').onsubmit({ preventDefault(){}, currentTarget: document.querySelector('#auth-form') });
    await settle();
    assert.ok(document.querySelector('#profile-form'));
    assert.match(document.querySelector('#view').textContent,/아직 등록된 프로필/);
    document.querySelector('#display-name').value = '세입자';
    document.querySelector('#house-name').value = '작성 중인 별칭';
    const profileForm = document.querySelector('#profile-form');
    await profileForm.onsubmit({ preventDefault(){}, currentTarget: profileForm });
    assert.equal(document.querySelector('#house-name').value,'작성 중인 별칭');
    document.querySelector('#address').value = '서울시';
    const houseForm = document.querySelector('#house-form');
    await houseForm.onsubmit({ preventDefault(){}, currentTarget: houseForm });
    assert.match(document.querySelector('#view .notice').textContent,/주택 정보가 등록/);
    assert.ok(app.calls.some(([url,method]) => url.endsWith('/api/profile') && method === 'PUT'));
    await document.querySelector('#logout').onclick();
    assert.ok(document.querySelector('#auth-form'));
    await app.auth.signInWithPassword({ email: 'tenant@example.com', password: 'secret' });
    await settle();
    assert.equal(document.querySelector('#display-name').value,'세입자');
    assert.equal(document.querySelector('#address').value,'서울시');
  } finally { app.close(); }
});

test('signup without session displays email confirmation and does not call service data APIs', async () => {
  const app = await setup();
  try {
    document.querySelector('#switch-auth').click();
    document.querySelector('#email').value = 'tenant@example.com';
    document.querySelector('#password').value = 'valid-test-password';
    const form = document.querySelector('#auth-form');
    await form.onsubmit({ preventDefault(){}, currentTarget: form });
    assert.match(document.querySelector('#message').textContent,/이메일 확인이 필요/);
    assert.equal(app.calls.length,1);
    assert.equal(app.calls[0][0],'signup');
    assert.ok(!document.querySelector('#profile-form'));
  } finally { app.close(); }
});

test('restored session loads data and expiry clears private forms', async () => {
  const app = await setup({ initialSession: { access_token: 'restored', user: { id: 'A' } } });
  try {
    assert.ok(document.querySelector('#house-form'));
    app.emit('TOKEN_REFRESHED', { access_token: 'new-token', user: { id: 'A' } });
    const form = document.querySelector('#profile-form');
    document.querySelector('#display-name').value = '갱신 후 저장';
    await form.onsubmit({ preventDefault(){}, currentTarget: form });
    app.emit('SIGNED_OUT',null);
    assert.ok(!document.querySelector('#house-form'));
    assert.ok(document.querySelector('#auth-form'));
  } finally { app.close(); }
});

test('missing configuration displays setup instructions', () => {
  const dom = new JSDOM('<div id="app"></div>');
  const old = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    mountApp(document.querySelector('#app'), {}, () => assert.fail('must not create SDK client'));
    assert.match(document.body.textContent,/연결 설정이 필요/);
  } finally { dom.window.close(); globalThis.document = old; }
});


test('photo navigation requires house and logout clears photo view', async () => {
  const app = await setup({ initialSession: { access_token: 'restored', user: { id: 'A' } } });
  try {
    assert.equal(document.querySelector('#open-photos').disabled, true);
    document.querySelector('#house-name').value = '가상 주택';
    document.querySelector('#address').value = '테스트 주소';
    const form = document.querySelector('#house-form');
    await form.onsubmit({ preventDefault(){}, currentTarget: form });
    assert.equal(document.querySelector('#open-photos').disabled, false);
    document.querySelector('#open-photos').click();
    await settle();
    assert.ok(document.querySelector('#photo-files'));
    assert.match(document.querySelector('#photo-list-message').textContent, /저장된 입실 사진이 없습니다/);
    await app.auth.signOut();
    assert.equal(document.querySelector('#photo-files'), null);
  } finally { app.close(); }
});


test('move-out navigation requires a house and signout clears the paired-photo view', async () => {
  const app = await setup({ initialSession: { access_token: 'restored', user: { id: 'A' } } });
  try {
    assert.equal(document.querySelector('#open-moveout').disabled, true);
    document.querySelector('#house-name').value = '시연 주택';
    document.querySelector('#address').value = '가상 주소';
    const form = document.querySelector('#house-form');
    await form.onsubmit({ preventDefault(){}, currentTarget: form });
    document.querySelector('#open-moveout').click();
    await settle();
    assert.ok(document.querySelector('#exit-file'));
    assert.match(document.querySelector('#exit-list-message').textContent,/먼저 입실 사진/);
    document.querySelector('#open-moveout').click();
    await settle();
    await app.auth.signOut();
    assert.equal(document.querySelector('#exit-file'), null);
  } finally { app.close(); }
});


test('contract menu is gated on house and logout clears contract documents', async () => {
  const app = await setup({ initialSession: { access_token: 'restored', user: { id: 'A' } } });
  try {
    assert.equal(document.querySelector('#open-contracts').disabled,true);
    document.querySelector('#house-name').value='가상 주택';document.querySelector('#address').value='테스트 주소';
    const form=document.querySelector('#house-form');
    await form.onsubmit({preventDefault(){},currentTarget:form});
    document.querySelector('#open-contracts').click();await settle();
    assert.ok(document.querySelector('#contract-files'));
    assert.match(document.querySelector('#contracts-view').textContent,/외부 AI 전송에 동의/);
    await app.auth.signOut();assert.equal(document.querySelector('#contract-files'),null);
  } finally {app.close();}
});
