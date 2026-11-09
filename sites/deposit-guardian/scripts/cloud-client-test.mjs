import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {testDatabase} from './test-fixture.mjs';
const {call,worker,env}=testDatabase(),nativeFetch=globalThis.fetch;
const source=fs.readFileSync(new URL('../app/storage.js',import.meta.url),'utf8');
for(const who of ['charlie','dora'])assert.equal((await call('/api/account/register',{who,method:'POST',body:{displayName:who,consent:true}})).status,200);
const raw=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64'),photo='data:image/png;base64,'+raw.toString('base64');
function client(who,cache=new Map()){
 let offline=false,cookie='',activeWho=who;
 const db={createObjectStore(){},transaction(){const tx={objectStore(){return{get(key){const r={};setImmediate(()=>{r.result=cache.get(key);r.onsuccess();});return r;},put(value,key){setImmediate(()=>{cache.set(key,structuredClone(value));tx.oncomplete();});}}}};return tx;}};
 const indexedDB={open(){const r={result:db};setImmediate(()=>{r.onupgradeneeded();r.onsuccess();});return r;}};
 class FileReader{readAsDataURL(blob){blob.arrayBuffer().then(b=>{this.result='data:'+blob.type+';base64,'+Buffer.from(b).toString('base64');this.onload();});}}
 const ctx={window:{indexedDB},indexedDB,FileReader,Headers,location:{assign(){}},fetch:async(path,options={})=>{if(String(path).startsWith('data:'))return nativeFetch(path);if(offline)throw Error('offline');const h=new Headers(options.headers);h.set('oai-authenticated-user-id',activeWho);h.set('oai-authenticated-user-email',activeWho+'@example.test');if(options.method&&options.method!=='GET')h.set('Origin','https://deposit.test');if(cookie)h.set('Cookie',cookie);const r=await worker.fetch(new Request('https://deposit.test'+path,{...options,headers:h}),env);if(r.headers.get('Set-Cookie'))cookie=r.headers.get('Set-Cookie').split(';')[0];return r;}};
 vm.createContext(ctx);vm.runInContext(source,ctx);return{store:ctx.window.DepositStore,cache,setOffline(v){offline=v;},switchWho(v){activeWho=v;}};
}
const guest={area:'wall',phase:'before',records:{'wall-before':{image:photo,note:'입주 사진 메모',tag:'확인 필요'}},ai:{},contract:'',amount:'',claim:'',draft:'',comparison:{}};
guest.journal=[{id:'590d491a-0123-4123-8123-0123456789ab',title:'욕실 누수 수리',body:'임대인에게 연락하고 수리함',eventDate:'2026-11-07',category:'누수·결로',status:'완료',area:'bath',createdAt:'2026-11-07T00:00:00Z',updatedAt:'2026-11-07T00:00:00Z'}];
guest.journalDraft={title:'작성 중',body:'다음 점검 메모',eventDate:'',category:'기타',status:'기록만',area:'general',editId:''};
const cache=new Map([['current',structuredClone(guest)]]),a=client('charlie',cache);
const empty=await a.store.load();assert.equal(Object.keys(empty.records).length,0);assert.equal((await a.store.guest()).records['wall-before'].note,'입주 사진 메모');
await a.store.importGuest();assert.equal(await a.store.guest(),null);assert.equal(a.store.status().mode,'synced');
const b=client('charlie');let restored=await b.store.load();assert.equal(restored.records['wall-before'].image,photo);assert.equal(restored.journal[0].body,'임대인에게 연락하고 수리함');assert.equal(restored.journalDraft.title,'작성 중');assert.equal(restored.records['wall-before'].note,'입주 사진 메모');restored.records['wall-before'].note='다른 기기에서 수정';assert.equal((await b.store.save(restored)).cloud,true);
const local=structuredClone(guest);local.records['wall-before'].note='내 기기의 미저장 수정';const conflict=await a.store.save(local);assert.equal(conflict.cloud,false);assert.equal(a.store.status().mode,'conflict');
const reboot=client('charlie',cache);assert.equal((await reboot.store.load()).records['wall-before'].note,'내 기기의 미저장 수정');assert.equal(reboot.store.status().mode,'conflict');
restored=await reboot.store.refreshRemote();assert.equal(restored.records['wall-before'].note,'다른 기기에서 수정');assert([...cache.keys()].some(k=>k.startsWith('recovery:charlie:')));
reboot.setOffline(true);restored.records['wall-before'].note='오프라인 수정';assert.equal((await reboot.store.save(restored)).cloud,false);
const afterOffline=client('charlie',cache);const pending=await afterOffline.store.load();assert.equal(pending.records['wall-before'].note,'오프라인 수정');assert.equal(afterOffline.store.status().mode,'pending');assert.equal((await afterOffline.store.save(pending)).cloud,true);
const dora=client('dora',cache);const separated=await dora.store.load();assert.equal(Object.keys(separated.records).length,0);assert.equal(await dora.store.guest(),null);
const changing=client('charlie');const previous=await changing.store.load();changing.switchWho('dora');previous.records['wall-before'].note='이전 계정의 비공개 수정';assert.equal((await changing.store.save(previous)).cloud,false);assert.equal(changing.store.status().mode,'session-changed');
const untouched=await (await call('/api/workspace',{who:'dora'})).json();assert.equal(Object.keys(untouched.workspace.records).length,0);
const focused=client('charlie');await focused.store.load();focused.switchWho('dora');assert.equal((await focused.store.checkSession()).changed,true);
console.log('PASS two-device photo restore, explicit guest transfer, account cache isolation, conflict recovery and offline edits surviving reload');
