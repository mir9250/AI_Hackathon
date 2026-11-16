import { createApi } from './api.js';
import { mountContracts } from './contracts.js';
import { mountMoveOut } from './moveout.js';
import { mountPhotos } from './photos.js';
import { mountHomeCare } from './home-care.js';
import { mountCommunity } from './community.js';
import { mountLiving } from './living.js';
import { accountMarkup } from './ui.js';

export function mountApp(root, env, createClient, apiOverride = null) {
root.innerHTML = `<header><a class="brand" href="#"><img src="/logo-brown.png" alt="" class="brand-logo"> <span>돌려받집</span></a>
  <span class="header-note">안심할 수 있는 집의 시작</span><nav class="main-nav" aria-label="주요 메뉴" hidden><button type="button" data-go="home">홈</button><button type="button" data-go="records">내 집 기록</button><button type="button" data-go="contracts">계약서</button><button type="button" data-go="community">커뮤니티</button></nav><button id="mypage" class="quiet" hidden>마이페이지</button><button id="logout" class="quiet" hidden>로그아웃</button></header>
  <main><div id="message" role="status" aria-live="polite"></div>
  <p id="slow" class="notice" hidden>서버를 깨우고 있습니다. 첫 연결에는 시간이 걸릴 수 있습니다.</p>
  <div id="view"></div></main><footer>내 집의 상태를 기록하고, 보증금을 지키는 첫걸음.<br>
  AI 결과는 참고 정보이며 법률적 판단이나 손상 원인을 확정하지 않습니다.</footer>`;

const view = document.querySelector('#view');
const message = document.querySelector('#message');
const logout = document.querySelector('#logout');


function notify(text, isError = false) {
  message.textContent = text;
  message.className = text ? (isError ? 'message error' : 'message') : '';
  message.setAttribute('role', isError ? 'alert' : 'status');
}

function validOrigin(value, localAllowed = true) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
      && (url.protocol === 'https:' || (localAllowed && url.protocol === 'http:'
        && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch { return false; }
}

if (!validOrigin(env.VITE_API_BASE_URL) || !validOrigin(env.VITE_SUPABASE_URL)
    || !env.VITE_SUPABASE_PUBLISHABLE_KEY) {
  view.innerHTML = `<section class="card"><h1>연결 설정이 필요합니다</h1>
    <p>frontend/.env.example을 .env로 복사하고 API 주소와 Supabase 공개 연결 정보를 설정한 후 개발 서버를 다시 시작해 주세요.</p></section>`;
} else {
  start();
}

function start() {
  const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const api = apiOverride || createApi({ baseUrl: env.VITE_API_BASE_URL.replace(/\/$/, ''), auth: supabase.auth,
    onSlow: (slow) => { document.querySelector('#slow').hidden = !slow; } });
  let userId = null;
  let generation = 0;
  let controller;
  let profile = null;
  let house = null;
  let disposePhotos;
  let disposeMoveOut;
  let disposeContracts;
  let disposeLiving;
  let disposeCommunity;
  let showPageRef = null;

  function invalidate() {
    disposeCommunity?.();
    disposeCommunity = undefined;
    disposeLiving?.();
    disposeLiving = undefined;
    disposeContracts?.();
    disposeContracts = undefined;
    disposeMoveOut?.();
    disposeMoveOut = undefined;
    disposePhotos?.();
    disposePhotos = undefined;
    generation += 1;
    controller?.abort();
    controller = new AbortController();
    return generation;
  }

  function authView(signup = false) {
    userId = null;
    profile = house = null;
    invalidate();
    logout.hidden = true;
    document.querySelector('#mypage').hidden = true;
    root.querySelector('.main-nav').hidden = true;
    view.dataset.page = 'auth';
    view.innerHTML = `<div class="auth-layout"><section class="intro"><span class="eyebrow">DEPOSIT GUARDIAN</span>
      <h1>소중한 보증금,<br>기록으로 지켜요.</h1><p>계약부터 퇴실까지.<br>나의 집을 위한 꼼꼼한 준비를 시작하세요.</p>
      <span class="intro-caption">오늘의 기록이 내일의 안심으로</span></section>
      <section class="card auth-card"><span class="step">나의 공간 시작하기</span><h2>${signup ? '회원가입' : '로그인'}</h2>
      <form id="auth-form"><label for="email">이메일</label><input id="email" name="email" type="email" required autocomplete="email">
      <label for="password">비밀번호</label><input id="password" name="password" type="password" required
        autocomplete="${signup ? 'new-password' : 'current-password'}">
      ${signup ? '<p class="hint">Supabase 프로젝트에 설정된 비밀번호 정책이 적용됩니다.</p>' : ''}
      <button type="submit">${signup ? '회원가입' : '로그인'}</button></form>
      <button id="switch-auth" class="text-button">${signup ? '이미 계정이 있나요? 로그인' : '처음 오셨나요? 회원가입'}</button>
      </section></div>`;
    document.querySelector('#switch-auth').onclick = () => { notify(''); authView(!signup); };
    document.querySelector('#auth-form').onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      button.disabled = true;
      const current = generation;
      const values = new FormData(form);
      notify('');
      try {
        const credentials = { email: values.get('email').trim(), password: values.get('password') };
        const result = signup
          ? await supabase.auth.signUp({ ...credentials, options: { emailRedirectTo: window.location.origin } })
          : await supabase.auth.signInWithPassword(credentials);
        if (result.error) throw result.error;
        if (signup && !result.data.session && current === generation) {
          form.reset();
          notify('이메일 확인이 필요합니다. 받은 편지함의 확인 링크를 누른 후 로그인해 주세요.');
        }
      } catch (error) {
        if (current === generation) notify(authError(error), true);
      } finally { button.disabled = false; }
    };
  }

  async function loadAccount() {
    const current = invalidate();
    view.dataset.page = 'loading';
    view.innerHTML = '<section class="card"><p role="status">저장된 정보를 불러오고 있습니다…</p></section>';
    try {
      const values = await Promise.all([
        api('/api/profile', { signal: controller.signal }),
        api('/api/house', { signal: controller.signal }),
      ]);
      if (current !== generation) return;
      [profile, house] = values;
      renderAccount();
    } catch (error) {
      if (current !== generation || error.name === 'AbortError') return;
      showApiError(error);
      view.innerHTML = '<section class="card"><h2>기록을 불러오지 못했습니다</h2><button id="reload">다시 조회</button></section>';
      document.querySelector('#reload').onclick = loadAccount;
    }
  }

  const ICON = {
    camera: '<path d="M5 7h1a2 2 0 0 0 2-2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1a2 2 0 0 0 2 2h1a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2"/><circle cx="12" cy="13" r="3"/>',
    tool: '<path d="M7 10h3v-3l-3.5-3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1-3 3l-6-6a6 6 0 0 1-8-8z"/>',
    compare: '<rect x="3" y="5" width="8" height="14" rx="2"/><rect x="13" y="5" width="8" height="14" rx="2"/><path d="M7 9v6M17 9v6"/>',
    file: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 13h6M9 17h6"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
  const journeyButton = (id, icon, title, desc) => `<button id="${id}" class="journey-card" ${house || id === 'open-living' ? '' : 'disabled'}><span class="journey-icon">${svg(icon)}</span><span class="journey-title">${title}</span><span class="journey-desc">${desc}</span><span class="journey-go" aria-hidden="true">바로가기 →</span></button>`;

  // 화면 전환: 홈 · 기능 페이지 · 커뮤니티 · 마이페이지 중 하나만 보여 줍니다.
  function setPage(page) {
    view.dataset.page = page;
    const tab = { home: 'home', photos: 'records', living: 'records', moveout: 'records', contracts: 'contracts', community: 'community' }[page];
    for (const item of root.querySelectorAll('.main-nav [data-go]')) {
      if (item.dataset.go === tab) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    }
    for (const id of ['photos', 'living', 'moveout', 'contracts']) {
      document.querySelector(`#open-${id}`)?.classList.toggle('is-active', page === id);
    }
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
  }

  async function renderProgress() {
    const card = document.querySelector('#progress-card');
    if (!card) return;
    const current = generation;
    const paint = (stage, title, percent, next, stepIndex) => {
      card.querySelector('.progress-stage').textContent = stage;
      card.querySelector('.progress-title').textContent = title;
      card.querySelector('.progress-fill').style.width = `${percent}%`;
      card.querySelector('.progress-next-text').textContent = next;
      card.querySelectorAll('.progress-steps li').forEach((li, index) => li.classList.toggle('is-current', index === stepIndex));
    };
    if (!house) { paint('시작 전', '나의 집을 먼저 등록해 주세요', 4, '나의 집 등록·관리에서 주소를 저장해요', -1); return; }
    paint(house.name || '나의 집', '지금은 입실 단계예요', 15, '입실 사진부터 올려 보세요', 0);
    try {
      const [entry, exit] = await Promise.all([
        api('/api/move-in/photos', { signal: controller.signal }),
        api('/api/move-out/photos', { signal: controller.signal }),
      ]);
      if (current !== generation) return;
      const entryCount = Array.isArray(entry) ? entry.length : 0;
      const exitCount = Array.isArray(exit) ? exit.length : 0;
      if (exitCount) paint(house.name || '나의 집', '지금은 퇴실 단계예요', 90, `퇴실 사진 ${exitCount}장 · 입실 사진과 비교해 보세요`, 2);
      else if (entryCount) paint(house.name || '나의 집', '지금은 거주 중이에요', 55, `입실 사진 ${entryCount}장 저장됨 · 문제가 생기면 바로 기록해요`, 1);
    } catch { /* 진행 현황은 참고용이라 실패해도 화면을 막지 않습니다. */ }
  }

  function renderAccount() {
    document.querySelector('#mypage').setAttribute('aria-expanded', 'false');
    view.innerHTML = `<section id="account-view" hidden>${accountMarkup(profile, house)}<h2>나의 기록</h2><p>아래에서 저장된 입실·퇴실 사진과 계약서를 조회할 수 있어요.</p><div class="record-links"><button id="record-entry" class="quiet">입실 기록 보기</button> <button id="record-exit" class="quiet">퇴실 기록 보기</button> <button id="record-contract" class="quiet">계약서 보기</button> <button id="record-living" class="quiet">거주 중 기록 보기</button></div></section>`
      + `<section id="home-heading" class="hero"><div class="hero-text"><span class="hero-badge">보증금 지킴이 · AI 기록 도우미</span><h1>살 때부터 나갈 때까지,<br>돌려받집과 함께</h1><p>입실 사진부터 계약서까지, 오늘 남긴 기록으로 <br>내일의 보증금을 지켜요.</p><div class="hero-actions"><button id="hero-start" class="primary">입실 사진 등록 시작하기 <span aria-hidden="true">→</span></button><button id="setup-house" class="quiet">나의 집 등록·관리</button></div></div>`
      + `<aside id="progress-card" class="progress-card" aria-label="나의 진행 현황"><div class="progress-head"><span>나의 진행 현황</span><span class="progress-stage"></span></div><p class="progress-title"></p><div class="progress-bar"><span class="progress-fill"></span></div><ol class="progress-steps"><li>입실</li><li>거주 중</li><li>퇴실</li></ol><p class="progress-next"><b>다음 할 일</b> <span class="progress-next-text"></span></p></aside></section>`
      + `<nav class="photo-nav" aria-label="기록 메뉴">${journeyButton('open-photos', 'camera', '입실 사진 등록·조회', '이사 첫날 집 상태를 사진으로 남기고 AI가 하자를 찾아줘요')}${journeyButton('open-living', 'tool', '거주 중 문제 대처', '곰팡이·누수처럼 살면서 생긴 문제를 기록하고 대처법을 확인해요')}${journeyButton('open-moveout', 'compare', '퇴실 사진 등록·비교', '입실 사진과 나란히 비교해 보증금 분쟁에 대비해요')}${journeyButton('open-contracts', 'file', '계약서 분석', '계약서를 올리면 놓치기 쉬운 특약과 위험 조항을 짚어줘요')}</nav>`
      + `<div id="living-view" class="feature-page" hidden></div><div id="photos-view" class="feature-page" hidden></div><div id="moveout-view" class="feature-page" hidden></div><div id="contracts-view" class="feature-page" hidden></div>`;
    const navigation = view.querySelector('.photo-nav');
    const launcher = document.createElement('section');
    launcher.className = 'record-launcher';
    launcher.setAttribute('aria-label', '집 관리 질문과 기록');
    launcher.innerHTML = '<h2 class="launcher-title">무엇을 도와드릴까요?</h2>';
    launcher.append(navigation);
    mountHomeCare(launcher);
    document.querySelector('#home-heading').after(launcher);
    disposeCommunity?.();
    disposeCommunity = mountCommunity(view, supabase);
    const communitySection = view.querySelector('.community');
    if (communitySection) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'community-more quiet';
      more.textContent = '커뮤니티 전체 보기 →';
      more.onclick = () => showPage('community');
      communitySection.append(more);
    }
    const panels = ['photos', 'moveout', 'contracts', 'living'];
    const hidePanels = () => { for (const id of panels) document.querySelector(`#${id}-view`).hidden = true; };
    const showHome = () => {
      document.querySelector('#account-view').hidden = true;
      document.querySelector('#home-heading').hidden = false;
      document.querySelector('#mypage').setAttribute('aria-expanded', 'false');
      hidePanels();
      setPage('home');
    };
    function showPage(page) {
      if (page === 'home') { showHome(); return; }
      if (page === 'community') {
        showHome();
        setPage('community');
        return;
      }
      if (page === 'records') { document.querySelector(house ? '#open-photos' : '#open-living').click(); return; }
      if (page === 'contracts') {
        if (house) document.querySelector('#open-contracts').click();
        else { toggleAccount(); notify('계약서를 등록하려면 나의 집을 먼저 등록해 주세요.'); }
      }
    }
    showPageRef = showPage;
    const toggleAccount = () => {
      const account = document.querySelector('#account-view');
      account.hidden = !account.hidden;
      document.querySelector('#home-heading').hidden = !account.hidden;
      hidePanels();
      document.querySelector('#mypage').setAttribute('aria-expanded', String(!account.hidden));
      setPage(account.hidden ? 'home' : 'account');
    };
    document.querySelector('#mypage').onclick = toggleAccount;
    document.querySelector('#setup-house').onclick = toggleAccount;
    document.querySelector('#hero-start').onclick = () => {
      if (house) document.querySelector('#open-photos').click();
      else { toggleAccount(); notify('입실 사진을 올리려면 나의 집을 먼저 등록해 주세요.'); }
    };
    for (const [id, target] of [['entry','photos'],['exit','moveout'],['contract','contracts'],['living','living']]) {
      document.querySelector(`#record-${id}`).onclick = () => document.querySelector(`#open-${target}`).click();
    }
    const openPanel = (id, mount, refreshEvent) => {
      document.querySelector('#account-view').hidden = true;
      document.querySelector('#mypage').setAttribute('aria-expanded', 'false');
      hidePanels();
      const target = document.querySelector(`#${id}-view`);
      target.hidden = false;
      setPage(id);
      return target;
    };
    document.querySelector('#open-living').onclick = () => {
      const target = openPanel('living');
      if (!disposeLiving) disposeLiving = mountLiving(target, api, controller.signal);
      else target.dispatchEvent(new window.Event('refresh-living'));
    };
    document.querySelector('#open-photos').onclick = () => {
      const target = openPanel('photos');
      if (!disposePhotos) disposePhotos = mountPhotos(target, api, controller.signal);
    };
    document.querySelector('#open-moveout').onclick = () => {
      const target = openPanel('moveout');
      if (!disposeMoveOut) disposeMoveOut = mountMoveOut(target, api, controller.signal);
      else target.dispatchEvent(new window.Event('refresh-moveout'));
    };
    document.querySelector('#open-contracts').onclick = () => {
      const target = openPanel('contracts');
      if (!disposeContracts) disposeContracts = mountContracts(target, api, controller.signal);
      else target.dispatchEvent(new window.Event('refresh-contracts'));
    };
    setPage('home');
    renderProgress();
    for (const [kind, path] of [['profile', '/api/profile'], ['house', '/api/house']]) {
      document.querySelector(`#${kind}-form`).onsubmit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button');
        const current = generation;
        const body = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]));
        if (Object.values(body).some((value) => !value)) { notify('공백만 입력할 수 없습니다.', true); return; }
        button.disabled = true;
        notify('저장 중입니다…');
        try {
          const result = await api(path, { method: 'PUT', body, signal: controller.signal });
          if (current !== generation) return;
          if (kind === 'profile') profile = result; else house = result;
          // Update only this form, preserving unsaved edits in the other form.
          const time = form.querySelector('.save-time');
          const updated = document.createElement('div');
          updated.innerHTML = accountMarkup(profile, house);
          time.textContent = updated.querySelector(`#${kind}-form .save-time`).textContent;
          if (kind === 'house') {
            view.querySelector('.notice').textContent = '주택 정보가 등록되었습니다. 입실 사진을 등록할 수 있습니다.';
            document.querySelector('#open-photos').disabled = false;
            document.querySelector('#open-moveout').disabled = false;
            document.querySelector('#open-contracts').disabled = false;
            renderProgress();
          }
          notify('저장했습니다.');
        } catch (error) {
          if (current === generation && error.name !== 'AbortError') showApiError(error);
        } finally { button.disabled = false; }
      };
    }
  }

  function showApiError(error) {
    notify(`${error.message}${error.retryable ? ' 잠시 후 다시 시도할 수 있습니다.' : ''}${error.status === 401 ? ' 로그아웃 후 다시 로그인해 주세요.' : ''}`, true);
  }

  root.querySelector('.brand').onclick = event => {
    event.preventDefault();
    notify('');
    if (userId) {
      loadAccount();
    } else authView();
    window.scrollTo?.({ top: 0, behavior: 'smooth' });
  };

  for (const item of root.querySelectorAll('.main-nav [data-go]')) {
    item.onclick = () => { notify(''); showPageRef?.(item.dataset.go); };
  }

  logout.onclick = async () => {
    logout.disabled = true;
    try {
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
      notify('로그아웃했습니다.');
    } catch { notify('로그아웃하지 못했습니다. 다시 시도해 주세요.', true); }
    finally { logout.disabled = false; }
  };

  // Keep callbacks synchronous: SDK auth callbacks must not await other SDK calls.
  supabase.auth.onAuthStateChange((event, session) => {
    if (!session) { authView(); return; }
    logout.hidden = false;
    document.querySelector('#mypage').hidden = false;
    root.querySelector('.main-nav').hidden = false;
    if (userId !== session.user.id) {
      profile = house = null;
      userId = session.user.id;
      notify('');
      setTimeout(() => { if (userId === session.user.id) loadAccount(); }, 0);
    }
  });
  view.innerHTML = '<section class="card"><p role="status">로그인 상태를 확인하고 있습니다…</p></section>';
}

function authError(error) {
  if (error.code === 'email_not_confirmed') return '이메일 확인이 필요합니다. 받은 편지함의 확인 링크를 확인해 주세요.';
  if (error.status === 429 || error.code === 'over_email_send_rate_limit') return '인증 이메일 또는 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  if (error.code === 'invalid_credentials') return '이메일 또는 비밀번호를 확인해 주세요.';
  if (error.code === 'weak_password') return 'Supabase 프로젝트의 비밀번호 정책에 맞는 비밀번호를 입력해 주세요.';
  return '인증 요청에 실패했습니다. 입력 정보와 네트워크를 확인해 주세요.';
}

}
