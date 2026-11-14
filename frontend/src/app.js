import { createApi } from './api.js';
import { mountContracts } from './contracts.js';
import { mountMoveOut } from './moveout.js';
import { mountPhotos } from './photos.js';
import { mountLiving } from './living.js';
import { accountMarkup } from './ui.js';

export function mountApp(root, env, createClient, apiOverride = null) {
root.innerHTML = `<header><a class="brand" href="#"><img src="/logo.png" alt="" class="brand-logo"> <span>돌려받집</span></a>
  <span class="header-note">안심할 수 있는 집의 시작</span><button id="mypage" class="quiet" hidden>마이페이지</button><button id="logout" class="quiet" hidden>로그아웃</button></header>
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

  function invalidate() {
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
    view.innerHTML = `<div class="auth-layout"><section class="intro"><span class="eyebrow">DEPOSIT GUARDIAN</span>
      <h1>소중한 보증금,<br>기록으로 지켜요.</h1><p>계약부터 퇴실까지.<br>나의 집을 위한 꼼꼼한 준비를 시작하세요.</p>
      <div class="home-symbol" aria-hidden="true">⌂</div><span class="intro-caption">오늘의 기록이 내일의 안심으로</span></section>
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

  function renderAccount() {
    view.innerHTML = `<section id="account-view" hidden>${accountMarkup(profile, house)}<h2>나의 기록</h2><p>아래에서 저장된 입실·퇴실 사진과 계약서를 조회할 수 있어요.</p><button id="record-entry">입실 기록 보기</button> <button id="record-exit">퇴실 기록 보기</button> <button id="record-contract">계약서 보기</button> <button id="record-living">거주 중 기록 보기</button></section><section id="home-heading" class="section-heading"><h1>살 때부터 나갈 때까지,<br>돌려받집과 함께.</h1><p>오늘 남긴 기록으로 내일의 보증금을 준비하세요.</p><button id="setup-house" class="quiet">나의 집 등록·관리</button></section>` + `<nav class="photo-nav"><button id="open-photos" ${house ? '' : 'disabled'}>입실 사진 등록·조회</button><button id="open-living">거주 중 문제 대처</button><button id="open-moveout" ${house ? '' : 'disabled'}>퇴실 사진 등록·비교</button><button id="open-contracts" ${house ? '' : 'disabled'}>계약서 분석</button></nav><div id="living-view" hidden></div><div id="photos-view" hidden></div><div id="moveout-view" hidden></div><div id="contracts-view" hidden></div>`;
    const navigation = view.querySelector('.photo-nav');
    const launcher = document.createElement('section');
    launcher.className = 'record-launcher';
    launcher.setAttribute('aria-label', '기록 메뉴 찾기');
    launcher.innerHTML = `<div class="search-pill"><span aria-hidden="true">⌕</span><label class="sr-only" for="record-search">기록 메뉴 검색</label><input id="record-search" type="search" placeholder="어떤 기록을 남길까요?" autocomplete="off"><button id="clear-record-search" class="quiet" type="button" aria-label="검색어 지우기">×</button></div><p id="record-search-empty" class="hint" hidden>일치하는 메뉴가 없습니다. 입실, 거주, 퇴실, 계약서를 검색해 보세요.</p>`;
    launcher.append(navigation);
    view.prepend(launcher);
    const search = launcher.querySelector('#record-search');
    const filterMenus = () => {
      let count = 0;
      for (const button of navigation.querySelectorAll('button')) {
        button.hidden = !button.textContent.includes(search.value.trim());
        if (!button.hidden) count++;
      }
      launcher.querySelector('#record-search-empty').hidden = count > 0;
    };
    search.oninput = filterMenus;
    launcher.querySelector('#clear-record-search').onclick = () => { search.value = ''; filterMenus(); search.focus(); };
    const toggleAccount = () => {
      const account = document.querySelector('#account-view');
      account.hidden = !account.hidden;
      document.querySelector('#home-heading').hidden = !account.hidden;
      for (const id of ['photos', 'moveout', 'contracts', 'living']) document.querySelector(`#${id}-view`).hidden = true;
      document.querySelector('#mypage').setAttribute('aria-expanded', String(!account.hidden));
    };
    document.querySelector('#mypage').onclick = toggleAccount;
    document.querySelector('#setup-house').onclick = toggleAccount;
    for (const [id, target] of [['entry','photos'],['exit','moveout'],['contract','contracts'],['living','living']]) {
      document.querySelector(`#record-${id}`).onclick = () => document.querySelector(`#open-${target}`).click();
    }
    document.querySelector('#open-living').onclick = () => {
      for (const id of ['photos','moveout','contracts']) document.querySelector(`#${id}-view`).hidden = true;
      const target = document.querySelector('#living-view');
      target.hidden = false;
      if (!disposeLiving) disposeLiving = mountLiving(target, api, controller.signal);
      else target.dispatchEvent(new window.Event('refresh-living'));
    };
    document.querySelector('#open-photos').onclick = () => {
      document.querySelector('#living-view').hidden = true;
      document.querySelector('#contracts-view').hidden = true;
      document.querySelector('#moveout-view').hidden = true;
      const target = document.querySelector('#photos-view');
      target.hidden = !target.hidden;
      if (!target.hidden && !disposePhotos) disposePhotos = mountPhotos(target, api, controller.signal);
      document.querySelector('#open-photos').textContent = target.hidden ? '입실 사진 등록·조회' : '사진 화면 접기';
    };
    document.querySelector('#open-moveout').onclick = () => {
      document.querySelector('#living-view').hidden = true;
      document.querySelector('#contracts-view').hidden = true;
      document.querySelector('#photos-view').hidden = true;
      const target = document.querySelector('#moveout-view');
      target.hidden = false;
      if (!disposeMoveOut) disposeMoveOut = mountMoveOut(target, api, controller.signal);
      else target.dispatchEvent(new window.Event('refresh-moveout'));
      document.querySelector('#open-photos').textContent = '입실 사진 등록·조회';
    };
    document.querySelector('#open-contracts').onclick = () => {
      document.querySelector('#living-view').hidden = true;
      document.querySelector('#photos-view').hidden = true;
      document.querySelector('#moveout-view').hidden = true;
      const target = document.querySelector('#contracts-view');
      target.hidden = false;
      if (!disposeContracts) disposeContracts = mountContracts(target, api, controller.signal);
      else target.dispatchEvent(new window.Event('refresh-contracts'));
      document.querySelector('#open-photos').textContent = '입실 사진 등록·조회';
    };
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
    if (userId !== session.user.id) {
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
