import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountContracts } from '../src/contracts.js';

const settle=()=>new Promise((resolve)=>setTimeout(resolve,10));
const timestamp='2026-11-14T00:00:00Z';

async function setup() {
  const dom=new JSDOM('<div id="contracts"></div>',{url:'http://localhost:5173'});
  const old=Object.fromEntries(['window','document','FormData'].map((name)=>[name,globalThis[name]]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,FormData:dom.window.FormData});
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
  URL.createObjectURL=()=> 'blob:contract';URL.revokeObjectURL=()=>{};
  const contracts=[],calls=[],uploads=[];
  let failPage=0, aiGate=null, aiError=null;
  const api=async(path,options={})=>{
    calls.push([path,options.method||'GET']);
    if(path==='/api/contracts'){
      if(options.method==='POST'){
        const row={contract_id:`contract-${contracts.length+1}`,source_type:options.body.source_type,
          upload_id:options.body.upload_id,upload_status:'draft',page_count:null,uploaded_page_count:0,
          original_path:null,created_at:timestamp,house:{name:'테스트 주택'},analysis:null,analysis_status:'not_analyzed',pages:[],signed_url:null};
        contracts.unshift(row);return {...row};
      }
      return contracts.map((row)=>({...row}));
    }
    const id=path.split('/')[3];
    const row=contracts.find((item)=>item.contract_id===id);
    assert.ok(row,`missing contract ${path}`);
    if(path.endsWith('/analyze')){
      assert.deepEqual(options.body,{consent:true});
      if(aiGate)await aiGate;
      if(aiError){row.analysis={status:'failed',error_code:'AI_CONTRACT_UNREADABLE',warnings:['2페이지를 선명하게 다시 등록하세요.']};throw new Error(aiError);}
      row.analysis={status:'completed',document_quality:'readable',summary:{deposit:10000000,monthly_rent:500000,maintenance_fee:null,contract_period:'2026–2028',special_clauses_summary:'청소비 확인'},
        findings:[{category:'청소비',priority:'medium',title:'청소비 확인',page_number:2,clause_excerpt:'Cleaning fee 100000 KRW',reason:'부담 조건 확인',recommended_action:'금액 확인',evidence_type:'explicit_clause'}],
        checklist:[{title:'보증보험',reason:'가입 여부 미확인',action:'별도 확인'}],warnings:['원본 직접 확인']};
      return row.analysis;
    }
    if(path.endsWith('/complete')){
      assert.deepEqual(options.body,{all_pages_confirmed:true});
      if(row.source_type==='images'){
        const numbers=row.pages.map((page)=>page.page_number).sort((a,b)=>a-b);
        if(numbers.some((number,index)=>number!==index+1))throw new Error('페이지 번호 누락');
        row.page_count=numbers.length;
      }
      row.upload_status='ready';return {...row};
    }
    if(options.method==='POST'){
      assert.ok(options.body instanceof dom.window.FormData);
      const number=Number(options.body.get('page_number'));
      const file=options.body.get('file');
      uploads.push({id,name:file.name,number});
      if(number&&number===failPage)throw new Error('가상 파일 저장 실패');
      if(row.source_type==='pdf'){
        row.page_count=2;row.original_path='private/demo.pdf';row.signed_url='https://storage.example/demo.pdf?token=fake';
      }else{
        if(!row.pages.some((page)=>page.page_number===number))row.pages.push({page_number:number,signed_url:`https://storage.example/${number}.jpg`,original_signed_url:`https://storage.example/original/${number}`});
        row.pages.sort((a,b)=>a.page_number-b.page_number);
      }
      row.uploaded_page_count=row.source_type==='pdf'?row.page_count:row.pages.length;
      return {stored:true,already_uploaded:false};
    }
    return {...row,pages:row.pages.map((page)=>({...page}))};
  };
  const root=document.querySelector('#contracts'),controller=new AbortController();
  let dispose=mountContracts(root,api,controller.signal);
  await settle();
  return {dom,root,contracts,calls,uploads,
    source(value){root.querySelector('#contract-source').value=value;root.querySelector('#contract-source').onchange();},
    files(files){const input=root.querySelector('#contract-files');Object.defineProperty(input,'files',{configurable:true,value:files});input.onchange({target:input});},
    async upload(){const form=root.querySelector('#contract-upload-form');await form.onsubmit({preventDefault(){},currentTarget:form});},
    fail(number){failPage=number;},
    ai(gate,error=null){aiGate=gate;aiError=error;},
    async remount(){dispose();dispose=mountContracts(root,api,controller.signal);await settle();},
    close(){dispose();dom.window.close();Object.assign(globalThis,old);URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;}
  };
}

