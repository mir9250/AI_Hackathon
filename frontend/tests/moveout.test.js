import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountMoveOut } from '../src/moveout.js';
import { comparisonMarkup } from '../src/analysis.js';

const settle=()=>new Promise((resolve)=>setTimeout(resolve,10));
const entry={photo_id:'entry-1',location:'<거실>',created_at:'2026-11-14T00:00:00Z',
  signed_url:'https://storage.example/entry',mime_type:'image/png',size_bytes:100};
const completed={exit_photo_id:'exit-1',entry_photo_id:'entry-1',status:'completed',overall_result:'change_suspected',
  changes:[{type:'긁힘',status:'새 흔적 의심',description:'<표면 흔적>',recommendation:'같은 각도로 촬영'}]};

async function setup() {
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:5173'});
  const old=Object.fromEntries(['window','document','FormData'].map((key)=>[key,globalThis[key]]));
  Object.assign(globalThis,{window:dom.window,document:dom.window.document,FormData:dom.window.FormData});
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
  URL.createObjectURL=()=> 'blob:exit'; URL.revokeObjectURL=()=>{};
  let exits=[],failUpload=false,failCompare=false,wait,release;
  const uploads=[],comparisons=[];
  const root=document.querySelector('#root');
  const controller=new AbortController();
  const api=async(path,options={})=>{
    if (path.endsWith('/compare')) {
      comparisons.push(path);
      assert.equal(options.timeoutMs,180000);
      if (wait) await wait;
      if (failCompare) {
        exits[0].comparison={status:'failed',error_code:'AI_CREDIT_REQUIRED'};
        exits[0].comparison_status='failed';
        throw new Error('API 크레딧을 확인해 주세요.');
      }
      exits[0].comparison=completed; exits[0].comparison_status='completed';
      return completed;
    }
    if (options.method==='POST') {
      assert.equal(path,'/api/move-out/photos');
      assert.ok(options.body instanceof dom.window.FormData);
      uploads.push({id:options.body.get('upload_id'),pair:options.body.get('paired_entry_photo_id')});
      assert.equal(options.body.has('location'),false);
      if (failUpload) throw new Error('저장 실패');
      exits=[{photo_id:'exit-1',paired_entry_photo_id:'entry-1',location:entry.location,
        created_at:entry.created_at,signed_url:'https://storage.example/exit',entry_signed_url:entry.signed_url,
        comparison:null,comparison_status:'not_analyzed'}];
      return {photo_id:'exit-1',upload_status:'stored',already_uploaded:false};
    }
    if (path==='/api/move-in/photos') return [entry];
    assert.equal(path,'/api/move-out/photos');
    return exits;
  };
  let dispose=mountMoveOut(root,api,controller.signal);
  await settle();
  return {dom,root,uploads,comparisons,
    select() { const radio=root.querySelector('[name=exit-entry]'); radio.checked=true; radio.onchange(); },
    file(file) { const input=root.querySelector('#exit-file'); Object.defineProperty(input,'files',{configurable:true,value:[file]}); input.onchange({target:input}); },
    async upload() { const form=root.querySelector('#exit-upload-form'); await form.onsubmit({preventDefault(){},currentTarget:form}); },
    failUpload(value) { failUpload=value; }, failCompare(value) { failCompare=value; },
    pause() { wait=new Promise((resolve)=>{release=resolve;}); }, release() { release?.(); },
    async remount() { dispose(); dispose=mountMoveOut(root,api,controller.signal); await settle(); },
    close() { dispose(); dom.window.close(); Object.assign(globalThis,old); URL.createObjectURL=oldCreate; URL.revokeObjectURL=oldRevoke; }
  };
}

async function uploadOne(app) {
  app.select();
  app.file(new app.dom.window.File(['test'],'exit.png',{type:'image/png'}));
  await app.upload();
}

