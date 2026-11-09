import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../dist/server/index.js';
export function testDatabase(){
const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
for(const f of fs.readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
const DB={prepare(sql){let values=[];const obj={bind(...args){values=args;return obj;},async first(){return sqlite.prepare(sql).get(...values)||null;},async all(){return{results:sqlite.prepare(sql).all(...values)};},async run(){const r=sqlite.prepare(sql).run(...values);return{meta:{changes:Number(r.changes)}};}};return obj;}};
const blobs=new Map(),BUCKET={async put(key,data){blobs.set(key,Uint8Array.from(data));},async get(key){return blobs.has(key)?{body:blobs.get(key)}:null;}};
const env={DB,BUCKET},origin='https://deposit.test';
function req(path,{who,method='GET',body,cookie,originValue=origin,type='application/json',expected=who}={}){const h={};if(who){h['oai-authenticated-user-id']=who;h['oai-authenticated-user-email']=who+'@example.test';}if(method!=='GET'){h.Origin=originValue;h['Content-Type']=type;}if(expected)h['X-Account-Id']=expected;if(cookie)h.Cookie=cookie;return new Request(origin+path,{method,headers:h,...(body===undefined?{}:{body:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)})});}
const call=(path,opt)=>worker.fetch(req(path,opt),env);
return {sqlite,env,call,worker};
}
