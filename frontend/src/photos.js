import { confirmPhotoDeletion } from './deletion.js';
import { analysisMarkup } from './analysis.js';
import { escapeHtml, koreanTime } from './ui.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic' };

export function validatePhotoFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const mime = MIME[ext];
  const error = !mime || (file.type && file.type !== mime && !(ext === 'heic' && file.type === 'image/heif'))
    ? '지원하지 않는 사진 형식입니다.' : !file.size || file.size > MAX_BYTES ? '사진은 0바이트 초과, 20MiB 이하여야 합니다.' : '';
  return { mime, error };
}

export function mountPhotos(root, api, signal) {
  let alive = true;
  let busy = false;
  let items = [];
  let objects = [];
  let loading = false;
  let savedPhotos = [];
  let lastLoaded = 0;
  const analyzing = new Set();
  const analysisErrors = new Map();
  root.innerHTML = `<section class="card photo-section"><span class="step">입실 기록</span>
    <h2>입실 사진 등록</h2><details class="shoot-guide" open><summary>어디를 어떻게 찍어야 하나요?</summary><ul><li>벽·벽지: 방 전체와 모서리, 얼룩·들뜸·찢어진 부분</li><li>바닥: 방 전체와 긁힘·찍힘·변색된 부분</li><li>천장·창틀: 물자국, 틈새, 결로 흔적</li><li>욕실·주방: 타일, 실리콘, 싱크대 아래와 배관 주변</li><li>문·수납장·옵션: 문틀과 손잡이, 가전 외관과 작동 상태</li></ul><p>장소마다 전체 사진 한 장과 가까이 찍은 사진을 남기세요. 원본과 촬영 날짜를 보관하고, 퇴실 때 같은 위치·각도·조명으로 다시 찍으면 비교하기 좋아요.</p></details><p>사진은 한 번에 최대 10장, 장당 20MiB까지 등록할 수 있습니다. JPG·PNG·HEIC·WEBP를 지원합니다.</p>
    <p class="hint">가상 사진으로 테스트하세요. AI 분석 버튼을 누르면 사진이 외부 OpenAI 서비스로 전송되며 API 사용료가 발생할 수 있습니다.</p>
    <label for="photo-files">사진 선택</label><input id="photo-files" type="file" multiple accept=".jpg,.jpeg,.png,.heic,.webp">
    <p id="photo-message" role="status" aria-live="polite"></p>
    <form id="photo-upload-form"><div id="photo-selection" class="photo-grid"></div>
    <button id="upload-photos" type="submit" disabled>사진 업로드</button></form></section>
    <section class="photo-section"><div class="photo-heading"><h2>저장된 입실 사진</h2>
    <button id="refresh-photos" class="quiet">다시 조회</button></div>
    <p id="photo-list-message" role="status" aria-live="polite"></p><div id="photo-list" class="photo-grid"></div></section>`;
  const find = (id) => root.querySelector(`#${id}`);
  const message = (text) => { if (alive) find('photo-message').textContent = text; };
  const release = () => { objects.forEach((url) => URL.revokeObjectURL(url)); objects = []; };
  const status = (item, text) => {
    item.status = text;
    if (alive) root.querySelector(`[data-status="${item.id}"]`).textContent = text;
  };

  find('photo-files').onchange = (event) => {
    if (busy) return;
    const files = [...event.target.files];
    if (files.length > 10) {
      message('한 번에 최대 10장까지 선택해 주세요.');
      event.target.value = '';
      return;
    }
    release();
    items = files.map((file) => {
      const { mime, error } = validatePhotoFile(file);
      let preview = '';
      if (!error) { preview = URL.createObjectURL(file); objects.push(preview); }
      return { file, mime, error, preview, id: crypto.randomUUID(), done: false };
    });
    find('photo-selection').innerHTML = items.map((item, index) => `<article class="photo-card">
      ${item.preview ? `<img src="${escapeHtml(item.preview)}" alt="선택한 사진 ${index + 1}">` : ''}
      ${item.mime === 'image/heic' ? '<p class="hint">HEIC는 브라우저에 따라 미리보기가 지원되지 않습니다. 업로드 후 JPEG 미리보기를 확인할 수 있습니다.</p>' : ''}
      <p class="photo-filename">${escapeHtml(item.file.name)}</p>
      <label for="location-${item.id}">촬영 위치</label><input id="location-${item.id}" maxlength="80" placeholder="예: 거실 벽" ${item.error ? 'disabled' : ''}>
      <p data-status="${item.id}" role="status">${escapeHtml(item.error || '업로드 대기')}</p></article>`).join('');
    root.querySelectorAll('#photo-selection img').forEach((img) => { img.onerror = () => { img.hidden = true; }; });
    find('upload-photos').disabled = !items.some((item) => !item.error);
    message('사진마다 위치를 입력한 뒤 업로드해 주세요. 실패한 사진은 같은 버튼으로 재시도할 수 있습니다.');
  };

  async function load() {
    if (!alive || loading) return;
    loading = true;
    find('photo-list-message').textContent = '사진을 불러오고 있습니다…';
    try {
      const photos = await api('/api/move-in/photos', { signal });
      if (!alive) return;
      savedPhotos = photos;
      lastLoaded = Date.now();
      renderPhotos();
      find('photo-list-message').textContent = photos.length ? '표시 주소가 만료되면 다시 조회해 주세요.' : '저장된 입실 사진이 없습니다.';
    } catch (error) {
      if (alive && error.name !== 'AbortError') find('photo-list-message').textContent = error.message;
    } finally { loading = false; }
  }

  const deleting=new Set();
  function renderPhotos() {
      find('photo-list').innerHTML = savedPhotos.map((photo) => `<article class="photo-card">
        ${photo.signed_url?`<img src="${escapeHtml(photo.signed_url)}" alt="${escapeHtml(photo.location)} 입실 사진" loading="lazy">`:""}
        <h3>${escapeHtml(photo.location)}</h3><p class="hint">${escapeHtml(koreanTime(photo.created_at))}</p>
        <p class="hint">${escapeHtml(photo.mime_type)} · ${(photo.size_bytes / 1024 / 1024).toFixed(2)}MiB</p>
        ${deleting.has(photo.photo_id)?'<p>삭제 요청을 확인·처리하고 있습니다…</p>':photo.deleting?'<p>삭제 중입니다. 삭제 버튼으로 재시도해 주세요.</p>':analysisMarkup(photo, analyzing.has(photo.photo_id), analysisErrors.get(photo.photo_id))}
        <button type="button" class="quiet" data-delete-photo="${escapeHtml(photo.photo_id)}" ${deleting.has(photo.photo_id)||analyzing.has(photo.photo_id)?'disabled':''}>${deleting.has(photo.photo_id)?'삭제 처리 중…':photo.deleting?'사진 삭제 재시도':'사진 삭제'}</button></article>`).join('');
      root.querySelectorAll('[data-delete-photo]').forEach(button=>{button.onclick=async()=>{
        const id=button.dataset.deletePhoto;
        if(deleting.has(id)||analyzing.has(id))return;
        deleting.add(id);renderPhotos();
        try{
          const photo=savedPhotos.find(row=>row.photo_id===id);
          if(await confirmPhotoDeletion(api,photo,signal)){
            savedPhotos=savedPhotos.filter(row=>row.photo_id!==id);renderPhotos();
            find('photo-list-message').textContent='사진과 연결된 자료를 삭제했습니다.';
          }
        }catch(error){if(alive&&error.name!=='AbortError')find('photo-list-message').textContent=error.message;}
        finally{deleting.delete(id);if(alive)renderPhotos();}
      };});
      root.querySelectorAll('#photo-list img').forEach((img) => {
        img.onerror = () => {
          if (alive) find('photo-list-message').textContent = '사진 표시 주소가 만료되었거나 연결에 실패했습니다. 다시 조회해 주세요.';
        };
      });
      root.querySelectorAll('[data-analyze]').forEach((button) => {
        button.onclick = async () => {
          const id = button.dataset.analyze;
          if (analyzing.has(id)||deleting.has(id)) return;
          analyzing.add(id);
          analysisErrors.delete(id);
          renderPhotos();
          try {
            const result = await api(`/api/photos/${encodeURIComponent(id)}/analyze`, {
              method: 'POST', signal, timeoutMs: 180000 });
            if (!alive) return;
            const photo = savedPhotos.find((item) => item.photo_id === id);
            if (photo) { photo.analysis = result; photo.analysis_status = result.status; }
          } catch (error) {
            if (alive && error.name !== 'AbortError') analysisErrors.set(id, error.message);
          } finally {
            analyzing.delete(id);
            if (alive) { renderPhotos(); await load(); }
          }
        };
      });
  }

  find('photo-upload-form').onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    find('upload-photos').disabled = true;
    find('photo-files').disabled = true;
    try {
      for (const item of items) {
        if (!alive || signal.aborted) break;
        if (item.error || item.done) continue;
        const location = find(`location-${item.id}`).value.trim();
        if (!location || location.length > 80) { status(item, '촬영 위치를 1~80자로 입력해 주세요.'); continue; }
        status(item, '업로드 중…');
        const body = new FormData();
        body.append('file', item.file.type ? item.file : item.file.slice(0, item.file.size, item.mime), item.file.name);
        body.append('location', location);
        body.append('upload_id', item.id);
        try {
          const result = await api('/api/move-in/photos', { method: 'POST', body, signal });
          if (!alive) break;
          item.done = true;
          status(item, result.already_uploaded ? '저장 완료 (기존 업로드 확인)' : '저장 완료');
          find(`location-${item.id}`).disabled = true;
        } catch (error) {
          if (!alive || error.name === 'AbortError') break;
          status(item, `실패: ${error.message}`);
        }
      }
      if (alive) { message('처리가 끝났습니다. 성공한 사진은 유지되며 실패한 사진만 재시도합니다.'); await load(); }
    } finally {
      busy = false;
      if (alive) {
        find('photo-files').disabled = false;
        find('upload-photos').disabled = !items.some((item) => !item.error && !item.done);
      }
    }
  };
  find('refresh-photos').onclick = load;
  // Refresh expiring URLs while this view remains mounted.
  const timer = setInterval(() => {
    if (analyzing.size || savedPhotos.some((p) => p.analysis_status === 'analyzing') || Date.now() - lastLoaded >= 12 * 60 * 1000) load();
  }, 5000);
  load();
  return () => { alive = false; clearInterval(timer); release(); };
}
