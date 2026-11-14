import { validatePhotoFile } from './photos.js';
import { escapeHtml, koreanTime } from './ui.js';

export function mountLiving(root, api, signal) {
  let preview = '', uploadId = crypto.randomUUID();
  let alive = true, busy = false, loading = false;
  root.innerHTML = `<section class="card photo-section"><span class="step">거주 중 기록</span><h2>집에 문제가 생겼나요?</h2><p>사진과 발견 상황을 정리하고, 유형별 대처 순서를 확인하세요.</p><p class="hint">사진 AI 판독이 아닌 기본 안내입니다. 기록 저장 버튼을 누르면 사진과 설명이 내 계정에 저장됩니다. 대처 안내는 사진 AI 판독이 아닌 유형별 기본 안내입니다.</p><form id="living-form"><label for="living-type">어떤 문제인가요?</label><select id="living-type"><option value="mold">곰팡이·습기</option><option value="wall">벽지 훼손·들뜸</option><option value="other">기타 손상</option></select><label for="living-photo">문제 부위 사진 (최대 20MiB)</label><input id="living-photo" type="file" accept=".jpg,.jpeg,.png,.webp,.heic" required><img id="living-preview" class="living-preview" alt="문제 부위 미리보기" hidden><label for="living-description">발견한 위치와 상황</label><textarea id="living-description" required maxlength="2000" placeholder="예: 어제 침실 창가 벽지에 검은 얼룩을 발견했어요. 비가 온 뒤 벽이 축축해졌어요."></textarea><button>대처 방법 확인</button><button id="save-living" type="button">사진과 상황 기록 저장</button><p id="living-status" role="status"></p></form><div id="living-result" aria-live="polite"></div></section><section class="photo-section"><div class="photo-heading"><h2>나의 거주 중 기록</h2><button id="refresh-living" class="quiet">다시 조회</button></div><p id="living-list-status" role="status"></p><div id="living-list" class="photo-grid"></div></section>`;
  const find = id => root.querySelector(`#${id}`);
  const release = () => { if (preview) URL.revokeObjectURL(preview); preview = ''; };
  find('living-photo').onchange = () => {
    if (busy) return;
    uploadId = crypto.randomUUID();
    release(); find('living-preview').hidden = true; find('living-result').innerHTML = '';
    const file = find('living-photo').files[0];
    if (!file) return;
    const { error } = validatePhotoFile(file);
    find('living-status').textContent = error;
    if (error) { find('living-photo').value = ''; return; }
    preview = URL.createObjectURL(file);
    find('living-preview').src = preview; find('living-preview').hidden = false;
    find('living-preview').onerror = () => { find('living-preview').hidden = true; find('living-status').textContent = '이 형식은 미리보기가 지원되지 않을 수 있습니다. 원본 사진을 보관하세요.'; };
  };
  find('living-form').onsubmit = event => {
    event.preventDefault();
    const description = find('living-description').value.trim();
    if (!description || !find('living-photo').files.length) { find('living-status').textContent = '사진과 상황 설명을 입력해 주세요.'; return; }
    const type = find('living-type').value;
    const specific = type === 'mold' ? '얼룩 주변의 물자국과 습기가 생기는 시점을 함께 기록하세요. 반복되거나 범위가 넓어지면 원인 확인과 점검을 요청하세요.' : type === 'wall' ? '들뜸·찢김의 범위와 주변 벽 상태를 기록하세요. 기존 입실 사진에서 같은 부위가 보이는지 찾아 함께 보관하세요.' : '문제 부위 전체와 가까운 사진을 함께 남기고, 발견 시점과 변화 과정을 정리하세요.';
    const message = `안녕하세요. 집에서 아래 상황을 발견하여 사진과 함께 공유드립니다.\n${description}\n발생 원인과 점검·조치 방법을 함께 확인 부탁드립니다. 방문 가능 일정도 알려주세요.`;
    find('living-result').innerHTML = `<h3>지금 할 일</h3><ol><li>${specific}</li><li>수리나 상태 변경 전에 원본 사진과 발견 날짜를 보관하세요.</li><li>집주인 또는 관리 담당자에게 상황과 사진을 공유하고 점검 일정·조치 내용을 기록하세요.</li></ol><h3>연락 문구</h3><p style="white-space:pre-wrap">${escapeHtml(message)}</p><p class="hint">사진만으로 발생 원인이나 수리비 부담을 판단할 수 없습니다. 사진과 상황은 기록 저장 버튼으로 보관할 수 있습니다. 연락 문구는 필요한 곳에 복사해 주세요.</p>`;
    find('living-status').textContent = '입력한 유형을 기준으로 안내를 준비했습니다.';
  };
  for (const id of ['living-type', 'living-description']) find(id).oninput = () => {
    if (!busy) uploadId = crypto.randomUUID();
  };
  const labels = { mold: '곰팡이·습기', wall: '벽지 훼손·들뜸', other: '기타 손상' };
  async function load() {
    if (!alive || loading) return;
    loading = true;
    find('living-list-status').textContent = '기록을 불러오고 있습니다…';
    try {
      const records = await api('/api/living-records', { signal });
      if (!alive) return;
      find('living-list').innerHTML = records.map(record => `<article class="photo-card"><img src="${escapeHtml(record.signed_url)}" alt="${escapeHtml(labels[record.category] || '거주 문제')} 사진"><h3>${escapeHtml(labels[record.category] || '거주 문제')}</h3><p class="hint">${escapeHtml(koreanTime(record.created_at))}</p><p style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(record.description)}</p></article>`).join('');
      find('living-list-status').textContent = records.length ? '내 계정에 저장된 기록입니다.' : '아직 저장된 거주 중 기록이 없습니다.';
      root.querySelectorAll('#living-list img').forEach(img => { img.onerror = () => {
        if (alive) find('living-list-status').textContent = '사진 주소가 만료되었거나 연결에 실패했습니다. 다시 조회해 주세요.';
      }; });
    } catch (error) {
      if (alive && error.name !== 'AbortError') find('living-list-status').textContent = `기록 조회 실패: ${error.message}`;
    } finally { loading = false; }
  }
  find('save-living').onclick = async () => {
    if (busy || !find('living-form').reportValidity()) return;
    const description = find('living-description').value.trim();
    if (!description) { find('living-status').textContent = '상황 설명을 입력해 주세요.'; return; }
    const file = find('living-photo').files[0];
    const { mime, error } = validatePhotoFile(file);
    if (error) { find('living-status').textContent = error; return; }
    const body = new FormData();
    body.append('file', file.type ? file : file.slice(0, file.size, mime), file.name);
    body.append('category', find('living-type').value);
    body.append('description', description);
    body.append('upload_id', uploadId);
    busy = true;
    const fields = [...find('living-form').querySelectorAll('input,select,textarea,button')];
    fields.forEach(field => { field.disabled = true; });
    find('living-status').textContent = '사진과 상황을 저장하고 있습니다…';
    try {
      await api('/api/living-records', { method: 'POST', body, signal });
      if (!alive) return;
      find('living-status').textContent = '저장했습니다. 마이페이지의 거주 중 기록에서 다시 볼 수 있어요.';
      find('living-form').reset(); release(); find('living-preview').hidden = true;
      uploadId = crypto.randomUUID();
      await load();
    } catch (error) {
      if (alive && error.name !== 'AbortError') find('living-status').textContent = `저장 실패: ${error.message} 입력은 유지됩니다. 같은 버튼으로 다시 시도하세요.`;
    } finally {
      busy = false;
      if (alive) fields.forEach(field => { field.disabled = false; });
    }
  };
  find('refresh-living').onclick = load;
  root.addEventListener('refresh-living', load);
  load();
  return () => { alive = false; release(); root.removeEventListener('refresh-living', load); };
}
