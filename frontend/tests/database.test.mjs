import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const H1 = '33333333-3333-4333-8333-333333333333';
const H2 = '44444444-4444-4444-8444-444444444444';
const P1 = '55555555-5555-4555-8555-555555555555';
const P2 = '66666666-6666-4666-8666-666666666666';
const C1 = '77777777-7777-4777-8777-777777777777';

test('migration executes; nine tables, ownership RLS and integrity constraints work locally', async (t) => {
  const db = new PGlite();
  try {
    // Minimal test fixtures for Supabase-managed schemas. Not a Supabase emulator.
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to authenticated, anon, service_role;
      grant execute on function auth.uid() to authenticated, anon, service_role;
      create schema storage;
      create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
      insert into auth.users values ('${A}'), ('${B}');
    `);
    const migration = await readFile(new URL('../../supabase/migrations/202611140001_initial.sql', import.meta.url), 'utf8');
    await db.exec(migration);

    await t.test('all tables enable RLS and bucket stays private', async () => {
      const result = await db.query("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'");
      assert.equal(result.rows.length, 9);
      assert.ok(result.rows.every((row) => row.relrowsecurity));
      assert.equal((await db.query('select public from storage.buckets')).rows[0].public, false);
    });

    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${A}';`);
    await t.test('create and upsert own profile, preserve timestamps', async () => {
      await db.query('insert into public.profiles(user_id, display_name) values ($1, $2)', [A, '세입자']);
      const before = (await db.query('select created_at from public.profiles')).rows[0].created_at;
      await db.query(`insert into public.profiles(user_id, display_name) values ($1, $2)
        on conflict(user_id) do update set display_name = excluded.display_name`, [A, '새 이름']);
      const row = (await db.query('select * from public.profiles')).rows[0];
      assert.equal(row.display_name, '새 이름');
      assert.equal(+row.created_at, +before);
    });

    await t.test('cross-user read, insert and owner change are blocked', async () => {
      await db.exec(`set request.jwt.claim.sub = '${B}';`);
      assert.equal((await db.query('select * from public.profiles')).rows.length, 0);
      await assert.rejects(db.query('insert into public.profiles values ($1, $2, now(), now())', [A, '침입자']));
      assert.equal((await db.query('update public.profiles set display_name = $1 returning *', ['침입자'])).rows.length, 0);
      await db.exec(`set request.jwt.claim.sub = '${A}';`);
      await assert.rejects(db.query('update public.profiles set user_id = $1', [B]));
    });

    await t.test('only one house per user and stable identity on upsert', async () => {
      await db.query('insert into public.houses(house_id,user_id,name,address) values ($1,$2,$3,$4)', [H1,A,'내 집','서울']);
      await assert.rejects(db.query('insert into public.houses(user_id,name,address) values ($1,$2,$3)', [A,'두 번째 집','부산']));
      await db.query(`insert into public.houses(user_id,name,address) values ($1,$2,$3)
        on conflict(user_id) do update set name=excluded.name, address=excluded.address`, [A,'새 별칭','인천']);
      assert.equal((await db.query('select * from public.houses')).rows[0].house_id, H1);
      await db.exec(`set request.jwt.claim.sub = '${B}';`);
      assert.equal((await db.query('select * from public.houses')).rows.length, 0);
      await db.exec(`reset role;`);
      await db.query('insert into public.houses(house_id,user_id,name,address) values ($1,$2,$3,$4)', [H2,B,'B 집','부산']);
    });

    const photo = async (id, house, stage, pair, upload = crypto.randomUUID()) => db.query(`
      insert into public.photos(photo_id, house_id, stage, location, original_path, mime_type, size_bytes, upload_id, paired_entry_photo_id)
      values ($1,$2,$3,'거실',$4,'image/jpeg',100,$5,$6)`, [id,house,stage,`${id}.jpg`,upload,pair]);

    await t.test('photo pairing enforces house, stage and uniqueness', async () => {
      await photo(P1,H1,'entry',null);
      await assert.rejects(photo(crypto.randomUUID(),H2,'exit',P1));
      await photo(P2,H1,'exit',P1);
      await assert.rejects(photo(crypto.randomUUID(),H1,'exit',P1));
      await assert.rejects(photo(crypto.randomUUID(),H1,'exit',P2));
      await assert.rejects(db.query("update public.photos set stage='exit', paired_entry_photo_id=$1 where photo_id=$2", [P2,P1]));
      await assert.rejects(db.query('insert into public.analyses(photo_id) values ($1)', [P2]));
      await db.query('insert into public.analyses(photo_id) values ($1)', [P1]);
      await db.query('insert into public.comparisons(exit_photo_id,entry_photo_id) values ($1,$2)', [P2,P1]);
    });

    await t.test('upload ID is unique per house', async () => {
      const upload = crypto.randomUUID();
      await photo(crypto.randomUUID(),H1,'entry',null,upload);
      await assert.rejects(photo(crypto.randomUUID(),H1,'entry',null,upload));
    });

    await t.test('contract pages must be unique, sequential and complete', async () => {
      await db.query("insert into public.contracts(contract_id,house_id,source_type,upload_id) values ($1,$2,'images',$3)", [C1,H1,crypto.randomUUID()]);
      const page = (number) => db.query(`insert into public.contract_pages(contract_id,page_number,original_path,mime_type,size_bytes)
        values ($1,$2,$3,'image/jpeg',100)`, [C1,number,`${C1}/${number}`]);
      await page(1);
      await assert.rejects(page(1));
      await page(3);
      await assert.rejects(db.query("update public.contracts set upload_status='ready',page_count=2 where contract_id=$1",[C1]));
      await page(2);
      await db.query("update public.contracts set upload_status='ready',page_count=3 where contract_id=$1",[C1]);
      await assert.rejects(page(4));
      await assert.rejects(db.query("insert into public.contract_analyses(contract_id,status,document_quality,summary,consent_at) values ($1,'completed','unreadable','{}',now())",[C1]));
    });

    await t.test('contract PDF slots are conditional and completed documents reject page writes', async () => {
      const pdf = crypto.randomUUID();
      await db.query("insert into public.contracts(contract_id,house_id,source_type,upload_id) values($1,$2,'pdf',$3)", [pdf,H1,crypto.randomUUID()]);
      await assert.rejects(db.query("update public.contracts set upload_status='ready',page_count=1 where contract_id=$1",[pdf]));
      const first = await db.query("update public.contracts set original_path='first.pdf',page_count=1 where contract_id=$1 and upload_status='draft' and original_path is null returning contract_id",[pdf]);
      assert.equal(first.rows.length,1);
      const second = await db.query("update public.contracts set original_path='second.pdf',page_count=2 where contract_id=$1 and upload_status='draft' and original_path is null returning contract_id",[pdf]);
      assert.equal(second.rows.length,0);
      await db.query("update public.contracts set upload_status='ready' where contract_id=$1 and upload_status='draft'",[pdf]);
      assert.equal((await db.query("update public.contracts set original_path='late.pdf' where contract_id=$1 and upload_status='draft' returning contract_id",[pdf])).rows.length,0);
      await assert.rejects(db.query("insert into public.contract_pages(contract_id,page_number,original_path,mime_type,size_bytes) values($1,1,'forbidden.png','image/png',100)",[pdf]));
      await db.exec(`set role authenticated; set request.jwt.claim.sub = '${A}';`);
      await assert.rejects(db.query("update public.contracts set upload_status='draft' where contract_id=$1",[pdf]));
      await assert.rejects(db.query("insert into public.contract_pages(contract_id,page_number,original_path,mime_type,size_bytes) values($1,1,'browser.png','image/png',100)",[C1]));
      await db.exec('reset role');
    });

    await t.test('nested photo and contract policies isolate all related records', async () => {
      await db.exec(`set role authenticated; set request.jwt.claim.sub = '${B}';`);
      for (const table of ['photos','analyses','comparisons','contracts','contract_pages','contract_analyses','ai_request_logs']) {
        assert.equal((await db.query(`select * from public.${table}`)).rows.length,0,table);
      }
      await db.exec(`set request.jwt.claim.sub = '${A}';`);
      assert.ok((await db.query('select * from public.photos')).rows.length >= 2);
      assert.equal((await db.query('select * from public.contract_pages')).rows.length,3);
      await assert.rejects(db.query("insert into public.analyses(photo_id) values ($1)",[crypto.randomUUID()]));
      await db.exec('reset role; set role anon;');
      await assert.rejects(db.query('select * from public.houses'));
      await db.exec('reset role;');
    });
  } finally { await db.close(); }
});
