import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountPreview } from '../src/preview.js';

test('published preview opens dashboard without network or false save success', async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: 'https://preview.example' });
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, FormData: globalThis.FormData };
  Object.assign(globalThis, { FormData: dom.window.FormData, window: dom.window, document: dom.window.document, fetch: () => { throw new Error('Network forbidden'); } });
  try {
    mountPreview(document.querySelector('#app'));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.match(document.querySelector('.preview-banner').textContent, /미리보기/);
    document.querySelector('#mypage').click();
    assert.equal(document.querySelector('#account-view').hidden, false);
    await document.querySelector('#profile-form').onsubmit({ preventDefault() {}, currentTarget: document.querySelector('#profile-form') });
    assert.match(document.querySelector('#message').textContent, /실제 저장/);
    document.querySelector('#open-living').click();
    assert.ok(document.querySelector('#living-form'));
  } finally { dom.window.close(); Object.assign(globalThis, previous); }
});
