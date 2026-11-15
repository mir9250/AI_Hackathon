import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisMarkup } from '../src/analysis.js';

for (const comparison of [false, true]) {
  test(`unverified location suppresses clean result: comparison=${comparison}`, () => {
    const record = { status: 'completed', overall_result: comparison ? 'no_visible_change' : 'none',
      [comparison ? 'changes' : 'damages']: [{type: 'location_unverified', status: '확인되지 않습니다',
        description: '<script>bad</script>', recommendation: '전체 사진을 다시 등록해 주세요.'}] };
    const html = analysisMarkup({[comparison ? 'comparison' : 'analysis']: record}, false, '', comparison);
    assert.match(html, /촬영 위치가 확인되지 않습니다/);
    assert.doesNotMatch(html, /의심 흔적 미발견|눈에 띄는 변화 없음|<script>/);
    assert.match(html, /&lt;script&gt;/);
  });
}
