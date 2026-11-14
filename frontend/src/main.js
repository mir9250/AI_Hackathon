import { createClient } from '@supabase/supabase-js';
import { mountApp } from './app.js';
import './style.css';
import { createSupabaseAccountApi } from './supabase-account.js';
import { mountPreview } from './preview.js';

if (import.meta.env.VITE_UI_PREVIEW === 'true') {
  mountPreview(document.querySelector('#app'));
} else if (import.meta.env.VITE_ACCOUNT_DIRECT === 'true') {
  const client = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY);
  mountApp(document.querySelector('#app'), { ...import.meta.env, VITE_API_BASE_URL: import.meta.env.VITE_SUPABASE_URL }, () => client, createSupabaseAccountApi(client));
  const notice = document.createElement('aside');
  notice.className = 'preview-banner';
  notice.textContent = 'Supabase 연결 · 로그인·프로필·나의 집 저장을 사용할 수 있습니다. 사진·계약서·AI 서버는 연결 준비 중입니다.';
  document.querySelector('#app').prepend(notice);
} else {
  mountApp(document.querySelector('#app'), import.meta.env, createClient);
}
