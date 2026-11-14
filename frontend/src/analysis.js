import { escapeHtml } from './ui.js';

const LABELS = { suspected: '하자 의심', needs_review: '추가 확인 필요', none: '의심 흔적 미발견', change_suspected: '새로운 손상 의심', no_visible_change: '눈에 띄는 변화 없음' };
const ERRORS = {
  AI_DAILY_LIMIT: '한국 시간 기준 오늘의 호출 한도에 도달했습니다. 다음 날 다시 이용해 주세요.',
  AI_CREDIT_REQUIRED: 'OpenAI API 크레딧 또는 프로젝트 결제 한도를 확인해 주세요.',
  AI_AUTH_ERROR: '백엔드 OpenAI API 키 설정을 확인해 주세요.',
  AI_PERMISSION_ERROR: 'OpenAI 프로젝트의 모델 사용 권한을 확인해 주세요.',
  AI_MODEL_UNAVAILABLE: '설정된 모델을 사용할 수 없습니다. 모델 설정과 권한을 확인해 주세요.',
  AI_TIMEOUT: '분석 시간이 초과되었습니다. 저장된 사진으로 다시 시도할 수 있습니다.',
  AI_STALE: '이전 분석이 중단되었습니다. 다시 시도할 수 있습니다.',
  AI_INVALID_RESPONSE: 'AI 결과 형식이 올바르지 않아 저장하지 않았습니다.',
  AI_IMAGE_FETCH_FAILED: '저장된 사진을 가져오지 못했습니다.',
  AI_REFUSED: 'AI가 이 사진을 분석하지 못했습니다.',
};

export function analysisMarkup(photo, working = false, localError = '', comparison = false) {
  const e = escapeHtml;
  const record = comparison ? photo.comparison : photo.analysis;
  const action = comparison ? '비교' : '분석';
  const attribute = comparison ? 'data-compare' : 'data-analyze';
  const state = record?.status || (comparison ? photo.comparison_status : photo.analysis_status);
  const stale = state === 'analyzing' && (!record?.started_at || Date.now() - Date.parse(record.started_at) >= 180000);
  const inProgress = working || (state === 'analyzing' && !stale);
  if (state === 'completed') {
    return `<section class="analysis-result"><h4>${e(LABELS[record?.overall_result] || '분석 결과')}</h4>
      ${record?.overall_result === 'none' ? '<p>사진에서 뚜렷한 의심 흔적을 발견하지 못했습니다.</p>' : record?.overall_result === 'no_visible_change' ? '<p>두 사진에서 눈에 띄는 새로운 변화를 발견하지 못했습니다.</p>' : ''}
      ${((comparison ? record?.changes : record?.damages) || []).map((damage) => `<article class="damage-finding"><h5>${e(damage.type)}</h5>
        <p>${e(damage.status)}</p><p><strong>${comparison ? '입실 대비 변화' : '관찰 내용'}</strong> ${e(damage.description)}</p><p><strong>권장 조치</strong> ${e(damage.recommendation)}</p></article>`).join('')}
      <p class="hint">AI 참고 정보입니다. 손상 원인이나 법적 책임을 확정하지 않습니다.</p></section>`;
  }
  const error = localError || (state === 'failed' ? ERRORS[record?.error_code] || '분석에 실패했습니다. 다시 시도하거나 서버 설정을 확인해 주세요.' : '');
  return `<section class="analysis-result"><p role="status" aria-live="polite">${inProgress ? `AI가 사진을 ${action}하고 있습니다…` : stale ? '이전 분석이 3분 이상 정체되었습니다. 다시 시도할 수 있습니다.' : error ? e(error) : (comparison ? '비교 전' : '미분석')}</p>
    <button type="button" ${attribute}="${e(photo.photo_id)}" ${inProgress ? 'disabled' : ''}>${inProgress ? `${action} 중…` : state === 'failed' || stale ? `AI ${action} 다시 시도` : `AI ${action}하기`}</button></section>`;
}


export function comparisonMarkup(photo, working = false, error = '') {
  return analysisMarkup(photo, working, error, true);
}