function image(app,name){return new app.dom.window.File(['image'],name,{type:'image/png'});}

test('PDF upload stays draft until human confirmation, opens private PDF and survives remount',async()=>{
  const app=await setup();
  try{
    app.files([new app.dom.window.File(['%PDF-test'],'demo.pdf',{type:'application/pdf'})]);
    await app.upload();
    assert.equal(app.contracts[0].upload_status,'draft');
    assert.match(app.root.querySelector('#contract-detail').textContent,/PDF 原本|PDF 원본 열기/);
    const link=app.root.querySelector('#contract-detail a');
    assert.match(link.href,/storage.example/);assert.equal(link.rel,'noopener noreferrer');
    await app.root.querySelector('#complete-contract').onclick();
    assert.equal(app.calls.filter(([path])=>path.endsWith('/complete')).length,0);
    app.root.querySelector('#confirm-contract-pages').checked=true;
    await app.root.querySelector('#complete-contract').onclick();
    assert.equal(app.contracts[0].upload_status,'ready');
    assert.equal(app.root.querySelector('#contract-files').disabled,true);
    assert.equal(app.root.querySelector('#upload-contract').disabled,true);
    assert.match(app.root.textContent,/미분석/);assert.match(app.root.textContent,/외부 OpenAI API로 전송/);
    await app.remount();
    assert.match(app.root.querySelector('#contract-detail').textContent,/등록 완료/);
    assert.equal(app.uploads.length,1);
  }finally{app.close();}
});

test('image ordering, independent page failures, same-number retry and completion',async()=>{
  const app=await setup();
  try{
    app.source('images');
    app.files([image(app,'first.png'),image(app,'second.png')]);
    app.root.querySelector('[data-move="0"][data-direction="1"]').onclick();
    app.fail(2);await app.upload();
    assert.deepEqual(app.uploads.map((row)=>[row.name,row.number]),[['second.png',1],['first.png',2]]);
    assert.match(app.root.textContent,/저장 완료/);assert.match(app.root.textContent,/가상 파일 저장 실패/);
    assert.equal(app.contracts[0].pages.length,1);
    assert.equal(app.root.querySelector('#complete-contract').disabled,true);
    app.root.querySelector('#confirm-contract-pages').checked=true;
    await app.root.querySelector('#complete-contract').onclick();
    assert.equal(app.calls.filter(([path])=>path.endsWith('/complete')).length,0);
    app.fail(0);await app.upload();
    assert.equal(app.uploads.length,3);
    assert.equal(app.uploads[2].number,2);
    assert.equal(app.contracts[0].pages.length,2);
    app.root.querySelector('#confirm-contract-pages').checked=true;
    await app.root.querySelector('#complete-contract').onclick();
    assert.equal(app.contracts[0].upload_status,'ready');
    assert.equal(app.root.querySelectorAll('#contract-detail img').length,2);
  }finally{app.close();}
});

test('draft resumes after remount and fills the missing page slot without replacing successes',async()=>{
  const app=await setup();
  try{
    app.source('images');app.files([image(app,'one.png'),image(app,'two.png'),image(app,'three.png')]);
    app.fail(2);await app.upload();
    assert.deepEqual(app.contracts[0].pages.map((page)=>page.page_number),[1,3]);
    await app.remount();
    assert.equal(app.root.querySelector('#contract-source').value,'images');
    assert.equal(app.root.querySelector('#contract-source').disabled,true);
    app.files([image(app,'retry-two.png')]);
    assert.equal(app.root.querySelector('[data-page-number]').value,'2');
    app.fail(0);await app.upload();
    assert.deepEqual(app.contracts[0].pages.map((page)=>page.page_number),[1,2,3]);
    assert.equal(app.contracts.length,1);
  }finally{app.close();}
});

