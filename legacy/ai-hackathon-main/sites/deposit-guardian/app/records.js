/* 저장된 공간 기록과 거주 중 사건을 한 흐름으로 모읍니다. */
(function(){
 const categories=['수리·점검','누수·결로','하자 발견','임대인 협의','비용·정산','기타'];
 const statuses=['기록만','진행 중','완료'];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
 const stamp=v=>Number.isFinite(Date.parse(v))?Date.parse(v):0;
 const date=v=>Number.isFinite(Date.parse(v))?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'medium'}).format(new Date(v)):'날짜 미상';
 function replaceDraft(state,item){if(state.journalDraft&&(state.journalDraft.body||state.journalDraft.title)&&state.journalDraft.editId!==item.id&&!confirm('작성 중인 임시 내용을 닫고 선택한 일지를 열까요?'))return false;state.journalDraft={...item,editId:item.id};return true;}
 let archiveFilter='all',archiveQuery='',journalFilter='전체',journalQuery='';
 function areaName(id,areas){return areas.find(a=>a.id===id)?.name||'집 전체 · 기타';}
 function entries(state,areas){
  const list=[];
  for(const [key,r]of Object.entries(state.records||{})){
   if(!r.savedAt)continue;
   const [area,phase]=key.split('-');
   list.push({id:'record:'+key,type:phase==='after'?'after':'before',title:areaName(area,areas)+' · '+(phase==='after'?'퇴실':'입주'),body:r.note||'사진과 상태를 기록했습니다.',date:r.savedAt,image:r.image||'',tag:r.tag||'확인 필요',area,key,sample:r.sample});
  }
  for(const item of state.journal||[])list.push({id:'journal:'+item.id,type:'journal',title:item.title,body:item.body,date:item.eventDate,tag:item.category,area:item.area,journalId:item.id,status:item.status});
  for(const [key,item]of Object.entries(state.ai||{})){
   const a=item.result?.analysis;if(!a)continue;
   const [route,area,phase]=key.split('/');
   const title=route==='record'?areaName(area,areas)+' · '+(phase==='after'?'퇴실':'입주')+' 사진 분석':route==='compare'?areaName(area,areas)+' · 전후 비교':route==='contract'?'특약 분석':'정산 문장 분석';
   list.push({id:'ai:'+key,type:'ai',title,body:a.summary,date:item.result.createdAt,tag:'AI 참고 결과',area,route,phase});
  }
  return list.sort((a,b)=>stamp(b.date)-stamp(a.date)||a.id.localeCompare(b.id));
 }
 const typeName={before:'입주 기록',after:'퇴실 기록',journal:'생활 일지',ai:'AI 분석'};
 function renderArchive(ctx){
  const root=document.querySelector('#app'),all=entries(ctx.state,ctx.areas),counts=Object.fromEntries(['before','after','journal','ai'].map(t=>[t,all.filter(e=>e.type===t).length]));
  root.innerHTML=`<div class="page-intro"><div class="eyebrow">MY RECORDS / ALL IN ONE PLACE</div><h1>우리 집의 기록을 한눈에.</h1><p>공간별 최신 입주·퇴실 기록과 생활 일지, AI 참고 결과를 모았습니다.</p></div><div class="record-summary">${Object.entries(typeName).map(([t,label])=>`<div><span>${label}</span><strong>${counts[t]}<small>개</small></strong></div>`).join('')}</div><div class="record-toolbar"><div class="record-tabs" aria-label="기록 유형">${[['all','전체'],...Object.entries(typeName)].map(([t,label])=>`<button data-record-type="${t}" class="${archiveFilter===t?'selected':''}" aria-pressed="${archiveFilter===t}">${label}</button>`).join('')}</div><form id="archiveSearch" class="record-search"><input id="archiveKeyword" aria-label="저장된 기록 검색" placeholder="메모·공간·제목 검색" value="${esc(archiveQuery)}"><button class="secondary">검색</button></form></div><div class="section-heading"><p id="archiveCount"></p><div class="actions"><a href="#journal" class="primary">＋ 생활 일지 쓰기</a><button id="archiveExport" class="secondary">전체 리포트 ↓</button></div></div><div id="archiveList" class="archive-grid"></div><p class="notice">공간 기록은 공간별·입주/퇴실별 최신 저장본입니다. 사진을 바꾸기 전의 모든 버전 이력을 제공하는 화면은 아닙니다. AI 결과는 분석 당시 자료를 기준으로 하며 법적 판단이 아닙니다.</p>`;
  function draw(){
   const rows=all.filter(e=>(archiveFilter==='all'||e.type===archiveFilter)&&(`${e.title} ${e.body} ${e.tag}`).toLowerCase().includes(archiveQuery.toLowerCase()));
   root.querySelector('#archiveCount').textContent=`${rows.length}개의 기록 · 최신 날짜순`;
   root.querySelector('#archiveList').innerHTML=rows.length?rows.map(e=>`<article class="archive-card">${e.image?`<div class="archive-photo"><img src="${esc(e.image)}" alt="${esc(e.title)} 저장 사진" loading="lazy"></div>`:`<div class="archive-symbol ${e.type}">${e.type==='journal'?'✎':e.type==='ai'?'✧':'⊞'}<span>${typeName[e.type]}</span></div>`}<div class="archive-body"><div class="archive-top"><span>${typeName[e.type]}${e.sample?' · 예시':''}</span><time>${date(e.date)}</time></div><h3>${esc(e.title)}</h3><p class="archive-excerpt">${esc(e.body)}</p><div class="tags"><span class="tag">${esc(e.tag)}</span>${e.status?`<span class="tag ${e.status==='완료'?'green':'amber'}">${esc(e.status)}</span>`:''}</div><button class="text-button" data-open-record="${esc(e.id)}">${e.type==='journal'?'일지 자세히 보기':'기록 열기'} ↗</button></div></article>`).join(''):'<div class="records-empty"><span>▤</span><h3>아직 이 조건에 맞는 기록이 없어요.</h3><p>사진과 메모를 저장하거나 생활 일지를 남겨보세요.</p><a class="primary" href="#record">공간 기록 남기기 ↗</a></div>';
   root.querySelectorAll('[data-open-record]').forEach(b=>b.onclick=()=>{const e=all.find(x=>x.id===b.dataset.openRecord);if(e.type==='journal'){const item=ctx.state.journal.find(j=>j.id===e.journalId);if(replaceDraft(ctx.state,item))location.hash='journal';}else{if(e.area)ctx.state.area=e.area;if(e.phase)ctx.state.phase=e.phase;if(e.type!=='ai')ctx.state.phase=e.type;location.hash=e.type==='ai'?(e.route||'record'):'record';}});
  }
  root.querySelectorAll('[data-record-type]').forEach(b=>b.onclick=()=>{archiveFilter=b.dataset.recordType;root.querySelectorAll('[data-record-type]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));});draw();});
  root.querySelector('#archiveSearch').onsubmit=e=>{e.preventDefault();archiveQuery=root.querySelector('#archiveKeyword').value.trim();draw();};
  root.querySelector('#archiveExport').onclick=ctx.downloadReport;draw();
 }
 function draft(state){return state.journalDraft||{eventDate:today(),title:'',category:'기타',area:'general',body:'',status:'기록만',editId:''};}
 function renderJournal(ctx){
  const root=document.querySelector('#app');ctx.state.journal||=[];const d=draft(ctx.state);
  root.innerHTML=`<div class="page-intro"><div class="eyebrow">LIVING JOURNAL / BETWEEN MOVE IN & OUT</div><h1>그날의 일을, 잊기 전에.</h1><p>수리 요청, 누수 발견, 임대인과 나눈 협의까지. 입주와 퇴실 사이의 일을 차곡차곡 남겨요.</p></div><div class="journal-layout"><section class="panel journal-editor"><div class="section-heading" style="margin-top:0"><h2>${d.editId?'생활 일지 수정':'새로운 생활 일지'}</h2><button id="newJournal" class="text-button">새 일지 쓰기 ↻</button></div><form id="journalForm"><label class="field" for="journalTitle">무슨 일이 있었나요?</label><input id="journalTitle" maxlength="80" value="${esc(d.title)}" placeholder="예: 욕실 누수 발견 후 임대인에게 연락" required><div class="form-row"><div><label class="field" for="journalDate">발생일 또는 예정일</label><input id="journalDate" type="date" value="${esc(d.eventDate)}" required></div><div><label class="field" for="journalCategory">분류</label><select id="journalCategory">${categories.map(c=>`<option ${c===d.category?'selected':''}>${c}</option>`).join('')}</select></div></div><div class="form-row"><div><label class="field" for="journalArea">관련 공간</label><select id="journalArea"><option value="general">집 전체 · 기타</option>${ctx.areas.map(a=>`<option value="${a.id}" ${d.area===a.id?'selected':''}>${a.name}</option>`).join('')}</select></div><div><label class="field" for="journalStatus">진행 상태</label><select id="journalStatus">${statuses.map(s=>`<option ${s===d.status?'selected':''}>${s}</option>`).join('')}</select></div></div><label class="field" for="journalBody">발견한 상태 · 연락한 내용 · 조치 결과</label><textarea id="journalBody" maxlength="2000" rows="7" placeholder="언제, 어디서, 어떤 일이 있었는지 구체적으로 적어 주세요. 상대방의 주민등록번호 등 불필요한 식별정보는 적지 않아도 됩니다." required>${esc(d.body)}</textarea><p class="notice">작성 중인 내용은 임시 보관합니다. ‘일지 저장’을 눌러야 목록과 리포트에 추가됩니다. 발생일은 직접 입력한 날짜이며 작성 시각 인증이 아닙니다.</p><div id="journalMessage" role="status"></div><button id="saveJournal" class="primary journal-save">${d.editId?'수정한 일지 저장 ✓':'일지 저장 ✓'}</button></form></section><section><div class="section-heading" style="margin-top:0"><div><h2>그동안의 이야기</h2><p id="journalCount"></p></div><a class="text-button" href="#archive">전체 기록 보기 ↗</a></div><form id="journalSearch" class="record-search"><input id="journalKeyword" aria-label="생활 일지 검색" placeholder="제목·내용 검색" value="${esc(journalQuery)}"><select id="journalFilter" aria-label="생활 일지 분류"><option>전체</option>${categories.map(c=>`<option ${c===journalFilter?'selected':''}>${c}</option>`).join('')}</select><button class="secondary">검색</button></form><div id="journalTimeline" class="journal-timeline"></div></section></div>`;
  const form=root.querySelector('#journalForm');
  function collect(){return {eventDate:root.querySelector('#journalDate').value,title:root.querySelector('#journalTitle').value,category:root.querySelector('#journalCategory').value,area:root.querySelector('#journalArea').value,body:root.querySelector('#journalBody').value,status:root.querySelector('#journalStatus').value,editId:d.editId||''};}
  form.oninput=form.onchange=()=>{ctx.state.journalDraft=collect();};
  root.querySelector('#newJournal').onclick=()=>{if((ctx.state.journalDraft?.body||ctx.state.journalDraft?.title)&&!confirm('작성 중인 임시 내용을 비우고 새 일지를 쓸까요? 저장된 일지는 유지됩니다.'))return;ctx.state.journalDraft=null;renderJournal(ctx);};
  form.onsubmit=async e=>{
   e.preventDefault();if(!form.reportValidity())return;const value=collect();value.title=value.title.trim();value.body=value.body.trim();
   if(!value.title||!value.body){root.querySelector('#journalMessage').textContent='제목과 내용을 입력해 주세요.';return;}
   if(!value.editId&&ctx.state.journal.length>=100){root.querySelector('#journalMessage').textContent='생활 일지는 최대 100개까지 저장할 수 있습니다.';return;}
   const now=new Date().toISOString(),existing=ctx.state.journal.find(j=>j.id===value.editId),item={id:existing?.id||crypto.randomUUID(),eventDate:value.eventDate,title:value.title,category:value.category,area:value.area,body:value.body,status:value.status,createdAt:existing?.createdAt||now,updatedAt:now};
   if(existing)ctx.state.journal=ctx.state.journal.map(j=>j.id===existing.id?item:j);else ctx.state.journal.push(item);ctx.state.journalDraft=null;
   const button=root.querySelector('#saveJournal');button.disabled=true;
   try{const result=window.DepositStore?await window.DepositStore.save(ctx.state):{local:true,cloud:false};ctx.toast(result.cloud?'일지를 계정에 저장했습니다.':'일지를 이 기기에 저장했습니다. 계정 저장 상태도 확인해 주세요.');renderJournal(ctx);}catch{root.querySelector('#journalMessage').textContent='저장에 실패했습니다. 내용은 현재 화면의 메모리에 남아 있으니 리포트로 보관해 주세요.';button.disabled=false;}
  };
  function draw(){const rows=ctx.state.journal.filter(j=>(journalFilter==='전체'||j.category===journalFilter)&&(`${j.title} ${j.body}`).toLowerCase().includes(journalQuery.toLowerCase())).sort((a,b)=>stamp(b.eventDate)-stamp(a.eventDate)||stamp(b.updatedAt)-stamp(a.updatedAt));root.querySelector('#journalCount').textContent=`${rows.length}개의 일지 · 발생일/예정일 순`;
   root.querySelector('#journalTimeline').innerHTML=rows.length?rows.map(j=>`<article class="journal-entry"><time>${date(j.eventDate)}</time><div class="journal-entry-card"><div class="tags"><span class="tag">${esc(j.category)}</span><span class="tag ${j.status==='완료'?'green':'amber'}">${esc(j.status)}</span></div><h3>${esc(j.title)}</h3><span class="journal-area">${esc(areaName(j.area,ctx.areas))}</span><p>${esc(j.body)}</p><div class="journal-entry-bottom"><small>작성 ${date(j.createdAt)}${j.updatedAt!==j.createdAt?' · 수정 '+date(j.updatedAt):''}</small><button class="text-button" data-edit-journal="${esc(j.id)}">수정 ↗</button></div></div></article>`).join(''):'<div class="records-empty"><span>✎</span><h3>아직 이 조건의 일지가 없어요.</h3><p>집에서 있었던 작은 일부터 남겨보세요.</p></div>';
   root.querySelectorAll('[data-edit-journal]').forEach(b=>b.onclick=()=>{if(!replaceDraft(ctx.state,ctx.state.journal.find(j=>j.id===b.dataset.editJournal)))return;renderJournal(ctx);window.scrollTo({top:0,behavior:'smooth'});});
  }
  root.querySelector('#journalSearch').onsubmit=e=>{e.preventDefault();journalQuery=root.querySelector('#journalKeyword').value.trim();journalFilter=root.querySelector('#journalFilter').value;draw();};draw();
 }
 function reportMarkup(state,areas){return (state.journal||[]).slice().sort((a,b)=>stamp(a.eventDate)-stamp(b.eventDate)).map(j=>`<section><h2>생활 일지 · ${esc(j.title)}</h2><p>발생일/예정일: ${esc(j.eventDate)} · ${esc(j.category)} · ${esc(j.status)}</p><p>공간: ${esc(areaName(j.area,areas))}</p><p style="white-space:pre-wrap">${esc(j.body)}</p><p>작성 기록: ${esc(j.createdAt)} / 수정 기록: ${esc(j.updatedAt)}</p></section>`).join('');}
 window.RecordBook={renderArchive,renderJournal,entries,reportMarkup};
})();
