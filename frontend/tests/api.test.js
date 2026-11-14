import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, ApiError } from '../src/api.js';
import { accountMarkup, koreanTime } from '../src/ui.js';

const auth = { getSession: async () => ({ data: { session: { access_token: 'refreshed-token' } } }) };

test('API sends latest session token, expected fields and parses null data', async () => {
  const api = createApi({ baseUrl: 'https://api.example', auth, fetcher: async (url, options) => {
    assert.equal(url, 'https://api.example/api/profile');
    assert.equal(options.headers.Authorization, 'Bearer refreshed-token');
    assert.deepEqual(JSON.parse(options.body), { display_name: '세입자' });
    return Response.json({ data: null });
  } });
  assert.equal(await api('/api/profile', { method: 'PUT', body: { display_name: '세입자' } }), null);
});

test('API does not send data without a session', async () => {
  const api = createApi({ baseUrl: '', auth: { getSession: async () => ({ data: { session: null } }) },
    fetcher: () => assert.fail('must not call network') });
  await assert.rejects(api('/api/house'), (error) => error.status === 401);
});

test('API preserves retryable error and HTTP status', async () => {
  const api = createApi({ baseUrl: '', auth, fetcher: async () => Response.json({
    error: { code: 'DATABASE_BUSY', message: '잠시 후 다시 시도', retryable: true },
  }, { status: 503 }) });
  await assert.rejects(api('/api/house'), (error) => error instanceof ApiError && error.retryable && error.status === 503);
});

test('network and non-JSON responses are distinct safe errors', async () => {
  const api = createApi({ baseUrl: '', auth, fetcher: async () => { throw new TypeError('private network details'); } });
  await assert.rejects(api('/api/profile'), (error) => error.code === 'NETWORK_ERROR' && !error.message.includes('private'));
  const html = createApi({ baseUrl: '', auth, fetcher: async () => new Response('<html>bad gateway') });
  await assert.rejects(html('/api/profile'), (error) => error.code === 'INVALID_RESPONSE');
});

test('user text cannot become executable markup', () => {
  const html = accountMarkup({ display_name: '"><img src=x onerror=alert(1)>', updated_at: '2026-11-14T00:00:00Z' },
    { name: '<script>bad()</script>', address: '" autofocus onfocus="bad()', updated_at: '2026-11-14T00:00:00Z' });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('times are explicitly displayed in Korea time', () => {
  assert.match(koreanTime('2026-11-14T00:00:00Z'), /9:00/);
});
