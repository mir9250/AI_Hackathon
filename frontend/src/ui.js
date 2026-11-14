export const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g,
  (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function koreanTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(value));
}

export function accountMarkup(profile, house) {
  const e = escapeHtml;
  return `<section class="section-heading"><span class="eyebrow">MY HOME</span>
    <h1>나의 집, 나의 기록</h1><p>프로필과 주택 정보를 먼저 등록해 주세요.</p></section>
    <div class="form-grid">
      <section class="card"><span class="step">01 · 프로필</span><h2>어떻게 불러 드릴까요?</h2>
      <form id="profile-form">
        <label for="display-name">사용자 이름</label>
        <input id="display-name" name="display_name" maxlength="80" required value="${e(profile?.display_name)}" autocomplete="nickname">
        <button type="submit">프로필 저장</button>
        <p class="save-time">${profile ? `최근 저장 · ${e(koreanTime(profile.updated_at))}` : '아직 등록된 프로필이 없습니다.'}</p>
      </form></section>
      <section class="card"><span class="step">02 · 주택 정보</span><h2>어느 집을 지킬까요?</h2>
      <form id="house-form">
        <label for="house-name">주택 별칭</label>
        <input id="house-name" name="name" maxlength="80" required value="${e(house?.name)}" placeholder="예: 나의 첫 자취방">
        <label for="address">주소</label>
        <input id="address" name="address" maxlength="500" required value="${e(house?.address)}" autocomplete="street-address">
        <button type="submit">주택 정보 저장</button>
        <p class="save-time">${house ? `최근 저장 · ${e(koreanTime(house.updated_at))}` : '사용자당 주택 한 곳을 등록할 수 있습니다.'}</p>
      </form></section>
    </div>
    <aside class="notice">${house ? '주택 정보가 등록되었습니다.' : '주택을 등록해야 사진과 계약서 등록을 시작할 수 있습니다.'}
    입실 사진 등록·조회는 아래 버튼에서 시작할 수 있습니다. 입실 사진 AI 분석을 사용할 수 있습니다. 퇴실 메뉴에서 사진 비교를 시작할 수 있습니다. 계약서 등록·조회를 사용할 수 있습니다. 등록 완료한 계약서는 동의 후 AI 분석할 수 있습니다.</aside>`;
}