test('select entry, upload exit, show side-by-side pair, disable used entry, remount keeps pair',async()=>{
  const app=await setup();
  try {
    assert.equal(app.root.querySelector('#exit-upload').disabled,true);
    app.select();
    assert.match(app.root.querySelector('#exit-location').textContent,/<거실>/);
    app.file(new app.dom.window.File(['test'],'exit.png',{type:'image/png'}));
    assert.equal(app.root.querySelector('#exit-preview').hidden,false);
    assert.equal(app.root.querySelector('#exit-upload').disabled,false);
    await app.upload();
    assert.equal(app.uploads[0].pair,'entry-1');
    assert.equal(app.root.querySelectorAll('.comparison-pair img').length,2);
    assert.equal(app.root.querySelector('[name=exit-entry]').disabled,true);
    assert.match(app.root.textContent,/퇴실 사진 등록 완료/);
    assert.ok(app.root.querySelector('[data-compare]'));
    await app.remount();
    assert.equal(app.root.querySelectorAll('.comparison-pair img').length,2);
    assert.equal(app.root.querySelector('[name=exit-entry]').disabled,true);
    await app.upload();
    assert.equal(app.uploads.length,1);
  } finally {app.close();}
});

test('failed upload retries with same ID and invalid image type/size is rejected locally',async()=>{
  const app=await setup();
  try {
    app.select();
    app.file(new app.dom.window.File(['bad'],'bad.txt',{type:'text/plain'}));
    assert.equal(app.root.querySelector('#exit-upload').disabled,true);
    const oversized=new app.dom.window.File(['a'],'large.png',{type:'image/png'});
    Object.defineProperty(oversized,'size',{value:20*1024*1024+1}); app.file(oversized);
    assert.equal(app.root.querySelector('#exit-upload').disabled,true);
    app.file(new app.dom.window.File(['image'],'exit.png',{type:'image/png'}));
    app.failUpload(true); await app.upload();
    assert.match(app.root.textContent,/업로드 실패/);
    app.failUpload(false); await app.upload();
    assert.equal(app.uploads.length,2);
    assert.equal(app.uploads[0].id,app.uploads[1].id);
  } finally {app.close();}
});

test('comparison blocks duplicate clicks and renders saved findings after remount',async()=>{
  const app=await setup();
  try {
    await uploadOne(app); app.pause();
    const button=app.root.querySelector('[data-compare]');
    const finished=button.onclick();
    assert.equal(app.root.querySelector('[data-compare]').disabled,true);
    await button.onclick();
    assert.equal(app.comparisons.length,1);
    assert.match(app.root.textContent,/사진을 비교하고/);
    app.release(); await finished;
    assert.match(app.root.textContent,/새로운 손상 의심/);
    assert.match(app.root.textContent,/<표면 흔적>/);
    assert.match(app.root.textContent,/권장 조치.*같은 각도로 촬영/);
    assert.equal(app.root.querySelector('표면'),null);
    assert.equal(app.root.querySelector('[data-compare]'),null);
    await app.remount();
    assert.match(app.root.textContent,/새로운 손상 의심/);
    assert.equal(app.comparisons.length,1);
  } finally {app.close();}
});

test('comparison failure keeps retry control and does not claim no visible change',async()=>{
  const app=await setup();
  try {
    await uploadOne(app); app.failCompare(true);
    await app.root.querySelector('[data-compare]').onclick();
    assert.match(app.root.textContent,/크레딧/);
    assert.match(app.root.textContent,/AI 비교 다시 시도/);
    assert.doesNotMatch(app.root.textContent,/눈에 띄는 변화 없음/);
    await app.remount();
    assert.match(app.root.textContent,/크레딧/);
  } finally {app.close();}
});

test('no-visible-change result is completed and stale comparison can retry',()=>{
  const none=comparisonMarkup({photo_id:'x',comparison:{status:'completed',overall_result:'no_visible_change',changes:[]}});
  assert.match(none,/눈에 띄는 변화 없음/); assert.doesNotMatch(none,/data-compare/);
  const stale=comparisonMarkup({photo_id:'x',comparison:{status:'analyzing',started_at:'2000-01-01T00:00:00Z'}});
  assert.match(stale,/3분 이상/); assert.doesNotMatch(stale,/disabled/);
});
