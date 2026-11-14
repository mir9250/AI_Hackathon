import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseAccountApi } from '../src/supabase-account.js';

test('direct account adapter verifies user and ignores caller ownership', async () => {
  let saved, filter;
  const query = { select() { return this; }, eq(key,value) { filter=[key,value]; return this; }, abortSignal() { return this; }, async maybeSingle() { return { data: saved || { user_id:'A', display_name:'old' } }; } };
  const client = { auth: { getUser: async () => ({ data:{ user:{id:'A'} } }) }, from(table) {
    assert.equal(table,'profiles');
    return { ...query, upsert(values, options) { saved=values; assert.equal(options.onConflict,'user_id'); return query; } };
  } };
  const api = createSupabaseAccountApi(client);
  await api('/api/profile'); assert.deepEqual(filter,['user_id','A']);
  await api('/api/profile',{method:'PUT',body:{display_name:' name ',user_id:'B'}});
  assert.deepEqual(saved,{display_name:'name',user_id:'A'});
  await assert.rejects(api('/api/living-records',{method:'POST'}),/서버 연결/);
  client.auth.getUser=async()=>({data:{user:null},error:new Error()});
  await assert.rejects(api('/api/profile'),/로그인/);
});
