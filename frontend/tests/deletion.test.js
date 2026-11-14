import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {mountPhotos} from '../src/photos.js';
import {mountMoveOut} from '../src/moveout.js';
import {mountContracts} from '../src/contracts.js';
const settle=()=>new Promise(r=>setTimeout(r,10));
async function setup(mode,linked=false,ready=false){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost:5173'});
 const old=Object.fromEntries(['window','document','FormData'].map(k=>[k,globalThis[k]]));
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,FormData:dom.window.FormData});
 const entry={photo_id:'entry-1',stage:'entry',location:'거실',created_at:'2026-11-14T00:00:00Z',signed_url:'https://storage.example/e',mime_type:'image/png',size_bytes:10,analysis_status:'not_analyzed',analysis:null};
 let photos=linked?[entry,{...entry,photo_id:'exit-1',stage:'exit',paired_entry_photo_id:entry.photo_id,entry_signed_url:entry.signed_url,comparison_status:'not_analyzed',comparison:null}]:[entry];
 let contracts=[{contract_id:'contract-1',source_type:'pdf',upload_status:ready?'ready':'draft',created_at:entry.created_at,house:{name:'테스트'},page_count:2,uploaded_page_count:2,original_path:'private/original.pdf',signed_url:'https://storage.example/c',analysis_status:'not_analyzed',analysis:null,pages:[]}];
 let approved=false,failure='',gate=null,release;
 const messages=[],calls=[];
 dom.window.confirm=m=>{messages.push(m);return approved;};
 const api=async(path,options={})=>{
  calls.push([path,options.method||'GET']);
  if(options.method==='DELETE'){
   if(gate)await gate;if(failure)throw new Error(failure);
   if(path.startsWith('/api/photos/')){const id=path.split('/')[3].split('?')[0];photos=photos.filter(p=>p.photo_id!==id&&p.paired_entry_photo_id!==id);}
   else contracts=[];
   return {deleted:true};
  }
  if(path==='/api/move-in/photos')return photos.filter(p=>p.stage==='entry');
  if(path==='/api/move-out/photos')return photos.filter(p=>p.stage==='exit');
  if(path==='/api/contracts')return contracts;
  if(path==='/api/contracts/contract-1')return contracts[0];
  throw new Error(`Unexpected API ${path}`);
 };
 const mount={entry:mountPhotos,exit:mountMoveOut,contract:mountContracts}[mode];
 const root=document.querySelector('#root'),signal=new AbortController().signal;
 let dispose=mount(root,api,signal);await settle();
 return {root,calls,messages,approve(){approved=true;},fail(text){failure=text;},pause(){gate=new Promise(r=>{release=r;});},release(){release();},
 async remount(){dispose();dispose=mount(root,api,signal);await settle();},close(){dispose();dom.window.close();Object.assign(globalThis,old);}};
}

test('entry confirms actual pair and cancellation; paired ID is sent; removal persists',async()=>{
 const app=await setup('entry',true);
 try{
  await app.root.querySelector('[data-delete-photo]').onclick();assert.equal(app.calls.filter(([,m])=>m==='DELETE').length,0);
  assert.match(app.messages[0],/입실·퇴실 사진과 AI 분석·비교 결과/);
  app.approve();await app.root.querySelector('[data-delete-photo]').onclick();
  assert.equal(app.calls.filter(([,m])=>m==='DELETE')[0][0],'/api/photos/entry-1?paired_exit_photo_id=exit-1');
  assert.equal(app.root.querySelector('[data-delete-photo]'),null);
  await app.remount();assert.equal(app.root.querySelector('[data-delete-photo]'),null);
 }finally{app.close();}
});

test('photo duplicate deletion blocked; failure preserves card',async()=>{
 const app=await setup('entry');
 try{
  app.approve();app.pause();app.fail('일부 파일 삭제 실패, 다시 시도해 주세요.');
  const button=app.root.querySelector('[data-delete-photo]');const pending=button.onclick();await settle();await button.onclick();
  assert.equal(app.root.querySelector('[data-delete-photo]').disabled,true);assert.equal(app.calls.filter(([,m])=>m==='DELETE').length,1);
  app.release();await pending;assert.match(app.root.textContent,/일부 파일 삭제 실패/);assert.ok(app.root.querySelector('[data-delete-photo]'));
 }finally{app.close();}
});

test('exit deletion preserves entry and immediately frees pairing selection',async()=>{
 const app=await setup('exit',true);
 try{
  assert.equal(app.root.querySelector('[name=exit-entry]').disabled,true);
  app.approve();await app.root.querySelector('[data-delete-exit]').onclick();assert.match(app.messages[0],/입실 사진은 유지/);
  assert.equal(app.root.querySelector('[name=exit-entry]').disabled,false);assert.equal(app.root.querySelector('[data-delete-exit]'),null);
  await app.remount();assert.equal(app.root.querySelector('[name=exit-entry]').disabled,false);
 }finally{app.close();}
});

for(const ready of [false,true])test(`contract ${ready?'ready':'draft'} confirmation, duplicate prevention and persistent deletion`,async()=>{
 const app=await setup('contract',false,ready);
 try{
  await app.root.querySelector('#delete-contract').onclick();assert.equal(app.calls.filter(([,m])=>m==='DELETE').length,0);
  app.approve();app.pause();const button=app.root.querySelector('#delete-contract');const pending=button.onclick();await settle();await button.onclick();
  assert.equal(app.root.querySelector('#delete-contract').disabled,true);app.release();await pending;
  assert.equal(app.calls.filter(([,m])=>m==='DELETE').length,1);assert.match(app.messages[0],/모든 이미지 페이지/);assert.match(app.messages[0],/AI 분석 결과/);
  assert.equal(app.root.querySelector('#delete-contract'),null);await app.remount();assert.equal(app.root.querySelector('#delete-contract'),null);
 }finally{app.close();}
});

test('contract deletion failure preserves details and retry control',async()=>{
 const app=await setup('contract');
 try{
  app.approve();app.fail('파일 삭제 확인 실패');await app.root.querySelector('#delete-contract').onclick();assert.match(app.root.textContent,/파일 삭제 확인 실패/);
  assert.equal(app.root.querySelector('#delete-contract').disabled,false);
  app.fail('');await app.root.querySelector('#delete-contract').onclick();assert.equal(app.root.querySelector('#delete-contract'),null);
 }finally{app.close();}
});
