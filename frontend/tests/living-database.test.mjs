import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('living records migration enforces private reads, privileged writes, and retry uniqueness', async () => {
  const db = new PGlite();
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const H = '33333333-3333-4333-8333-333333333333';
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema public, auth to anon, authenticated, service_role;
      create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint);
      insert into auth.users values ('${A}'), ('${B}');`);
    await db.exec(await readFile(new URL('../../supabase/migrations/202611140001_initial.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../../supabase/migrations/202611140006_living_records.sql', import.meta.url), 'utf8'));
    await db.exec(`insert into houses(house_id,user_id,name,address) values ('${H}','${A}','test','test'); set role service_role;`);
    const insert = () => db.query(`insert into living_records(house_id,category,description,original_path,mime_type,size_bytes,upload_id) values ($1,'mold','test','private/photo.png','image/png',50,$2)`, [H,A]);
    await insert();
    await assert.rejects(insert());
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${A}';`);
    assert.equal((await db.query('select * from living_records')).rows.length, 1);
    await assert.rejects(insert());
    await assert.rejects(db.query("update living_records set description = 'changed'"));
    await db.exec(`set request.jwt.claim.sub = '${B}';`);
    assert.equal((await db.query('select * from living_records')).rows.length, 0);
    await db.exec('set role anon;');
    await assert.rejects(db.query('select * from living_records'));
  } finally { await db.close(); }
});
