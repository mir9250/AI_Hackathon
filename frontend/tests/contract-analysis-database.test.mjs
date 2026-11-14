import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const H='33333333-3333-4333-8333-333333333333',E='55555555-5555-4555-8555-555555555555',X='66666666-6666-4666-8666-666666666666';
const C='77777777-7777-4777-8777-777777777777',D='88888888-8888-4888-8888-888888888888';
const summary={deposit:null,monthly_rent:null,maintenance_fee:null,contract_period:null,special_clauses_summary:null};
const result={document_quality:'readable',summary,findings:[],checklist:[],warnings:[]};

test('004: consent, full contract states, three-task atomic quota, stale recovery and result guards',async(t)=>{
  const db=new PGlite();
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
      create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
      insert into auth.users values('${A}'),('${B}');`);
    for(const name of ['202611140001_initial.sql','202611140002_photo_analysis.sql','202611140003_photo_comparison.sql','202611140004_contract_analysis.sql']){
      await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8'));
    }
    await db.exec(`insert into public.houses(house_id,user_id,name,address) values('${H}','${A}','demo','test');
      insert into public.photos(photo_id,house_id,stage,location,original_path,mime_type,size_bytes,upload_id,paired_entry_photo_id) values
      ('${E}','${H}','entry','거실','e.png','image/png',100,gen_random_uuid(),null),
      ('${X}','${H}','exit','거실','x.png','image/png',100,gen_random_uuid(),'${E}');
      insert into public.contracts(contract_id,house_id,source_type,original_path,page_count,upload_id,upload_status) values
      ('${C}','${H}','pdf','contract.pdf',2,gen_random_uuid(),'ready'),('${D}','${H}','pdf',null,null,gen_random_uuid(),'draft');`);
    const begin=async(id,user=A,consent=true,cid=C)=>(await db.query('select public.begin_contract_analysis($1,$2,$3,$4) as r',[user,cid,id,consent])).rows[0].r;
    const reserve=async(active,id,limit=30)=>(await db.query('select public.reserve_contract_ai_attempt($1,$2,$3,$4,$5) as r',[A,C,active,id,limit])).rows[0].r;
    const finish=async(id,output=null,error='AI_TIMEOUT',final=true)=>(await db.query('select public.finish_contract_ai_attempt($1,$2,$3,$4,$5,$6,$7) as r',[A,C,id,output,error,final,'gpt-5.4-mini'])).rows[0].r;

    await t.test('consent and ready state are checked in SQL; browser roles cannot call admin functions',async()=>{
      assert.equal((await begin(crypto.randomUUID(),A,false)).action,'consent_required');
      assert.equal((await begin(crypto.randomUUID(),B)).action,'forbidden');
      assert.equal((await begin(crypto.randomUUID(),A,true,D)).action,'not_ready');
      assert.equal((await db.query('select * from public.contract_analyses')).rows.length,0);
      await db.exec('set role authenticated');await assert.rejects(begin(crypto.randomUUID()));await db.exec('reset role');
    });

    await t.test('photo analysis + comparison + contract calls share the same 30-slot budget',async()=>{
      const entry=crypto.randomUUID(),comparison=crypto.randomUUID();
      await db.query('select public.begin_photo_analysis($1,$2,$3)',[A,E,entry]);
      await db.query('select public.reserve_photo_ai_attempt($1,$2,$3,$4,30)',[A,E,entry,entry]);
      await db.query('select public.begin_photo_comparison($1,$2,$3)',[A,X,comparison]);
      await db.query('select public.reserve_photo_comparison_attempt($1,$2,$3,$4,30)',[A,X,comparison,comparison]);
      for(let i=0;i<27;i++)await db.query("insert into public.ai_request_logs(user_id,task_type,resource_id,status,attempted_at) values($1,'photo_analysis',$2,'failed',clock_timestamp())",[A,E]);
      const contract=crypto.randomUUID();
      assert.equal((await begin(contract)).action,'acquired');
      const started=(await db.query('select * from public.contract_analyses')).rows[0];assert.ok(started.consent_at);
      assert.equal((await reserve(contract,contract,999)).action,'reserved');
      await finish(contract,null,'AI_TIMEOUT',false);
      assert.equal((await reserve(contract,crypto.randomUUID(),999)).action,'limit');
      const failed=await finish(contract,null,'AI_DAILY_LIMIT');
      assert.equal(failed.analysis.status,'failed');assert.equal(failed.analysis.error_code,'AI_DAILY_LIMIT');
      assert.equal((await db.query('select count(*)::int as n from public.ai_request_logs where attempted_at is not null')).rows[0].n,30);
      const nextPhoto=crypto.randomUUID();
      await db.query("update public.analyses set started_at=clock_timestamp()-interval '4 minutes' where photo_id=$1",[E]);
      await db.query('select public.begin_photo_analysis($1,$2,$3)',[A,E,nextPhoto]);
      assert.equal((await db.query('select public.reserve_photo_ai_attempt($1,$2,$3,$4,30) as r',[A,E,nextPhoto,nextPhoto])).rows[0].r.action,'limit');
    });

    await t.test('unreadable is failed with quality/warnings; consent and request correlation persist',async()=>{
      await db.exec("update public.ai_request_logs set attempted_at=attempted_at-interval '2 days' where attempted_at is not null");
      const id=crypto.randomUUID();await begin(id);assert.equal((await begin(crypto.randomUUID())).action,'busy');
      assert.equal((await reserve(id,id)).action,'reserved');
      const unreadable={...result,document_quality:'unreadable',warnings:['2페이지를 선명하게 다시 등록하세요.']};
      await assert.rejects(finish(id,unreadable,null));
      const saved=await finish(id,unreadable,'AI_CONTRACT_UNREADABLE');
      assert.equal(saved.analysis.status,'failed');assert.equal(saved.analysis.document_quality,'unreadable');
      assert.deepEqual(saved.analysis.warnings,unreadable.warnings);assert.ok(saved.analysis.consent_at);
      assert.equal((await db.query('select status from public.ai_request_logs where request_id=$1',[id])).rows[0].status,'failed');
    });

    await t.test('ended attempts cannot be reserved again; retry and stale results cannot overwrite current work',async()=>{
      const one=crypto.randomUUID();await begin(one);await reserve(one,one);
      await finish(one,null,'AI_TIMEOUT',false);
      assert.equal((await reserve(one,one)).action,'superseded');
      const two=crypto.randomUUID();await reserve(one,two);
      assert.equal((await finish(one,result,null)).action,'superseded');
      assert.equal((await finish(two,result,null)).analysis.status,'completed');
      assert.equal((await begin(crypto.randomUUID())).action,'completed');
      await db.query("update public.contract_analyses set status='analyzing',started_at=clock_timestamp()-interval '4 minutes' where contract_id=$1",[C]);
      const recovered=crypto.randomUUID();assert.equal((await begin(recovered)).action,'acquired');
      assert.equal((await finish(two,result,null)).action,'superseded');
      assert.equal((await finish(recovered,null,'AI_DOCUMENT_FETCH_FAILED')).analysis.status,'failed');
      assert.equal((await db.query('select attempted_at from public.ai_request_logs where request_id=$1',[recovered])).rows[0].attempted_at,null);
    });

    await t.test('RLS hides contract analysis and logs from another user',async()=>{
      await db.exec(`set role authenticated;set request.jwt.claim.sub='${B}'`);
      assert.equal((await db.query('select * from public.contract_analyses')).rows.length,0);
      assert.equal((await db.query('select * from public.ai_request_logs')).rows.length,0);
      await db.exec('reset role');
    });
  }finally{await db.close();}
});
