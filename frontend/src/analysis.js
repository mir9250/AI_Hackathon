import { escapeHtml } from './ui.js';

const LABELS = { suspected: '하자 의심', needs_review: '추가 확인 필요', none: '의심 흔적 미발견', change_suspected: '새로운 손상 의심', no_visible_change: '눈에 띄는 변화 없음' };
const ERRORS = {
  AI_DAILY_LIMIT: '오늘 사용할 수 있는 AI 분석 횟수를 모두 사용했어요. 내일 다시 이용해 주세요.',
  AI_CREDIT_REQUIRED: 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
  AI_AUTH_ERROR: 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
  AI_PERMISSION_ERROR: 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
  AI_MODEL_UNAVAILABLE: 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
  AI_TIMEOUT: '분석이 오래 걸려 멈췄어요. 다시 시도해 주세요.',
  AI_STALE: '이전 분석이 중간에 멈췄어요. 다시 시도해 주세요.',
  AI_INVALID_RESPONSE: 'AI 분석 결과를 정리하지 못했어요. 다시 시도해 주세요.',
  AI_IMAGE_FETCH_FAILED: '저장된 사진을 불러오지 못했어요. 다시 시도해 주세요.',
  AI_SETUP_REQUIRED: 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.', AI_NOT_CONFIGURED: 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.', AI_UNAVAILABLE: 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.', AI_RATE_LIMIT: 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.', AI_SERVICE_ERROR: 'AI 기능을 잠시 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
  AI_INCOMPLETE: '분석을 끝내지 못했어요. 다시 시도해 주세요.',
  AI_REFUSED: 'AI가 이 사진을 분석하지 못했어요. 더 선명한 사진으로 다시 시도해 주세요.',
};

export function analysisMarkup(photo, working = false, localError = '', comparison = false) {
  const e = escapeHtml;
  const record = comparison ? photo.comparison : photo.analysis;
  const action = comparison ? '비교' : '분석';
  const attribute = comparison ? 'data-compare' : 'data-analyze';
  const state = record?.status || (comparison ? photo.comparison_status : photo.analysis_status);
  const stale = state === 'analyzing' && (!record?.started_at || Date.now() - Date.parse(record.started_at) >= 180000);
  const inProgress = working || (state === 'analyzing' && !stale);
  const findings = (comparison ? record?.changes : record?.damages) || [];
  const unverified = findings.some(item => item.type === 'location_unverified');
  if (state === 'completed') {
    return `<section class="analysis-result"><h4>${e(unverified ? '촬영 위치가 확인되지 않습니다' : LABELS[record?.overall_result] || '분석 결과')}</h4>
      ${!unverified && record?.overall_result === 'none' ? '<p>사진에서 뚜렷한 의심 흔적을 발견하지 못했습니다.</p>' : !unverified && record?.overall_result === 'no_visible_change' ? '<p>두 사진에서 눈에 띄는 새로운 변화를 발견하지 못했습니다.</p>' : ''}
      ${findings.filter(item => !unverified || item.type === 'location_unverified').map((damage) => `<article class="damage-finding"><h5>${e(damage.type === 'location_unverified' ? '사진과 촬영 위치를 확인해 주세요' : damage.type)}</h5>
        <p>${e(damage.status)}</p><p><strong>${comparison ? '입실 대비 변화' : '관찰 내용'}</strong> ${e(damage.description)}</p><p><strong>권장 조치</strong> ${e(damage.recommendation)}</p></article>`).join('')}
      <p class="hint">AI 참고 정보입니다. 손상 원인이나 법적 책임을 확정하지 않습니다.</p></section>`;
  }
  const error = localError || (state === 'failed' ? ERRORS[record?.error_code] || '분석하지 못했어요. 잠시 후 다시 시도해 주세요.' : '');
  return `<section class="analysis-result"><p role="status" aria-live="polite">${inProgress ? `AI가 사진을 ${action}하고 있습니다…` : stale ? '분석이 오래 멈춰 있어요. 다시 시도해 주세요.' : error ? e(error) : (comparison ? '비교 전' : '미분석')}</p>
    <button type="button" ${attribute}="${e(photo.photo_id)}" ${inProgress ? 'disabled' : ''}>${inProgress ? `${action} 중…` : state === 'failed' || stale ? `AI ${action} 다시 시도` : `AI ${action}하기`}</button></section>`;
}


export function comparisonMarkup(photo, working = false, error = '') {
  return analysisMarkup(photo, working, error, true);
}
