import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {localRuntime} from './local-runtime.mjs';
import {migrate} from './local-migrations.mjs';
const directory=await mkdtemp(path.join(tmpdir(),'deposit-runtime-'));
const token=randomBytes(32).toString('hex');let upstreamCalls=0;
const analysis={tags:[],summary:'특약 확인',observations:[],questions:[],next_steps:[],draft:'확인 요청',limitations:['법률 판단 아님']};
let mf=localRuntime({persist:directory,token,outbound:async req=>{
  assert.equal(req.url,'https://api.openai.com/v1/responses');
  const body=await req.json();assert.equal(body.store,false);assert.equal(body.text.format.strict,true);upstreamCalls++;
  return new Response(JSON.stringify({status:'completed',model:'mock-model',output:[{content:[{type:'output_text',text:JSON.stringify(analysis)}]}]}));
}});
const origin='http://127.0.0.1';
async function call(route,{who,method='GET',body,type='application/json',headers={}}={}){
  return mf.dispatchFetch(origin+route,{method,headers:{...(who?{'x-local-test-token':token,'x-local-test-user':who,'X-Account-Id':who}:{}),...(method==='GET'?{}:{Origin:origin,'Content-Type':type}),...headers},...(body===undefined?{}:{body:body instanceof Uint8Array?body:JSON.stringify(body)})});
}
try{
  const DB=await mf.getD1Database('DB');assert.equal((await migrate(DB)).length,2);assert.deepEqual(await migrate(DB),[]);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM local_migrations').first()).n,2);
  // Ordinary network requests can never authenticate by supplying Sites headers.
  const url=await mf.ready;
  assert.equal((await (await fetch(new URL('/api/account/me',url),{headers:{'oai-authenticated-user-id':'alice','oai-authenticated-user-email':'alice@example.invalid'}})).json()).authenticated,false);
  assert.equal((await call('/api/workspace')).status,401);
  for(const who of ['alice','bob'])assert.equal((await call('/api/account/register',{who,method:'POST',body:{displayName:who,consent:true}})).status,200);
  const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=','base64'));
  const photo=await (await call('/api/photos',{who:'alice',method:'POST',type:'image/png',body:png})).json();assert(photo.id);
  assert.equal((await call(photo.url)).status,401);assert.equal((await call(photo.url,{who:'bob'})).status,404);
  assert.deepEqual(new Uint8Array(await (await call(photo.url,{who:'alice'})).arrayBuffer()),png);
  const row=await DB.prepare('SELECT object_key FROM photos WHERE id=?').bind(photo.id).first();
  assert.deepEqual(new Uint8Array(await (await (await mf.getR2Bucket('BUCKET')).get(row.object_key)).arrayBuffer()),png);
  assert.equal((await call('/'+row.object_key)).status,404);
  const workspace={records:{'wall-before':{photoId:photo.id,image:photo.url,note:'로컬 D1 기록',tag:'확인 필요',savedAt:'2026-11-09T00:00:00Z'}},ai:{}};
  assert.equal((await call('/api/workspace',{who:'alice'})).status,200);
  assert.equal((await call('/api/workspace',{who:'alice',method:'PUT',body:{workspace,baseVersion:0}})).status,200);
  assert.equal((await call('/api/workspace',{who:'alice',method:'PUT',body:{workspace,baseVersion:0}})).status,409);
  assert.equal((await call('/api/workspace',{who:'bob',method:'PUT',body:{workspace,baseVersion:0}})).status,403);
  assert.equal((await (await call('/api/workspace',{who:'alice'})).json()).workspace.records['wall-before'].note,'로컬 D1 기록');
  assert.equal((await call('/api/analyze',{who:'alice',method:'POST',body:{task:'contract',text:'분석할 테스트 특약 텍스트입니다.',consent:true}})).status,200);assert.equal(upstreamCalls,1);
  // Restart against the same isolated persistence, without a test identity binding or key.
  await mf.dispose();mf=localRuntime({persist:directory});
  assert.deepEqual(await migrate(await mf.getD1Database('DB')),[]);
  assert.equal((await (await mf.getD1Database('DB')).prepare('SELECT version FROM workspaces WHERE user_id=?').bind('alice').first()).version,1);
  assert(await (await mf.getR2Bucket('BUCKET')).get(row.object_key));
  assert.equal((await call('/api/analyze',{method:'POST',body:{task:'contract',text:'분석할 테스트 특약 텍스트입니다.',consent:true}})).status,503);
  assert.equal((await call('/api/workspace',{who:'alice'})).status,401,'test headers disabled outside fixture');
  console.log('PASS workerd Worker routes, local D1 migration history/reapply/restart, private R2 bytes, profile/workspace/photo ownership/409, forged identity rejection, AI no-key/mock only');
}finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
