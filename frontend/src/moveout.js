import { confirmPhotoDeletion } from './deletion.js';
import { escapeHtml, koreanTime } from './ui.js';
import { validatePhotoFile } from './photos.js';
import { comparisonMarkup } from './analysis.js';

export function mountMoveOut(root, api, signal) {
  let alive = true, loading = false, uploading = false;
  let entries = [], exits = [], selected = '', file = null, preview = '', uploadId = '';
  let lastLoaded = 0;
  const comparing = new Set(), errors = new Map(), deleting=new Set();
  const e = escapeHtml;
  root.innerHTML = `<section class="card photo-section"><span class="step">퇴실 기록</span><h2>퇴실 사진 등록</h2>
    <p>입실 사진 하나를 선택하고 같은 위치의 퇴실 사진을 등록하세요. 입실 사진당 한 장만 연결할 수 있습니다.</p>
    <div id="exit-entry-list" class="photo-grid"></div>
    <form id="exit-upload-form"><p id="exit-location" class="hint">비교할 입실 사진을 선택해 주세요.</p>
      <label for="exit-file">퇴실 사진 (한 장, 최대 20MiB)</label>
      <input id="exit-file" type="file" accept=".jpg,.jpeg,.png,.heic,.webp">
      <img id="exit-preview" class="exit-preview" hidden alt="선택한 퇴실 사진">
      <p id="exit-upload-message" role="status" aria-live="polite"></p>
      <button id="exit-upload" type="submit" disabled>퇴실 사진 업로드</button></form></section>
    <section class="photo-section"><div class="photo-heading"><h2>입실·퇴실 비교</h2><button id="refresh-exits" class="quiet">다시 조회</button></div>
    <p class="hint">AI 비교 시 두 사진이 OpenAI로 전송되고 API 비용이 발생할 수 있습니다. 결과는 참고 정보이며 원인·책임을 확정하지 않습니다.</p>
    <p id="exit-list-message" role="status" aria-live="polite"></p><div id="exit-pairs"></div></section>`;
  const find = (id) => root.querySelector(`#${id}`);
  const message = (text) => { if (alive) find('exit-upload-message').textContent = text; };
  const linked = () => new Set(exits.map((row) => row.paired_entry_photo_id));
  const ready = () => {
    find('exit-upload').disabled = uploading || loading || !file || !selected || linked().has(selected);
    find('exit-file').disabled = uploading;
  };
  const releasePreview = () => { if (preview) URL.revokeObjectURL(preview); preview = ''; };

  function renderEntries() {
    const used = linked();
    if (used.has(selected)) selected = '';
    find('exit-entry-list').innerHTML = entries.map((entry) => `<label class="photo-card entry-choice">
      <input type="radio" name="exit-entry" value="${e(entry.photo_id)}" ${selected === entry.photo_id ? 'checked' : ''} ${used.has(entry.photo_id) || entry.deleting || uploading ? 'disabled' : ''}>
      ${entry.signed_url?`<img src="${e(entry.signed_url)}" alt="${e(entry.location)} 입실 사진" loading="lazy">`:""}
      <span>${e(entry.location)}</span><span class="hint">${used.has(entry.photo_id) ? '퇴실 사진 등록 완료' : e(koreanTime(entry.created_at))}</span></label>`).join('');
    root.querySelectorAll('[name="exit-entry"]').forEach((radio) => {
      radio.onchange = () => {
        if (uploading || used.has(radio.value)) return;
        selected = radio.value;
        uploadId = crypto.randomUUID();
        const entry = entries.find((row) => row.photo_id === selected);
        find('exit-location').textContent = `촬영 위치: ${entry.location} (입실 위치를 그대로 사용합니다)`;
        message('같은 위치의 퇴실 사진을 선택하고 업로드해 주세요.');
        ready();
      };
    });
    if (!selected) find('exit-location').textContent = '비교할 입실 사진을 선택해 주세요.';
    ready();
  }

  function renderPairs() {
    find('exit-pairs').innerHTML = exits.map((row) => `<article class="card photo-section">
      <h3>${e(row.location)}</h3><p class="hint">퇴실 사진 등록 · ${e(koreanTime(row.created_at))}</p>
      <div class="comparison-pair"><figure><figcaption>입실</figcaption>${row.entry_signed_url?`<img src="${e(row.entry_signed_url)}" alt="${e(row.location)} 입실">`:""}</figure>
      <figure><figcaption>퇴실</figcaption>${row.signed_url?`<img src="${e(row.signed_url)}" alt="${e(row.location)} 퇴실">`:""}</figure></div>
      ${deleting.has(row.photo_id)?'<p>삭제 요청을 확인·처리하고 있습니다…</p>':row.deleting?'<p>삭제 중입니다. 삭제 버튼으로 재시도해 주세요.</p>':comparisonMarkup(row, comparing.has(row.photo_id), errors.get(row.photo_id))}
      <button type="button" class="quiet" data-delete-exit="${e(row.photo_id)}" ${deleting.has(row.photo_id)||comparing.has(row.photo_id)?'disabled':''}>${deleting.has(row.photo_id)?'삭제 처리 중…':row.deleting?'퇴실 사진 삭제 재시도':'퇴실 사진 삭제'}</button></article>`).join('');
    root.querySelectorAll('[data-delete-exit]').forEach(button=>{button.onclick=async()=>{
      const id=button.dataset.deleteExit;
      if(deleting.has(id)||comparing.has(id))return;
      deleting.add(id);renderPairs();
      try{
        if(await confirmPhotoDeletion(api,exits.find(row=>row.photo_id===id),signal))await load();
      }catch(error){if(alive&&error.name!=='AbortError')find('exit-list-message').textContent=error.message;}
      finally{deleting.delete(id);if(alive)renderPairs();}
    };});
    root.querySelectorAll('#exit-pairs img, #exit-entry-list img').forEach((img) => {
      img.onerror = () => { if (alive) find('exit-list-message').textContent = '사진 주소가 만료되었거나 연결에 실패했습니다. 다시 조회해 주세요.'; };
    });
    root.querySelectorAll('[data-compare]').forEach((button) => {
      button.onclick = async () => {
        const id = button.dataset.compare;
        if (comparing.has(id)||deleting.has(id)) return;
        comparing.add(id); errors.delete(id); renderPairs();
        try {
          const result = await api(`/api/move-out/photos/${encodeURIComponent(id)}/compare`, { method:'POST', signal, timeoutMs:180000 });
          if (!alive) return;
          const row = exits.find((item) => item.photo_id === id);
          if (row) { row.comparison = result; row.comparison_status = result.status; }
        } catch (error) {
          if (alive && error.name !== 'AbortError') errors.set(id, error.message);
        } finally {
          comparing.delete(id);
          if (alive) { renderPairs(); await load(); }
        }
      };
    });
  }

  async function load() {
    if (!alive || loading) return;
    loading = true; ready();
    find('exit-list-message').textContent = '입실·퇴실 사진을 불러오고 있습니다…';
    try {
      const values = await Promise.all([api('/api/move-in/photos', { signal }), api('/api/move-out/photos', { signal })]);
      if (!alive) return;
      [entries, exits] = values;
      lastLoaded = Date.now();
      renderEntries(); renderPairs();
      find('exit-list-message').textContent = !entries.length ? '먼저 입실 사진을 등록해 주세요.' : !exits.length ? '아직 등록된 퇴실 사진이 없습니다.' : '저장된 사진과 비교 결과입니다. 주소가 만료되면 다시 조회해 주세요.';
    } catch (error) {
      if (alive && error.name !== 'AbortError') find('exit-list-message').textContent = error.message;
    } finally { loading = false; if (alive) ready(); }
  }

  find('exit-file').onchange = (event) => {
    if (uploading) return;
    releasePreview(); file = null;
    find('exit-preview').hidden = true;
    const chosen = event.target.files[0];
    if (!chosen) { ready(); return; }
    const { mime, error } = validatePhotoFile(chosen);
    if (error) { message(error); ready(); return; }
    file = chosen;
    uploadId = crypto.randomUUID();
    preview = URL.createObjectURL(file);
    find('exit-preview').src = preview;
    find('exit-preview').hidden = false;
    find('exit-preview').onerror = () => { if (alive) find('exit-preview').hidden = true; };
    message(mime === 'image/heic' ? 'HEIC 미지원 브라우저에서는 업로드 후 JPEG 미리보기를 확인하세요.' : '업로드 대기');
    ready();
  };
  find('exit-upload-form').onsubmit = async (event) => {
    event.preventDefault();
    if (uploading || loading || !file || !selected || linked().has(selected)) return;
    uploading = true; ready(); renderEntries();
    message('퇴실 사진 업로드 중…');
    const body = new FormData();
    const { mime } = validatePhotoFile(file);
    body.append('file', file.type ? file : file.slice(0, file.size, mime), file.name);
    body.append('paired_entry_photo_id', selected);
    body.append('upload_id', uploadId);
    try {
      const result = await api('/api/move-out/photos', { method:'POST', body, signal });
      if (!alive) return;
      message(result.already_uploaded ? '기존 업로드를 확인했습니다.' : '퇴실 사진을 저장했습니다. 아래에서 AI 비교를 시작할 수 있습니다.');
      file = null; releasePreview(); find('exit-file').value = ''; find('exit-preview').hidden = true;
    } catch (error) {
      if (alive && error.name !== 'AbortError') message(`업로드 실패: ${error.message} 같은 파일로 재시도할 수 있습니다.`);
    } finally {
      uploading = false;
      if (alive) { await load(); renderEntries(); ready(); }
    }
  };
  find('refresh-exits').onclick = load;
  root.addEventListener('refresh-moveout', load);
  const timer = setInterval(() => {
    if (comparing.size || exits.some((row) => row.comparison_status === 'analyzing') || Date.now() - lastLoaded >= 12 * 60 * 1000) load();
  }, 5000);
  load();
  return () => { alive = false; clearInterval(timer); releasePreview(); root.removeEventListener('refresh-moveout', load); };
}
