import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from './render-worker.js';
test('proxy keeps authorization and response errors, uses only fixed Render origin',async()=>{
 let seen;
 const worker=createWorker({},async(url,init)=>{seen={url,init};return Response.json({error:{code:'INVALID_TOKEN'}},{status:401});});
 const response=await worker.fetch(new Request('https://site.example/api/profile?test=1',{headers:{authorization:'Bearer token',cookie:'private',origin:'https://site.example'}}));
 assert.equal(response.status,401);
 assert.equal(seen.url,'https://ai-hackathon-nd4y.onrender.com/api/profile?test=1');
 assert.equal(seen.init.headers.get('authorization'),'Bearer token');
 assert.equal(seen.init.headers.get('cookie'),null);
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await response.json()).error.code,'INVALID_TOKEN');
});
test('proxy blocks missing auth, cross-site writes and oversized bodies',async()=>{
 const worker=createWorker({},()=>{throw Error('should not fetch');});
 assert.equal((await worker.fetch(new Request('https://site.example/api/profile'))).status,401);
 assert.equal((await worker.fetch(new Request('https://site.example/api/house',{method:'PUT',headers:{origin:'https://other.example',authorization:'Bearer t'}}))).status,403);
 assert.equal((await worker.fetch(new Request('https://site.example/api/living-records',{method:'POST',headers:{authorization:'Bearer t','content-length':String(22*1024*1024)}}))).status,422);
});
test('static assets are served and unknown routes return 404',async()=>{
 const worker=createWorker({'/index.html':{data:btoa('hello'),type:'text/html'}});
 assert.equal(await (await worker.fetch(new Request('https://site.example/'))).text(),'hello');
 assert.equal((await worker.fetch(new Request('https://site.example/missing'))).status,404);
});
