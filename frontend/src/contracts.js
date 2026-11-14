import { escapeHtml, koreanTime } from './ui.js';
import { contractAnalysisMarkup } from './contract-analysis.js';
import { validatePhotoFile } from './photos.js';

const STATES = {draft:'등록 중',ready:'등록 완료',deleting:'삭제 중'};
const LIMIT = 20 * 1024 * 1024;

export function mountContracts(root, api, signal) {
  let alive=true, busy=false, reading=true, generation=0;
  let selected=null, pending=[], uploadId=crypto.randomUUID(), newMode=false;
  let lastRefresh=Date.now();
  let analyzing=false, consentChecked=false, analysisError='';
  const e=escapeHtml;
  root.innerHTML=`<section class="photo-section"><div class="photo-heading"><h2>계약서 등록·조회</h2>
    <button id="new-contract">새 계약서 등록</button><button id="refresh-contracts" class="quiet">다시 조회</button></div>
    <p>등록 완료한 계약서를 선택하고 외부 AI 전송에 동의하면 계약 조건과 주의할 조항을 분석할 수 있습니다.</p>
    <p id="contract-message" role="status" aria-live="polite"></p><div id="contract-list" class="contract-list"></div></section>
    <section class="card photo-section"><h3 id="contract-heading">새 계약서 등록</h3>
    <label for="contract-source">등록 방식</label><select id="contract-source"><option value="pdf">PDF 1개 (최대 20페이지)</option><option value="images">계약서 사진 (최대 10페이지)</option></select>
    <form id="contract-upload-form"><label for="contract-files">파일 선택 (파일당 최대 20MiB)</label>
      <input id="contract-files" type="file" accept=".pdf"><p class="hint">사진은 업로드 전에 순서를 조정하세요. 저장된 페이지는 교체할 수 없습니다.</p>
      <div id="contract-pending" class="photo-grid"></div><button id="upload-contract" type="submit" disabled>파일 업로드</button></form>
    <label class="confirmation"><input id="confirm-contract-pages" type="checkbox">계약서의 전체 페이지를 빠짐없이 업로드했는지 직접 확인했습니다.</label>
    <p class="hint">시스템은 문서의 실제 전체 페이지가 모두 포함되었음을 자동 보증하지 않습니다.</p>
    <button id="complete-contract" disabled>계약서 등록 완료</button></section>
    <section id="contract-detail" class="photo-section"></section>`;
  const find=(id)=>root.querySelector(`#${id}`);
  const notify=(text)=>{if(alive)find('contract-message').textContent=text;};
  const clearPending=()=>{pending.forEach((item)=>{if(item.preview)URL.revokeObjectURL(item.preview);});pending=[];};
  const state=()=>selected?.upload_status || 'draft';
  const frozen=()=>state()!=='draft';
  const savedNumbers=()=>new Set((selected?.pages || []).map((page)=>page.page_number));
  const isImages=()=>find('contract-source').value==='images';

  function controls() {
    const disabled=busy||reading||analyzing;
    find('new-contract').disabled=disabled;
    find('refresh-contracts').disabled=disabled;
    find('contract-source').disabled=disabled||Boolean(selected);
    find('contract-files').disabled=disabled||frozen();
    find('contract-files').multiple=isImages();
    find('contract-files').accept=isImages()?'.jpg,.jpeg,.png,.heic,.webp':'.pdf';
    find('upload-contract').disabled=disabled||frozen()||!pending.some((item)=>!item.done&&!item.error);
    find('complete-contract').disabled=disabled||!selected||frozen()||pending.some((item)=>!item.done)||!(selected.original_path||selected.pages?.length);
    find('confirm-contract-pages').disabled=disabled||frozen();
    root.querySelectorAll('[data-contract]').forEach((button)=>{button.disabled=disabled;});
    root.querySelectorAll('[data-page-number]').forEach((input)=>{input.disabled=disabled||pending.some((item)=>item.attempted);});
    root.querySelectorAll('[data-move]').forEach((button)=>{button.disabled=disabled||pending.some((item)=>item.attempted);});
  }

  function renderPending() {
    find('contract-pending').innerHTML=pending.map((item,index)=>`<article class="photo-card">
      ${item.preview && isImages()?`<img src="${e(item.preview)}" alt="선택한 계약서 페이지 ${index+1}">`:''}
      ${item.preview && !isImages()?`<a href="${e(item.preview)}" target="_blank" rel="noopener noreferrer">선택 PDF 열기</a>`:''}
      <p class="photo-filename">${e(item.file.name)}</p>
      ${isImages()?`<label>페이지 번호<input data-page-number="${index}" type="number" min="1" max="10" value="${item.page_number}"></label>
        <div class="page-order"><button type="button" class="quiet" data-move="${index}" data-direction="-1">위로</button><button type="button" class="quiet" data-move="${index}" data-direction="1">아래로</button></div>`:''}
      ${item.mime==='image/heic'?'<p class="hint">HEIC는 업로드 후 JPEG 미리보기를 확인할 수 있습니다.</p>':''}
      <p data-contract-status="${index}" role="status">${e(item.status||item.error||'업로드 대기')}</p></article>`).join('');
    root.querySelectorAll('[data-page-number]').forEach((input)=>{input.onchange=()=>{pending[Number(input.dataset.pageNumber)].page_number=Number(input.value);};});
    root.querySelectorAll('[data-move]').forEach((button)=>{button.onclick=()=>{
      if(busy||pending.some((item)=>item.attempted))return;
      const from=Number(button.dataset.move),to=from+Number(button.dataset.direction);
      if(to<0||to>=pending.length)return;
      const numbers=pending.map((item)=>item.page_number);
      [pending[from],pending[to]]=[pending[to],pending[from]];
      pending.forEach((item,index)=>{item.page_number=numbers[index];});
      renderPending();
    };});
    root.querySelectorAll('#contract-pending img').forEach((img)=>{img.onerror=()=>{img.hidden=true;};});
    controls();
  }

  function renderDetail() {
    find('contract-heading').textContent=selected?`계약서 · ${STATES[selected.upload_status]}`:'새 계약서 등록';
    if(!selected){find('contract-detail').innerHTML='';controls();return;}
    find('contract-source').value=selected.source_type;
    find('contract-detail').innerHTML=`<h3>저장된 계약서</h3><button type="button" id="delete-contract" class="quiet" ${busy||analyzing?'disabled':''}>${busy?'삭제/저장 처리 중…':selected.upload_status==='deleting'?'계약서 삭제 재시도':'계약서 삭제'}</button><p>${e(STATES[selected.upload_status])} · ${e(koreanTime(selected.created_at))} · ${e(selected.house.name)}</p>
      <p>${selected.analysis_status==='not_analyzed'?'미분석':`분석 상태: ${e(selected.analysis_status)}`} </p>
      ${selected.upload_status==='ready'?'<p class="notice">등록이 완료되었습니다. 페이지를 추가하거나 파일을 교체할 수 없습니다.</p>':''}
      ${selected.signed_url?`<a class="quiet" href="${e(selected.signed_url)}" target="_blank" rel="noopener noreferrer">PDF 원본 열기 (${selected.page_count}페이지)</a>`:''}
      <div class="photo-grid">${(selected.pages||[]).map((page)=>`<article class="photo-card" id="contract-page-${page.page_number}"><h4>${page.page_number}페이지</h4>
        <img src="${e(page.signed_url)}" alt="계약서 ${page.page_number}페이지" loading="lazy">
        <a href="${e(page.original_signed_url)}" target="_blank" rel="noopener noreferrer">원본 열기</a></article>`).join('')}</div>${contractAnalysisMarkup(selected,{working:analyzing,consent:consentChecked,error:analysisError})}`;
    find('delete-contract').onclick=async()=>{
      if(busy||analyzing||reading||!selected)return;
      if(!window.confirm('이 계약서의 PDF 원본 또는 모든 이미지 페이지·미리보기와 AI 분석 결과를 삭제하시겠습니까? 다른 계약서와 사진은 유지됩니다. 삭제 후 복구할 수 없으며 백업·캐시의 즉시 영구 삭제를 의미하지 않습니다.'))return;
      const id=selected.contract_id;busy=true;controls();renderDetail();
      try{
        await api(`/api/contracts/${encodeURIComponent(id)}`,{method:'DELETE',signal});
        if(!alive)return;
        selected=null;newMode=false;consentChecked=false;analysisError='';generation++;clearPending();renderPending();renderDetail();
        notify('계약서와 관련 자료를 삭제했습니다.');busy=false;await refresh();
      }catch(error){if(alive&&error.name!=='AbortError')notify(error.message);}
      finally{busy=false;if(alive){renderDetail();controls();}}
    };
    const consentBox=find('contract-ai-consent');
    if(consentBox)consentBox.onchange=()=>{
      consentChecked=consentBox.checked;
      find('analyze-contract').disabled=!consentChecked||analyzing;
    };
    const analyzeButton=find('analyze-contract');
    if(analyzeButton)analyzeButton.onclick=async()=>{
      if(analyzing||busy||reading||!selected||selected.upload_status!=='ready')return;
      if(!consentChecked){notify('외부 AI 전송 동의를 체크해 주세요.');return;}
      analyzing=true;analysisError='';renderDetail();controls();
      try{
        const result=await api(`/api/contracts/${encodeURIComponent(selected.contract_id)}/analyze`,{
          method:'POST',body:{consent:true},signal,timeoutMs:180000});
        if(!alive)return;
        selected.analysis=result;selected.analysis_status=result.status;
        notify('저장된 AI 분석 결과입니다. 원본과 경고를 함께 확인하세요.');
      }catch(error){if(alive&&error.name!=='AbortError'){analysisError=error.message;notify(error.message);}}
      finally{analyzing=false;if(alive){renderDetail();await refresh();controls();}}
    };
    root.querySelectorAll('#contract-detail img').forEach((img)=>{img.onerror=()=>notify('표시 주소가 만료되었거나 연결에 실패했습니다. 다시 조회해 주세요.');});
    controls();
  }

  function renderList(rows) {
    find('contract-list').innerHTML=rows.length?rows.map((row)=>`<button type="button" class="quiet contract-item" data-contract="${e(row.contract_id)}">
      ${e(koreanTime(row.created_at))} · ${row.source_type==='pdf'?'PDF':'사진'} · ${row.page_count??row.uploaded_page_count}페이지 · ${e(STATES[row.upload_status])}</button>`).join(''):'<p>등록된 계약서가 없습니다.</p>';
    root.querySelectorAll('[data-contract]').forEach((button)=>{button.onclick=()=>choose(button.dataset.contract);});
    controls();
  }

  async function choose(id) {
    if(busy||analyzing)return;
    const current=++generation;
    reading=true;consentChecked=false;analysisError='';clearPending();renderPending();find('confirm-contract-pages').checked=false;
    try {
      const result=await api(`/api/contracts/${encodeURIComponent(id)}`,{signal});
      if(!alive||current!==generation)return;
      selected=result;newMode=false;renderDetail();notify(result.upload_status==='draft'?'등록 중인 계약서입니다. 저장된 페이지와 누락된 번호를 확인하고 이어서 업로드하세요.':'저장된 계약서를 불러왔습니다.');
    }catch(error){if(alive&&current===generation&&error.name!=='AbortError')notify(error.message);}
    finally{if(alive&&current===generation){reading=false;controls();}}
  }

  async function refresh() {
    const current=generation;
    try {
      const rows=await api('/api/contracts',{signal});
      if(!alive||current!==generation)return;
      lastRefresh=Date.now();renderList(rows);
      if(selected){
        const detail=await api(`/api/contracts/${encodeURIComponent(selected.contract_id)}`,{signal});
        if(!alive||current!==generation)return;
        selected=detail;renderDetail();
      }else if(!newMode&&rows.length){await choose(rows[0].contract_id);}
    }catch(error){if(alive&&current===generation&&error.name!=='AbortError')notify(error.message);}
  }

  find('new-contract').onclick=()=>{
    if(busy||reading||analyzing)return;
    generation++;consentChecked=false;analysisError='';newMode=true;selected=null;uploadId=crypto.randomUUID();clearPending();
    find('contract-files').value='';find('confirm-contract-pages').checked=false;
    renderPending();renderDetail();notify('PDF 또는 사진 방식을 선택하고 파일을 등록해 주세요.');
  };
  find('contract-source').onchange=()=>{
    if(selected)return;
    clearPending();uploadId=crypto.randomUUID();find('contract-files').value='';find('confirm-contract-pages').checked=false;renderPending();controls();
  };
  find('contract-files').onchange=(event)=>{
    if(busy||reading||analyzing||frozen())return;
    const files=[...event.target.files];
    const occupied=savedNumbers();
    if(files.length>(isImages()?10:1)|| (isImages()&&occupied.size+files.length>10)){
      notify(isImages()?'계약서당 최대 10페이지까지 등록할 수 있습니다.':'PDF는 한 개만 선택해 주세요.');event.target.value='';return;
    }
    clearPending();
    const free=Array.from({length:10},(_,index)=>index+1).filter((number)=>!occupied.has(number));
    pending=files.map((file,index)=>{
      const checked=isImages()?validatePhotoFile(file):{mime:'application/pdf',error:!file.name.toLowerCase().endsWith('.pdf')||(file.type&&file.type!=='application/pdf')?'PDF 파일만 선택해 주세요.':!file.size||file.size>LIMIT?'PDF는 0바이트 초과, 20MiB 이하여야 합니다.':''};
      return {file,...checked,page_number:isImages()?free[index]:null,preview:checked.error?'':URL.createObjectURL(file),done:false,attempted:false};
    });
    find('confirm-contract-pages').checked=false;
    renderPending();notify(isImages()?'페이지 번호와 순서를 확인하세요. 업로드가 시작되면 번호·순서는 고정됩니다.':'PDF는 서버에서 암호화·손상·최대 20페이지 여부를 검사합니다.');
  };
  find('contract-upload-form').onsubmit=async(event)=>{
    event.preventDefault();
    if(busy||reading||analyzing||frozen()||!pending.some((item)=>!item.error&&!item.done))return;
    if(isImages()){
      const valid=pending.filter((item)=>!item.error);
      const numbers=valid.map((item)=>item.page_number);
      if(numbers.some((number)=>!Number.isInteger(number)||number<1||number>10)||new Set(numbers).size!==numbers.length||valid.some((item)=>savedNumbers().has(item.page_number)&&!item.attempted)){
        notify('페이지 번호는 1~10이며 중복되거나 이미 저장된 번호를 사용할 수 없습니다.');return;
      }
    }
    busy=true;controls();
    try{
      if(!selected){selected=await api('/api/contracts',{method:'POST',body:{source_type:find('contract-source').value,upload_id:uploadId},signal});newMode=false;}
      if(!alive)return;
      for(let index=0;index<pending.length;index++){
        if(!alive||signal.aborted)break;
        const item=pending[index];if(item.error||item.done)continue;
        item.attempted=true;item.status='업로드 중…';renderPending();
        const body=new FormData();body.append('file',item.file.type?item.file:item.file.slice(0,item.file.size,item.mime),item.file.name);
        if(selected.source_type==='images')body.append('page_number',String(item.page_number));
        try{
          const result=await api(`/api/contracts/${encodeURIComponent(selected.contract_id)}/${selected.source_type==='pdf'?'pdf':'pages'}`,{method:'POST',body,signal});
          if(!alive)break;
          item.done=true;item.status=result.already_uploaded?'저장 완료 (기존 파일 확인)':'저장 완료';
        }catch(error){if(!alive||error.name==='AbortError')break;item.status=`실패: ${error.message}`;}
        renderPending();
      }
      if(alive){notify('파일별 처리가 끝났습니다. 성공한 페이지는 유지됩니다. 전체 페이지를 확인한 뒤 등록을 완료하세요.');await refresh();}
    }catch(error){if(alive&&error.name!=='AbortError')notify(error.message);}
    finally{busy=false;if(alive)controls();}
  };
  find('complete-contract').onclick=async()=>{
    if(busy||reading||analyzing||!selected||frozen())return;
    if(pending.some((item)=>!item.done)){notify('업로드 대기 또는 실패한 파일을 먼저 처리해 주세요.');return;}
    if(!find('confirm-contract-pages').checked){notify('전체 페이지 업로드 여부를 직접 확인한 뒤 체크해 주세요.');return;}
    busy=true;controls();
    try{
      await api(`/api/contracts/${encodeURIComponent(selected.contract_id)}/complete`,{method:'POST',body:{all_pages_confirmed:true},signal});
      if(alive){notify('계약서 등록을 완료했습니다. 외부 전송 동의 후 AI 분석을 시작할 수 있습니다.');await refresh();}
    }catch(error){if(alive&&error.name!=='AbortError')notify(error.message);}
    finally{busy=false;if(alive)controls();}
  };
  find('refresh-contracts').onclick=refresh;
  root.addEventListener('refresh-contracts',refresh);
  const timer=setInterval(()=>{if(!busy&&!reading&&(analyzing||selected?.analysis_status==='analyzing'||Date.now()-lastRefresh>=12*60*1000))refresh();},5000);
  controls();refresh().finally(()=>{if(alive){reading=false;controls();}});
  return()=>{alive=false;generation++;clearInterval(timer);clearPending();root.removeEventListener('refresh-contracts',refresh);};
}
