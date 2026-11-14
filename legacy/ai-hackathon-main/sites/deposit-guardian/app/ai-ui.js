/* 서버를 통한 실제 AI 호출. API 키와 예시 응답은 브라우저에 포함하지 않는다. */
(function () {
  let health = null, healthPromise;
  const busy = new Set();
  const errors = new Map();
  const views = new Map();
  const titles = {record:'사진에서 어떤 점을 확인해야 할까요?',contract:'특약의 표현과 확인할 질문 정리',compare:'입주·퇴실 사진의 변화 관찰',response:'기록을 바탕으로 확인 요청 문장 작성'};
  const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function signature(data) {let hash=2166136261;const text=JSON.stringify(data);for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(16);}
  function input(route,ctx){
    const area=ctx.areas.find(a=>a.id===ctx.state.area);
    if(route==='record'){const r=ctx.getRecord();return {task:'photo',area:area.name,text:`기록 구분: ${ctx.state.phase==='before'?'입주':'퇴실'}\n사용자가 직접 남긴 메모: ${r.note}`,images:r.image?[r.image]:[]};}
    if(route==='compare'){const before=ctx.getRecord(area.id,'before'),after=ctx.getRecord(area.id,'after');return {task:'compare',area:area.name,text:`입주 메모: ${before.note}\n퇴실 메모: ${after.note}`,images:[before.image,after.image].filter(Boolean)};}
    if(route==='contract')return {task:'contract',area:'계약 특약',text:ctx.state.contract,images:[]};
    return {task:'draft',area:'퇴실 정산',text:ctx.createDraft(),images:[]};
  }
  async function status(){if(!healthPromise)healthPromise=fetch('/api/health',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error();const data=await r.json();if(typeof data.configured!=='boolean')throw Error();health=data;return data;}).catch(()=>{health={configured:false,unavailable:true};healthPromise=null;return health;});return healthPromise;}
  function resultMarkup(value,stale){const {analysis:a,model,createdAt}=value;return `<div class="ai-result" aria-live="polite">${stale?'<div class="review-banner">입력 자료가 변경되었습니다. 아래는 이전 자료의 분석입니다. 현재 자료로 다시 분석해 주세요.</div>':''}<div class="ai-result-head"><span class="tag green">실제 AI 응답</span><small>${escape(model)} · ${escape(new Date(createdAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}))}</small></div><h3>${escape(a.summary)}</h3>${value.task==='photo'?`<div class="ai-photo-tags" aria-label="AI가 제안한 한국어 상태 태그"><h4>AI 상태 태그</h4><div class="tags">${(a.tags||[]).map(tag=>`<span class="tag">#${escape(tag)}</span>`).join('')||'<span class="notice">표시할 상태 태그가 없습니다. 하자가 없음을 보장하지 않습니다.</span>'}</div><p class="notice">사진에서 관찰한 후보입니다. 직접 확인한 상태와 함께 검토해 주세요.</p></div>`:''}${a.observations.map(o=>`<article class="ai-observation"><div><span class="tag">${escape(o.category)}</span><span class="ai-certainty">관찰 명확성: ${escape(o.certainty)}</span></div><h4>${escape(o.location)}</h4><dl><dt>관찰 근거 / 원문</dt><dd>${escape(o.evidence)}</dd><dt>가능한 해석</dt><dd>${escape(o.interpretation)}</dd></dl></article>`).join('')}${a.questions.length?`<h4>추가로 확인할 질문</h4><ul>${a.questions.map(q=>`<li>${escape(q)}</li>`).join('')}</ul>`:''}${a.next_steps.length?`<h4>확인 및 대응 방법</h4><ul>${a.next_steps.map(q=>`<li>${escape(q)}</li>`).join('')}</ul>`:''}${a.draft?`<h4>검토할 문자 초안</h4><p class="draft">${escape(a.draft)}</p>${!stale?'<button id="useAIDraft" class="secondary">대응 화면에 이 초안 가져오기 ↗</button>':''}`:''}<div class="ai-limitations">${a.limitations.map(l=>`<p>ⓘ ${escape(l)}</p>`).join('')}<p>AI 관찰은 오류가 있을 수 있습니다. 법적 책임·통상 마모·반환 금액을 확정하지 않습니다.</p></div></div>`;}
  window.mountAI = function(route,ctx){
    const pill=document.querySelector('#aiStatus');
    if(pill){pill.textContent=health?.configured?'AI 연결 준비됨':'AI 설정 확인';pill.classList.toggle('ready',!!health?.configured);}
    if(!titles[route]){status().then(()=>{if(document.querySelector('#aiStatus'))document.querySelector('#aiStatus').textContent=health.configured?'AI 연결 준비됨':'AI 키 설정 필요';});return;}
    let panel=document.querySelector('#aiPanel');
    if(!panel){panel=document.createElement('section');panel.id='aiPanel';panel.className='panel ai-panel';document.querySelector('#app').appendChild(panel);}
    const photoHost=route==='record'?document.querySelector('#photoAnalysis'):null;
    if(photoHost&&panel.parentNode!==photoHost)photoHost.appendChild(panel);
    ctx.state.ai ||= {};
    const key=route+(route==='record'?'/'+ctx.state.area+'/'+ctx.state.phase:route==='compare'?'/'+ctx.state.area:'');
    function draw(){
      if(!panel.isConnected)return;
      const data=input(route,ctx),current=signature(data),entry=ctx.state.ai[key];
      const expected={photo:1,compare:2,contract:0,draft:0}[data.task];
      const valid=data.images.length===expected&&(expected>0||data.text.trim().length>=10);
      panel.innerHTML=`<div class="section-heading" style="margin-top:0"><div><span class="eyebrow">REAL AI / EVIDENCE FIRST</span><h2 style="margin-top:8px">${titles[route]}</h2></div><span class="tag ${health?.configured?'green':'amber'}">${health?.configured?'AI 서버 설정됨':'설정 필요'}</span></div><p class="muted" style="font-size:12px">${route==='record'?'사진에서 보이는 흔적과 위치, 확인 방법을 함께 정리합니다. 사진이 등록되면 이 버튼으로 분석할 수 있어요.':'관찰한 사실과 가능한 해석을 분리하고, 판단이 어려운 부분은 보류합니다.'}</p>${!health?.configured?`<div class="ai-setup"><b>${health?.hosted?'AI 연결 설정이 필요합니다.':health?.unavailable?'AI 서버를 실행해 주세요.':'서버 API 키가 필요합니다.'}</b><p>${health?.hosted?'화면·사진 기록·리포트는 바로 사용할 수 있습니다. 실제 AI 분석은 사이트 관리자가 서버 비밀 환경변수 OPENAI_API_KEY를 설정한 뒤 이용할 수 있습니다.':'<code>python3 rental-demo/server.py</code> 실행 후 localhost:8001로 접속하고 rental-demo/.env에 OPENAI_API_KEY를 설정하세요.'}</p><button id="retryAIStatus" class="text-button">설정 다시 확인 ↻</button></div>`:''}${!valid?`<p class="review-banner">${expected?'선택한 공간의 실제 '+(expected===2?'입주·퇴실 사진 두 장':'사진 한 장')+'을 먼저 등록해 주세요. 예시 도식은 전송하지 않습니다.':'분석할 내용을 10자 이상 입력해 주세요.'}</p>`:''}<label class="ai-consent"><input id="aiConsent" type="checkbox" ${busy.has(key)?'disabled':''}><span>현재 ${expected?'선택한 사진 '+expected+'장과 해당 공간의 메모':route==='contract'?'입력한 특약 텍스트':'공제 항목·금액과 저장된 입주 메모'}를 OpenAI API에 전송하여 분석하는 데 동의합니다. 식별정보를 가린 뒤 요청해 주세요. API 사용료가 발생할 수 있습니다.</span></label><div class="actions"><button id="runAI" class="primary" ${!valid||busy.has(key)?'disabled':''}>${busy.has(key)?'분석 중입니다… (최대 약 90초)':entry?'현재 자료로 다시 분석 ↻':route==='record'?'AI로 문제 확인하기 ↗':'선택한 자료로 AI 분석 ↗'}</button><span class="notice">동의 후 버튼을 누를 때만 전송합니다.</span></div><div id="aiError" role="alert">${errors.has(key)?`<p class="review-banner">${escape(errors.get(key))}</p>`:''}</div>${entry?resultMarkup(entry.result,entry.signature!==current):`<div class="ai-empty">${route==='record'?(valid?'사진이 준비되었습니다. 전송 동의 후 ‘AI로 문제 확인하기’를 눌러주세요.':'사진을 선택하면 이곳에서 문제 후보와 확인 방법을 살펴볼 수 있습니다.'):'아직 AI 분석을 요청하지 않았습니다.'}</div>`}`;
      const retry=panel.querySelector('#retryAIStatus');if(retry)retry.onclick=()=>{healthPromise=null;status().then(draw);};
      const consent=panel.querySelector('#aiConsent');
      panel.querySelector('#runAI').onclick=async()=>{
        if(busy.has(key))return;
        if(!health?.configured){healthPromise=null;await status();if(!health?.configured){errors.set(key,'현재 분석 서비스의 API 연결이 완료되지 않았습니다. 사진은 기록할 수 있지만 AI 결과를 만들 수 없습니다. 관리자 키 설정 후 ‘설정 다시 확인’을 눌러주세요.');draw();return;}}
        if(!consent.checked){ctx.toast('OpenAI로 전송되는 자료를 확인하고 동의해 주세요.');return;}
        // 분석 직전에 다시 읽어, UI가 열린 후 변경된 내용도 반영한다.
        const submitted=input(route,ctx),fingerprint=signature(submitted);
        if(submitted.images.length!==expected){ctx.toast('분석할 사진을 다시 확인해 주세요.');return;}
        busy.add(key);errors.delete(key);draw();
        const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);
        try{
          const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...submitted,consent:true}),signal:controller.signal});
          let result;try{result=await response.json();}catch{throw Error('AI 서버 응답을 읽지 못했습니다. 서버 주소를 확인해 주세요.');}
          if(!response.ok)throw Error(result.error||'분석에 실패했습니다. 잠시 후 다시 시도해 주세요.');
          ctx.state.ai[key]={signature:fingerprint,result};
          if(window.DepositStore)await window.DepositStore.save(ctx.state);
        }catch(e){errors.set(key,e.name==='AbortError'?'응답 대기 시간이 초과되었습니다. 중복 과금 방지를 위해 자동 재시도하지 않습니다. 잠시 후 확인해 주세요.':e.message);}
        finally{clearTimeout(timer);busy.delete(key);(views.get(key)||draw)();}
      };
      const use=panel.querySelector('#useAIDraft');if(use)use.onclick=()=>{ctx.state.draft=entry.result.analysis.draft;if(window.DepositStore)window.DepositStore.save(ctx.state);if(location.hash==='#response'){ctx.refresh();ctx.toast('AI 초안을 가져왔습니다. 사실관계를 확인하고 수정해 주세요.');}else location.hash='response';};
    }
    views.set(key,draw);draw();status().then(draw);
    // 입력이 바뀌면 AI 패널도 갱신하되 사용자가 읽는 기존 입력창은 유지한다.
    const root=document.querySelector('#app');root.onchange=e=>{if(!panel.contains(e.target))draw();};
  };
})();
