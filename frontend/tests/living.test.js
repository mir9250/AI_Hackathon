import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountLiving } from '../src/living.js';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('living save retries same request, reloads persisted records, and escapes descriptions', async () => {
  const dom = new JSDOM('<main></main>');
  const root = dom.window.document.querySelector('main');
  const oldForm = globalThis.FormData;
  globalThis.FormData = dom.window.FormData;
  const ids = [], rows = [];
  let fail = true;
  const api = async (path, options = {}) => {
    assert.equal(path, '/api/living-records');
    if (options.method === 'POST') {
      ids.push(options.body.get('upload_id'));
      assert.equal(options.body.get('description'), '<script>bad()</script>');
      if (fail) throw new Error('connection failed');
      rows.push({ category: 'mold', description: options.body.get('description'), signed_url: 'https://example.com/photo.png', created_at: '2026-11-14T00:00:00Z' });
      return { photo_id: 'saved' };
    }
    return rows;
  };
  let dispose = mountLiving(root, api, new AbortController().signal);
  try {
    await settle();
    Object.defineProperty(root.querySelector('#living-photo'), 'files', { value: [new dom.window.File(['photo'], 'photo.png', { type: 'image/png' })] });
    root.querySelector('#living-form').reportValidity = () => true;
    root.querySelector('#living-description').value = '<script>bad()</script>';
    await root.querySelector('#save-living').onclick();
    assert.match(root.querySelector('#living-status').textContent, /저장 실패/);
    assert.equal(root.querySelector('#living-description').value, '<script>bad()</script>');
    fail = false;
    await root.querySelector('#save-living').onclick();
    assert.equal(ids[0], ids[1]);
    assert.match(root.querySelector('#living-status').textContent, /저장했습니다/);
    dispose();
    dispose = mountLiving(root, api, new AbortController().signal);
    await settle();
    assert.equal(root.querySelectorAll('#living-list article').length, 1);
    assert.equal(root.querySelector('#living-list script'), null);
    assert.match(root.querySelector('#living-list').textContent, /<script>/);
  } finally { dispose(); dom.window.close(); globalThis.FormData = oldForm; }
});
