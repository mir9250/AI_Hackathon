import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',H='33333333-3333-4333-8333-333333333333';
const E='55555555-5555-4555-8555-555555555555',X='66666666-6666-4666-8666-666666666666',C='77777777-7777-4777-8777-777777777777';

test('005 durable deletion and AI/upload write races',async(t)=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
    insert into auth.users values('${A}'),('${B}');`);
  for(const file of ['001_initial','002_photo_analysis','003_photo_comparison','004_contract_analysis','005_resource_deletion'])await db.exec(await readFile(new URL(`../../supabase/migrations/202611140${file}.sql`,import.meta.url),'utf8'));
  await db.exec(`insert into public.houses(house_id,user_id,name,address) values('${H}','${A}','demo','test')`);
  const seed=async()=>{
   await db.exec(`delete from public.comparisons;delete from public.photos where stage='exit';delete from public.photos;delete from public.contracts;delete from public.ai_request_logs;
    insert into public.photos(photo_id,house_id,stage,location,original_path,mime_type,size_bytes,upload_id,paired_entry_photo_id) values
    ('${E}','${H}','entry','거실','e.png','image/png',100,gen_random_uuid(),null),('${X}','${H}','exit','거실','x.png','image/png',100,gen_random_uuid(),'${E}');
    insert into public.contracts(contract_id,house_id,source_type,original_path,page_count,upload_id,upload_status) values('${C}','${H}','pdf','c.pdf',2,gen_random_uuid(),'ready');`);
  };
  const begin=async(kind,id,expected=null,user=A)=>(await db.query('select public.begin_resource_deletion($1,$2,$3,$4) r',[user,kind,id,expected])).rows[0].r;
  const finish=async(kind,id)=>(await db.query('select public.finish_resource_deletion($1,$2,$3) r',[A,kind,id])).rows[0].r;
  await t.test('owner, confirmation, grants and not-prepared guard',async()=>{
   await seed();assert.equal((await begin('photo',E,null,B)).action,'forbidden');
   assert.equal((await begin('photo',E)).action,'confirmation_changed');
   assert.equal((await finish('photo',E)).action,'not_prepared');
   assert.equal((await db.query('select deleting from photos where photo_id=$1',[E])).rows[0].deleting,false);
   await db.exec('set role authenticated');await assert.rejects(begin('photo',E,X));await db.exec('reset role');
  });
  await t.test('entry deletion cascades exit and results, keeps other resource and AI budget',async()=>{
   await seed();const eid=crypto.randomUUID(),xid=crypto.randomUUID();
   await db.query('select public.begin_photo_analysis($1,$2,$3)',[A,E,eid]);
   await db.query('select public.reserve_photo_ai_attempt($1,$2,$3,$3,30)',[A,E,eid]);
   await db.query('select public.finish_photo_ai_attempt($1,$2,$3,$4,null,true,$5)',[A,E,eid,{overall_result:'none',damages:[]},'gpt-5.4-mini']);
   await db.query('select public.begin_photo_comparison($1,$2,$3)',[A,X,xid]);
   await db.query('select public.reserve_photo_comparison_attempt($1,$2,$3,$3,30)',[A,X,xid]);
   await db.query('select public.finish_photo_comparison_attempt($1,$2,$3,$4,null,true,$5)',[A,X,xid,{overall_result:'no_visible_change',changes:[]},'gpt-5.4-mini']);
   const plan=await begin('photo',E,X);assert.equal(plan.photos.length,2);
   assert.equal((await begin('photo',E,X)).action,'prepared');
   assert.equal((await begin('photo',X)).action,'parent_deleting');
   assert.equal((await finish('photo',E)).action,'deleted');assert.equal((await finish('photo',E)).action,'deleted');
   for(const table of ['photos','analyses','comparisons'])assert.equal((await db.query(`select * from ${table}`)).rows.length,0);
   assert.equal((await db.query('select * from contracts')).rows.length,1);
   assert.equal((await db.query('select * from ai_request_logs where attempted_at is not null')).rows.length,2);
  });
  await t.test('deleting used resources cannot reset the 30-attempt quota',async()=>{
   await seed();
   await db.query("insert into ai_request_logs(user_id,task_type,resource_id,status,attempted_at) select $1,'photo_analysis',$2,'failed',clock_timestamp() from generate_series(1,30)",[A,E]);
   await begin('photo',E,X);await finish('photo',E);
   const request=crypto.randomUUID();await db.query('select public.begin_contract_analysis($1,$2,$3,true)',[A,C,request]);
   assert.equal((await db.query('select public.reserve_contract_ai_attempt($1,$2,$3,$3,30) r',[A,C,request])).rows[0].r.action,'limit');
  });
  await t.test('stale work can be deleted without paid recovery; late finishes cannot overwrite',async()=>{
   await seed();const request=crypto.randomUUID();
   await db.query('select public.begin_photo_analysis($1,$2,$3)',[A,E,request]);
   await db.query('select public.reserve_photo_ai_attempt($1,$2,$3,$3,30)',[A,E,request]);
   await db.query("update analyses set started_at=clock_timestamp()-interval '4 minutes' where photo_id=$1",[E]);
   assert.equal((await begin('photo',E,X)).action,'prepared');
   assert.equal((await db.query('select public.finish_photo_ai_attempt($1,$2,$3,$4,null,true,$5) r',[A,E,request,{overall_result:'none',damages:[]},'gpt-5.4-mini'])).rows[0].r.action,'superseded');
   assert.equal((await db.query('select status from ai_request_logs where request_id=$1',[request])).rows[0].status,'failed');
   await finish('photo',E);
   const contractRequest=crypto.randomUUID();await db.query('select public.begin_contract_analysis($1,$2,$3,true)',[A,C,contractRequest]);
   await db.query("update contract_analyses set started_at=clock_timestamp()-interval '4 minutes' where contract_id=$1",[C]);
   assert.equal((await begin('contract',C)).action,'prepared');await finish('contract',C);
   assert.equal((await db.query('select * from contract_analyses')).rows.length,0);
  });
  await t.test('exit deletion preserves entry and permits a new exit',async()=>{
   await seed();await begin('photo',X);await finish('photo',X);
   assert.equal((await db.query('select photo_id from photos')).rows[0].photo_id,E);
   await db.query("insert into photos(house_id,stage,location,original_path,mime_type,size_bytes,upload_id,paired_entry_photo_id) values($1,'exit','거실','new.png','image/png',1,gen_random_uuid(),$2)",[H,E]);
  });
  await t.test('analyzing entry/comparison/contract deny deletion before changing state',async()=>{
   await seed();const id=crypto.randomUUID();await db.query('select public.begin_photo_comparison($1,$2,$3)',[A,X,id]);
   assert.equal((await begin('photo',E,X)).action,'busy');assert.equal((await begin('photo',X)).action,'busy');
   await db.query('select public.begin_photo_analysis($1,$2,$3)',[A,E,crypto.randomUUID()]);
   assert.equal((await begin('photo',E,X)).action,'busy');
   await db.query('select public.begin_contract_analysis($1,$2,$3,true)',[A,C,crypto.randomUUID()]);assert.equal((await begin('contract',C)).action,'busy');
   assert.equal((await db.query('select count(*)::int n from photos where deleting')).rows[0].n,0);
  });
  await t.test('deletion blocks new starts, uploads and late writes at DB level',async()=>{
   await seed();await begin('photo',E,X);
   await assert.rejects(db.query('select public.begin_photo_analysis($1,$2,$3)',[A,E,crypto.randomUUID()]),/deletion/);
   await assert.rejects(db.query('select public.begin_photo_comparison($1,$2,$3)',[A,X,crypto.randomUUID()]),/deletion/);
   await assert.rejects(db.query("insert into photos(house_id,stage,location,original_path,mime_type,size_bytes,upload_id,paired_entry_photo_id) values($1,'exit','거실','other.png','image/png',1,gen_random_uuid(),$2)",[H,E]));
   await assert.rejects(db.query("insert into analyses(photo_id,status) values($1,'pending')",[E]),/deletion/);
   await finish('photo',E);
   assert.equal((await db.query('select public.finish_photo_ai_attempt($1,$2,$3,null,$4,true,$5) r',[A,E,crypto.randomUUID(),'AI_TIMEOUT','gpt-5.4-mini'])).rows[0].r.action,'forbidden');
  });
  await t.test('PDF and image draft deletion, page/result cascades, writes frozen, retry works',async()=>{
   await seed();await begin('contract',C);
   assert.equal((await db.query('select public.begin_contract_analysis($1,$2,$3,true) r',[A,C,crypto.randomUUID()])).rows[0].r.action,'not_ready');
   await assert.rejects(db.query("update contracts set original_path='changed.pdf' where contract_id=$1",[C]),/deletion/);
   await finish('contract',C);assert.equal((await db.query('select * from photos')).rows.length,2);
   await db.query("insert into contracts(contract_id,house_id,source_type,upload_id) values($1,$2,'images',gen_random_uuid())",[C,H]);
   await db.query("insert into contract_pages(contract_id,page_number,original_path,mime_type,size_bytes) values($1,1,'p.heic','image/heic',5),($1,2,'p2.png','image/png',5)",[C]);
   const plan=await begin('contract',C);assert.equal(plan.pages.length,2);
   await assert.rejects(db.query("insert into contract_pages(contract_id,page_number,original_path,mime_type,size_bytes) values($1,3,'p3.png','image/png',5)",[C]));
   await finish('contract',C);assert.equal((await db.query('select * from contract_pages')).rows.length,0);
  });
 }finally{await db.close();}
});
