import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountLegalLibrary } from '../src/legal.js';

const record = {
  id: 'case-test', title: '보증금반환', citation: '대법원 예시 사건',
  verification_level: 'primary_text_checked', source_url: 'https://www.law.go.kr/LSW/precInfoP.do?precSeq=1',
  excerpt: '<img src=x onerror=alert(1)>', source_scope: '발췌', source_quote: '원문 인용',
  original_context: '사건 배경', cautions: ['전문가 검토 전'], source_publisher: '법제처', retrieved_on: '2026-11-15',
};
const wait = () => new Promise(resolve => setTimeout(resolve, 20));

test('legal library searches and opens escaped detail with source warning', async () => {
  const dom = new JSDOM('<main></main>', { url: 'https://test.invalid' });
  const oldDocument = globalThis.document; globalThis.document = dom.window.document;
  const calls = [];
  try {
    const dispose = mountLegalLibrary(document.querySelector('main'), { fetcher: async path => {
      calls.push(path);
      return { ok: true, json: async () => ({ data: path.includes('/cases/') ? record : {
        total: 1, items: [record], catalog_total: 120, primary_count: 119, secondary_count: 1, topics: ['보증금 반환'],
      } }) };
    } });
    assert.equal(calls.length, 0);
    document.querySelector('details').open = true;
    await wait();
    assert.match(document.querySelector('.legal-status').textContent, /전체 120건/);
    assert.equal(document.querySelector('img'), null);
    assert.match(document.querySelector('.legal-excerpt').textContent, /<img/);
    document.querySelector('.legal-case details').open = true;
    await wait();
    assert.match(document.querySelector('blockquote').textContent, /원문 인용/);
    assert.match(document.querySelector('.legal-case').textContent, /전문가 검토 전/);
    document.querySelector('#legal-query').value = '수선';
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await wait();
    assert.ok(calls.some(path => new URL(path, 'https://test.invalid').searchParams.get('q') === '수선'));
    dispose(); assert.equal(document.querySelector('.legal-library'), null);
  } finally { dom.window.close(); globalThis.document = oldDocument; }
});

test('legal library reports failure and allows a new search', async () => {
  const dom = new JSDOM('<main></main>');
  const oldDocument = globalThis.document; globalThis.document = dom.window.document;
  try {
    mountLegalLibrary(document.querySelector('main'), { fetcher: async () => ({ ok: false }) });
    document.querySelector('details').open = true;
    await wait();
    assert.match(document.querySelector('.legal-status').textContent, /다시 검색/);
    assert.equal(document.querySelector('form button').disabled, false);
  } finally { dom.window.close(); globalThis.document = oldDocument; }
});
