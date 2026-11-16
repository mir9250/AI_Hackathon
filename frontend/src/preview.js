import { mountApp } from './app.js';

// Read-only UI preview. Never contacts Auth, Storage, or the application API.
export function mountPreview(root) {
  const sampleHouse = { house_id: 'preview-house', name: '나의 첫 집', address: '미리보기용 주택 · 실제 주소가 아닙니다' };
  let listener;
  const auth = {
    onAuthStateChange(callback) {
      listener = callback;
      queueMicrotask(() => callback('INITIAL_SESSION', { user: { id: 'preview-user' } }));
    },
    async signOut() { listener('SIGNED_OUT', null); return {}; },
    async signInWithPassword() { throw new Error('Preview only'); },
    async signUp() { throw new Error('Preview only'); },
  };
  const api = async (path, options = {}) => {
    if (options.method && options.method !== 'GET') {
      throw new Error('지금은 화면 미리보기예요. 실제 저장과 AI 분석은 로그인한 뒤 사용할 수 있어요.');
    }
    if (path === '/api/profile') return { display_name: '미리보기 사용자' };
    if (path === '/api/house') return sampleHouse;
    return [];
  };
  mountApp(root, {
    VITE_API_BASE_URL: 'https://preview.invalid',
    VITE_SUPABASE_URL: 'https://preview.invalid',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'preview-only',
  }, () => ({ auth }), api);
  const banner = document.createElement('aside');
  banner.className = 'preview-banner';
  banner.textContent = '화면 미리보기 · 로그인 없이 둘러보세요. 사진·기록 저장과 AI 분석은 실제 서비스에서 사용할 수 있어요.';
  root.prepend(banner);
  const logout = root.querySelector('#logout');
  logout.textContent = '처음으로';
  logout.onclick = () => window.location.reload();
}
