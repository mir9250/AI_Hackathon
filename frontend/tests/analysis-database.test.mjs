import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const H = '33333333-3333-4333-8333-333333333333';
const P = '55555555-5555-4555-8555-555555555555';

test('AI SQL: ownership, reservations, KST quota, retries, stale recovery and conditional save', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to authenticated, anon, service_role;
      grant execute on function auth.uid() to authenticated, anon, service_role;
      create schema storage;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
      insert into auth.users values ('${A}'), ('${B}');`);
    for (const name of ['202611140001_initial.sql','202611140002_photo_analysis.sql']) {
      await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    }
    await db.exec(`insert into public.houses(house_id,user_id,name,address) values ('${H}','${A}','demo','test');
      insert into public.photos(photo_id,house_id,stage,location,original_path,mime_type,size_bytes,upload_id)
      values ('${P}','${H}','entry','거실','demo.png','image/png',100,gen_random_uuid());`);
    const begin = async (user, request, photo=P) => (await db.query(
      'select public.begin_photo_analysis($1,$2,$3) as result', [user,photo,request])).rows[0].result;
    const reserve = async (active, attempt, limit=30) => (await db.query(
      'select public.reserve_photo_ai_attempt($1,$2,$3,$4,$5) as result', [A,P,active,attempt,limit])).rows[0].result;
    const finish = async (request, result, error=null, final=true) => (await db.query(
      'select public.finish_photo_ai_attempt($1,$2,$3,$4,$5,$6,$7) as result',
      [A,P,request,result,error,final,'gpt-5.4-mini'])).rows[0].result;
    const r1 = crypto.randomUUID();

    await t.test('user roles cannot call privileged functions; SQL rechecks ownership', async () => {
      await db.exec('set role authenticated');
      await assert.rejects(begin(A,crypto.randomUUID()));
      await db.exec('reset role');
      assert.equal((await begin(B,crypto.randomUUID())).action,'forbidden');
      assert.equal((await begin(A,crypto.randomUUID(),crypto.randomUUID())).action,'not_found');
      assert.equal((await db.query('select * from public.ai_request_logs')).rows.length,0);
    });

    await t.test('begin is exclusive; preparing a job does not count as an AI call', async () => {
      assert.equal((await begin(A,r1)).action,'acquired');
      assert.equal((await begin(A,crypto.randomUUID())).action,'busy');
      const logs = (await db.query('select * from public.ai_request_logs')).rows;
      assert.equal(logs.length,1);
      assert.equal(logs[0].status,'pending');
      assert.equal(logs[0].attempted_at,null);
      await assert.rejects(finish(r1,{overall_result:'none',damages:[]}));
    });

    await t.test('failed and completed attempts cannot be reused as active reservations', async () => {
      assert.equal((await reserve(r1,r1)).action,'reserved');
      for (const status of ['failed','completed']) {
        await db.query('update public.ai_request_logs set status=$1 where request_id=$2',[status,r1]);
        assert.equal((await reserve(r1,r1)).action,'superseded');
        assert.equal((await db.query('select status from public.ai_request_logs where request_id=$1',[r1])).rows[0].status,status);
      }
      // Restore the fixture to exercise a normal in-flight retry below.
      await db.query("update public.ai_request_logs set status='analyzing' where request_id=$1",[r1]);
    });

    await t.test('reservation is idempotent and records each retry; stale result cannot overwrite it', async () => {
      assert.equal((await reserve(r1,r1)).action,'reserved');
      assert.equal((await reserve(r1,r1)).action,'reserved');
      assert.equal((await db.query('select count(*)::int as n from public.ai_request_logs where attempted_at is not null')).rows[0].n,1);
      assert.equal((await finish(r1,null,'AI_TIMEOUT',false)).action,'saved');
      const r2 = crypto.randomUUID();
      assert.equal((await reserve(r1,r2)).action,'reserved');
      assert.equal((await finish(r1,{overall_result:'none',damages:[]})).action,'superseded');
      assert.equal((await finish(r2,{overall_result:'none',damages:[]})).analysis.status,'completed');
      assert.equal((await begin(A,crypto.randomUUID())).action,'completed');
      assert.equal((await db.query('select count(*)::int as n from public.ai_request_logs where attempted_at is not null')).rows[0].n,2);
    });

    await t.test('stale analyzing work is recoverable; old pending jobs remain uncharged', async () => {
      await db.exec(`update public.analyses set status='analyzing', started_at=clock_timestamp()-interval '4 minutes' where photo_id='${P}'`);
      const current = crypto.randomUUID();
      assert.equal((await begin(A,current)).action,'acquired');
      await finish(current,null,'AI_IMAGE_FETCH_FAILED');
      const row = (await db.query('select * from public.ai_request_logs where request_id=$1',[current])).rows[0];
      assert.equal(row.status,'failed');
      assert.equal(row.attempted_at,null);
      assert.equal((await reserve(current,crypto.randomUUID())).action,'superseded');
    });

    await t.test('KST day boundary, maximum 30 including retries, even if caller asks for a higher limit', async () => {
      await db.exec('delete from public.analyses; delete from public.ai_request_logs;');
      // Yesterday in KST must not count, even if the UTC date differs.
      await db.query(`insert into public.ai_request_logs(user_id,task_type,resource_id,status,attempted_at)
        values ($1,'photo_analysis',$2,'failed',
          (date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')-interval '1 second')`,[A,P]);
      for (let i=0;i<30;i++) {
        const id=crypto.randomUUID();
        assert.equal((await begin(A,id)).action,'acquired');
        assert.equal((await reserve(id,id,999)).action,'reserved');
        await finish(id,null,'AI_TIMEOUT');
      }
      const blocked=crypto.randomUUID();
      await begin(A,blocked);
      assert.equal((await reserve(blocked,blocked,999)).action,'limit');
      const ended = await finish(blocked,null,'AI_DAILY_LIMIT');
      assert.equal(ended.analysis.status,'failed');
      assert.equal(ended.analysis.error_code,'AI_DAILY_LIMIT');
      const blockedLog=(await db.query('select status,attempted_at from public.ai_request_logs where request_id=$1',[blocked])).rows[0];
      assert.equal(blockedLog.status,'failed');
      assert.equal(blockedLog.attempted_at,null);
      const usage=(await db.query(`select count(*)::int as n from public.ai_request_logs
        where attempted_at >= (date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')`)).rows[0].n;
      assert.equal(usage,30);
    });

    await t.test('AI states and logs remain invisible to another user', async () => {
      await db.exec(`set role authenticated; set request.jwt.claim.sub='${B}'`);
      assert.equal((await db.query('select * from public.analyses')).rows.length,0);
      assert.equal((await db.query('select * from public.ai_request_logs')).rows.length,0);
      await db.exec('reset role');
    });
  } finally { await db.close(); }
});