test('max ten selection, file size, duplicate and missing page numbers are explained',async()=>{
  const app=await setup();
  try{
    app.source('images');app.files(Array.from({length:11},(_,i)=>image(app,`${i}.png`)));
    assert.match(app.root.textContent,/최대 10페이지/);
    const large=image(app,'large.png');Object.defineProperty(large,'size',{value:20*1024*1024+1});
    app.files([large]);assert.equal(app.root.querySelector('#upload-contract').disabled,true);
    app.files([image(app,'one.png'),image(app,'two.png')]);
    const inputs=app.root.querySelectorAll('[data-page-number]');inputs[1].value='1';inputs[1].onchange();
    await app.upload();assert.equal(app.contracts.length,0);assert.match(app.root.textContent,/중복/);
    inputs[1].value='3';inputs[1].onchange();await app.upload();
    app.root.querySelector('#confirm-contract-pages').checked=true;
    await app.root.querySelector('#complete-contract').onclick();
    assert.equal(app.contracts[0].upload_status,'draft');assert.match(app.root.textContent,/페이지 번호 누락/);
  }finally{app.close();}
});

test('multiple contracts remain selectable and a new job does not overwrite existing data',async()=>{
  const app=await setup();
  try{
    app.files([new app.dom.window.File(['pdf'],'a.pdf',{type:'application/pdf'})]);await app.upload();
    app.root.querySelector('#new-contract').onclick();
    app.source('images');app.files([image(app,'page.png')]);await app.upload();
    assert.equal(app.contracts.length,2);
    assert.equal(app.root.querySelectorAll('[data-contract]').length,2);
    await app.root.querySelector('[data-contract="contract-1"]').onclick();
    assert.equal(app.root.querySelector('#contract-source').value,'pdf');
    assert.match(app.root.querySelector('#contract-detail').textContent,/PDF 원본/);
  }finally{app.close();}
});


async function readyContract(app){
  app.files([new app.dom.window.File(['pdf'],'contract.pdf',{type:'application/pdf'})]);await app.upload();
  app.root.querySelector('#confirm-contract-pages').checked=true;
  await app.root.querySelector('#complete-contract').onclick();
}

test('contract AI requires explicit consent, blocks duplicate clicks, shows four sections and persists on remount',async()=>{
  const app=await setup();
  try{
    await readyContract(app);
    const button=app.root.querySelector('#analyze-contract');
    assert.equal(button.disabled,true);await button.onclick();
    assert.equal(app.calls.filter(([path])=>path.endsWith('/analyze')).length,0);
    const consent=app.root.querySelector('#contract-ai-consent');consent.checked=true;consent.onchange();
    let release;app.ai(new Promise(resolve=>{release=resolve;}));
    const pending=button.onclick();await settle();await button.onclick();
    assert.equal(app.calls.filter(([path])=>path.endsWith('/analyze')).length,1);
    assert.equal(app.root.querySelector('#analyze-contract').disabled,true);
    assert.match(app.root.textContent,/전체를 분석하고 있습니다/);
    release();await pending;
    for(const title of ['① 계약서 주요 정보','② 주의할 계약 조항','③ 추가 확인 체크리스트','④ 분석 한계 및 경고'])assert.match(app.root.textContent,new RegExp(title));
    assert.match(app.root.textContent,/10,000,000원/);assert.match(app.root.textContent,/확인 불가/);
    assert.ok(app.root.querySelector('a[href$="#page=2"]'));
    assert.equal(app.root.querySelector('#analyze-contract'),null);
    await app.remount();assert.match(app.root.textContent,/청소비 확인/);
    assert.equal(app.calls.filter(([path])=>path.endsWith('/analyze')).length,1);
  }finally{app.close();}
});

test('unreadable contract shows failure guidance and retry without fabricated summary',async()=>{
  const app=await setup();
  try{
    await readyContract(app);app.ai(null,'계약서를 판독하지 못했습니다.');
    const consent=app.root.querySelector('#contract-ai-consent');consent.checked=true;consent.onchange();
    await app.root.querySelector('#analyze-contract').onclick();
    assert.match(app.root.textContent,/2페이지를 선명하게 다시 등록/);
    assert.match(app.root.textContent,/다시 시도/);
    assert.doesNotMatch(app.root.textContent,/① 계약서 주요 정보/);
    await app.remount();assert.match(app.root.textContent,/판독하지 못했습니다/);
  }finally{app.close();}
});
