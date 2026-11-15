import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { answerHomeCare, mountHomeCare } from '../src/home-care.js';
test('home-care guide routes relevant questions and gives honest fallback', () => {
  assert.match(answerHomeCare('창틀에 결로가 생겨요').title, /결로/);
  assert.match(answerHomeCare('물이 새요').title, /물/);
  assert.match(answerHomeCare('벽지 훼손').title, /벽지/);
  assert.match(answerHomeCare('주식 추천').text, /기본 안내/);
});
test('legal case search lives inside home care and is removed with the guide', () => {
  const dom = new JSDOM('<main></main>');
  const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    const root = document.querySelector('main');
    const dispose = mountHomeCare(root);
    assert.equal(root.querySelectorAll('.legal-library').length, 1);
    assert.equal(root.querySelector('.legal-library').parentElement, root.querySelector('.home-care'));
    assert.match(root.querySelector('.legal-library summary').textContent, /임대차 판례 찾아보기/);
    dispose();
    assert.equal(root.querySelector('.home-care'), null);
  } finally { dom.window.close(); globalThis.document = old; }
});
test('question form and suggestions show safe local guidance', () => {
  const dom = new JSDOM('<main></main>');
  const old = globalThis.document; globalThis.document = dom.window.document;
  try {
    const root = document.querySelector('main'); mountHomeCare(root);
    root.querySelector('.care-suggestions button').click();
    assert.equal(root.querySelector('.care-answer').hidden, false);
    assert.match(root.querySelector('.care-answer').textContent, /곰팡이/);
    root.querySelector('input').value = '<script>alert(1)</script>';
    root.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    assert.equal(root.querySelector('script'), null);
    assert.match(root.textContent, /저장·전송되지/);
  } finally { dom.window.close(); globalThis.document = old; }
});
