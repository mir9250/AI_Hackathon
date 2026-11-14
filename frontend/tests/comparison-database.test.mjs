import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const H='33333333-3333-4333-8333-333333333333', HB='44444444-4444-4444-8444-444444444444';
const E='55555555-5555-4555-8555-555555555555', X='66666666-6666-4666-8666-666666666666';
const EB='77777777-7777-4777-8777-777777777777';

test('003: valid pairs, comparison state and a shared entry/comparison daily quota', async (t) => {
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to authenticated, anon, service_role;
      grant execute on function auth.uid() to authenticated, anon, service_role;
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);
      insert into auth.users values ('${A}'),('${B}');`);
    for (const file of ['202611140001_initial.sql','202611140002_photo_analysis.sql','202611140003_photo_comparison.sql']) {
      await db.exec(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),'utf8'));
    }
    await db.exec(`insert into public.houses(house_id,user_id,name,address) values
      ('${H}','${A}','A','test'),('${HB}','${B}','B','test');`);
    const photo=async(id,house,stage,pair) => db.query(`insert into public.photos
      (photo_id,house_id,stage,location,original_path,mime_type,size_bytes,upload_id,paired_entry_photo_id)
      values($1,$2,$3,'거실',$4,'image/png',100,gen_random_uuid(),$5)`,[id,house,stage,`${id}.png`,pair]);
    await photo(E,H,'entry',null); await photo(EB,HB,'entry',null); await photo(X,H,'exit',E);
    const begin=async(id,user=A,target=X) => (await db.query(
      'select public.begin_photo_comparison($1,$2,$3) as r',[user,target,id])).rows[0].r;
    const reserve=async(active,id,limit=30) => (await db.query(
      'select public.reserve_photo_comparison_attempt($1,$2,$3,$4,$5) as r',[A,X,active,id,limit])).rows[0].r;
    const finish=async(id,result=null,error='AI_TIMEOUT',final=true) => (await db.query(
      'select public.finish_photo_comparison_attempt($1,$2,$3,$4,$5,$6,$7) as r',
      [A,X,id,result,error,final,'gpt-5.4-mini'])).rows[0].r;

    await t.test('existing constraints reject foreign house, duplicate pair and mismatched comparison', async () => {
      await assert.rejects(photo(crypto.randomUUID(),H,'exit',EB));
      await assert.rejects(photo(crypto.randomUUID(),HB,'exit',E));
      await assert.rejects(photo(crypto.randomUUID(),H,'exit',E));
      await assert.rejects(db.query('insert into public.comparisons(exit_photo_id,entry_photo_id) values($1,$2)',[X,EB]));
      assert.equal((await begin(crypto.randomUUID(),B)).action,'forbidden');
      assert.equal((await begin(crypto.randomUUID(),A,E)).action,'invalid_stage');
      await db.exec('set role authenticated');
      await assert.rejects(begin(crypto.randomUUID()));
      await db.exec('reset role');
    });

    await t.test('entry reservations consume comparison budget and comparison consumes entry budget', async () => {
      const entryRequest=crypto.randomUUID();
      await db.query('select public.begin_photo_analysis($1,$2,$3)',[A,E,entryRequest]);
      const first=(await db.query('select public.reserve_photo_ai_attempt($1,$2,$3,$4,$5) as r',[A,E,entryRequest,entryRequest,2])).rows[0].r;
      assert.equal(first.action,'reserved');
      await db.query('select public.finish_photo_ai_attempt($1,$2,$3,null,$4,true,$5)',[A,E,entryRequest,'AI_TIMEOUT','gpt-5.4-mini']);
      const compareRequest=crypto.randomUUID();
      assert.equal((await begin(compareRequest)).action,'acquired');
      assert.equal((await begin(crypto.randomUUID())).action,'busy');
      assert.equal((await reserve(compareRequest,compareRequest,2)).action,'reserved');
      await finish(compareRequest,null,'AI_TIMEOUT',false);
      assert.equal((await reserve(compareRequest,crypto.randomUUID(),2)).action,'limit');
      assert.equal((await finish(compareRequest,null,'AI_DAILY_LIMIT')).analysis.status,'failed');
      const secondEntry=crypto.randomUUID();
      await db.query('select public.begin_photo_analysis($1,$2,$3)',[A,E,secondEntry]);
      assert.equal((await db.query('select public.reserve_photo_ai_attempt($1,$2,$3,$4,$5) as r',[A,E,secondEntry,secondEntry,2])).rows[0].r.action,'limit');
      const counts=(await db.query('select task_type,count(*)::int as n from public.ai_request_logs where attempted_at is not null group by task_type')).rows;
      assert.deepEqual(Object.fromEntries(counts.map((r)=>[r.task_type,r.n])),{photo_analysis:1,photo_comparison:1});
    });

    await t.test('retry reservations are exclusive; ended attempts cannot be reused; results are conditional and cached', async () => {
      await db.exec("update public.ai_request_logs set attempted_at=attempted_at-interval '2 days' where attempted_at is not null");
      const one=crypto.randomUUID();
      await begin(one);
      assert.equal((await reserve(one,one)).action,'reserved');
      assert.equal((await reserve(one,one)).action,'reserved');
      for (const state of ['failed','completed']) {
        await db.query('update public.ai_request_logs set status=$1 where request_id=$2',[state,one]);
        assert.equal((await reserve(one,one)).action,'superseded');
      }
      await db.query("update public.ai_request_logs set status='analyzing' where request_id=$1",[one]);
      await finish(one,null,'AI_TIMEOUT',false);
      const two=crypto.randomUUID();
      assert.equal((await reserve(one,two)).action,'reserved');
      assert.equal((await finish(one,{overall_result:'no_visible_change',changes:[]},null)).action,'superseded');
      const saved=await finish(two,{overall_result:'no_visible_change',changes:[]},null);
      assert.equal(saved.analysis.status,'completed');
      assert.equal(saved.analysis.entry_photo_id,E);
      assert.equal(saved.analysis.exit_photo_id,X);
      const before=(await db.query('select count(*)::int as n from public.ai_request_logs')).rows[0].n;
      assert.equal((await begin(crypto.randomUUID())).action,'completed');
      assert.equal((await db.query('select count(*)::int as n from public.ai_request_logs')).rows[0].n,before);
    });

    await t.test('stale comparison can recover; previous request cannot overwrite; RLS hides rows from B', async () => {
      await db.exec(`update public.comparisons set status='analyzing',started_at=clock_timestamp()-interval '4 minutes' where exit_photo_id='${X}'`);
      const previous=(await db.query('select active_request_id from public.comparisons')).rows[0].active_request_id;
      const current=crypto.randomUUID();
      assert.equal((await begin(current)).action,'acquired');
      assert.equal((await finish(previous)).action,'superseded');
      assert.equal((await finish(current,null,'AI_IMAGE_FETCH_FAILED')).analysis.status,'failed');
      assert.equal((await db.query('select attempted_at from public.ai_request_logs where request_id=$1',[current])).rows[0].attempted_at,null);
      await db.exec(`set role authenticated; set request.jwt.claim.sub='${B}'`);
      assert.equal((await db.query('select * from public.comparisons')).rows.length,0);
      assert.equal((await db.query('select * from public.ai_request_logs')).rows.length,0);
      await db.exec('reset role');
    });
  } finally { await db.close(); }
});
