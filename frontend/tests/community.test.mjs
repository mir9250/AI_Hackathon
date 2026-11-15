import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { JSDOM } from 'jsdom';
import { mountCommunity } from '../src/community.js';

const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
test('community persists shared posts/comments with owner writes, no anonymous access and bounded content', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
      grant usage on schema auth, public to authenticated, anon;
      insert into auth.users values ('${A}'), ('${B}');`);
    await db.exec(await readFile(new URL('../../supabase/migrations/20261115175657_community_posts_comments.sql', import.meta.url), 'utf8'));
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${A}';`);
    const post = (await db.query("insert into community_posts(title, body) values ('질문','누수') returning *")).rows[0];
    assert.equal(post.user_id, A);
    await assert.rejects(db.query('insert into community_posts(user_id,title,body) values ($1, $2, $3)', [B, '제목', '내용']));
    await assert.rejects(db.query("insert into community_posts(title, body) values (' ', '내용')"));
    await assert.rejects(db.query("insert into community_posts(title, body) values ('제목', $1)", ['가'.repeat(5001)]));
    await db.exec(`set request.jwt.claim.sub='${B}';`);
    assert.equal((await db.query('select * from community_posts')).rows.length, 1);
    assert.equal((await db.query('delete from community_posts returning *')).rows.length, 0);
    await assert.rejects(db.query("update community_posts set body='변조'"));
    const comment = (await db.query('insert into community_comments(post_id,body) values ($1,$2) returning *',[post.id,'점검을 요청하세요'])).rows[0];
    await db.exec(`set request.jwt.claim.sub='${A}';`);
    assert.equal((await db.query('delete from community_comments returning *')).rows.length, 0);
    assert.equal((await db.query('select * from community_comments')).rows[0].id, comment.id);
    await db.query('delete from community_posts where id=$1',[post.id]);
    assert.equal((await db.query('select * from community_comments')).rows.length, 0);
    await db.exec('reset role; set role anon;');
    await assert.rejects(db.query('select * from community_posts'));
  } finally { await db.close(); }
});

test('renders post payload as text and cleanup removes late UI', async () => {
  const dom = new JSDOM('<main></main>');
  global.document = dom.window.document; global.window = dom.window;
  const payload = '<img src=x onerror=alert(1)>';
  const chain = { select(){ return this; }, order(){ return this; }, range: async () => ({ data: [{id:'post', user_id:B,title:payload,body:payload,created_at:new Date().toISOString()}] }) };
  const client = { auth:{getUser:async()=>({data:{user:{id:A}}})}, from:()=>chain };
  const dispose = mountCommunity(document.querySelector('main'),client);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(document.querySelector('.community-post h3').textContent,payload);
  assert.equal(document.querySelectorAll('.community-post img').length,0);
  dispose(); assert.equal(document.querySelector('.community'),null);
  dom.window.close(); delete global.document; delete global.window;
});
