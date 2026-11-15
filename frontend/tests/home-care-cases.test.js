import test from 'node:test';
import assert from 'node:assert/strict';
import { answerHomeCare, HOME_CARE_TOPICS } from '../src/home-care.js';
test('all supported cases have official evidence and conditional responsibility', () => {
  assert.ok(HOME_CARE_TOPICS.length >= 15);
  for (const item of HOME_CARE_TOPICS) {
    const answer = answerHomeCare(item.words[0]);
    assert.equal(answer.id, item.id);
    assert.ok(answer.questions.length && answer.landlord && answer.tenant);
    assert.ok(answer.sources.every(source => new URL(source.url).protocol === 'https:'));
    assert.match(answer.assessment, /산정 불가/);
  }
});
test('mixed and unsupported questions do not fabricate a responsibility percentage', () => {
  const mold = answerHomeCare('집주인이 곰팡이 책임 70퍼센트인가요?');
  assert.equal(mold.id, 'mold');
  assert.match(mold.text, /책임 비율을 정할 수 없습니다/);
  assert.equal(answerHomeCare('주식 추천').assessment, undefined);
});
test('mold guidance changes with facts, keeps ambiguity and rejects denied causes', () => {
  const structural = answerHomeCare('곰팡이가 환기해도 계속 생겨요');
  const usage = answerHomeCare('환기를 안했더니 곰팡이가 생겼어요');
  assert.match(structural.assessment, /건물·설비/);
  assert.match(usage.assessment, /사용·관리/);
  assert.notEqual(structural.caseText, usage.caseText);
  assert.match(answerHomeCare('곰팡이가 생겼고 누수가 없어요').assessment, /원인 확인 필요/);
  assert.match(answerHomeCare('곰팡이 단열 문제가 아니에요').assessment, /원인 확인 필요/);
  assert.match(answerHomeCare('곰팡이 단열 불량이고 환기를 안했어요').assessment, /복합/);
});
test('leak, wall and boiler match specific factual scenarios', () => {
  for (const [building, usage] of [
    ['비가 오면 누수가 생겨요', '수도를 틀어놓아서 누수가 났어요'],
    ['벽지가 햇빛에 변색됐어요', '벽지에 낙서를 했어요'],
    ['노후 보일러가 고장났어요', '보일러를 내가 파손했어요'],
  ]) {
    assert.match(answerHomeCare(building).assessment, /건물·설비/);
    assert.match(answerHomeCare(usage).assessment, /사용·관리/);
    assert.ok(answerHomeCare(building).evidence);
  }
});
