const PAGE = 20;
const messageFor = error => ['42P01', 'PGRST205'].includes(error?.code)
  ? '지금은 커뮤니티를 사용할 수 없어요. 잠시 후 다시 시도해 주세요.'
  : '요청을 처리하지 못했어요. 로그인 상태와 인터넷 연결을 확인하고 다시 시도해 주세요.';
const element = (tag, text, className) => {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
};

export function mountCommunity(root, client) {
  let disposed = false, userId = null, page = 0, version = 0;
  const section = document.createElement('section'); section.className = 'card community';
  section.innerHTML = `<span class="step">함께 사는 이야기</span><h2>돌려받집 커뮤니티</h2><p class="hint">집 관리 경험을 나누고 댓글로 이야기해요. 글과 댓글은 로그인한 회원에게 공개됩니다. 주소·연락처·계약서 원문은 올리지 마세요.</p><form class="community-compose"><label>제목<input name="title" required maxlength="120" placeholder="어떤 이야기를 나누고 싶나요?"></label><label>내용<textarea name="body" required maxlength="5000" rows="4" placeholder="상황과 궁금한 점을 적어 주세요"></textarea></label><button type="submit">글 올리기</button></form><p class="community-status" role="status" aria-live="polite"></p><button type="button" class="community-refresh quiet">새로고침</button><div class="community-posts"></div><div class="community-pages"><button type="button" class="community-prev quiet">이전</button><button type="button" class="community-next quiet">다음</button></div>`;
  root.append(section);
  const status = section.querySelector('.community-status'), list = section.querySelector('.community-posts');
  const compose = section.querySelector('form');
  const setStatus = text => { if (!disposed) status.textContent = text; };
  async function run(button, action) {
    if (button.disabled || disposed) return;
    button.disabled = true;
    try { await action(); } catch (error) { setStatus(messageFor(error)); }
    finally { if (!disposed) button.disabled = false; }
  }
  function deleteButton(table, id, after) {
    const button = element('button', '삭제', 'quiet'); button.type = 'button';
    button.onclick = () => {
      if (!window.confirm(table === 'community_posts' ? '글과 댓글을 삭제할까요?' : '댓글을 삭제할까요?')) return;
      run(button, async () => {
        const { data, error } = await client.from(table).delete().eq('id', id).select('id');
        if (error) throw error;
        if (!data?.length) { setStatus('이미 삭제되었거나 삭제 권한이 없습니다.'); return; }
        await after();
      });
    };
    return button;
  }
  async function comments(post, target) {
    const ticket = ++post.commentVersion;
    const { data, error } = await client.from('community_comments').select('id,user_id,body,created_at')
      .eq('post_id', post.id).order('created_at', { ascending: true }).limit(100);
    if (disposed || ticket !== post.commentVersion || !target.isConnected) return;
    if (error) { setStatus(messageFor(error)); return; }
    target.replaceChildren();
    for (const item of data || []) {
      const row = element('div', '', 'community-comment');
      row.append(element('small', item.user_id === userId ? '나의 댓글' : '이웃의 댓글'), element('p', item.body));
      if (item.user_id === userId) row.append(deleteButton('community_comments', item.id, () => comments(post, target)));
      target.append(row);
    }
    if (!data?.length) target.append(element('p', '첫 댓글을 남겨 보세요.', 'hint'));
    if (data?.length === 100) target.append(element('p', '댓글은 먼저 작성된 100개까지 표시합니다.', 'hint'));
  }
  async function load() {
    const ticket = ++version;
    setStatus('이야기를 불러오고 있습니다…');
    if (!client?.from || !client?.auth) { setStatus('로그인 후 커뮤니티를 이용해 주세요.'); return; }
    const { data: auth, error: authError } = await client.auth.getUser();
    if (disposed || ticket !== version) return;
    if (authError || !auth?.user || auth.user.is_anonymous) { setStatus('로그인 후 커뮤니티를 이용해 주세요.'); return; }
    userId = auth.user.id;
    const { data, error } = await client.from('community_posts').select('id,user_id,title,body,created_at')
      .order('created_at', { ascending: false }).order('id').range(page * PAGE, page * PAGE + PAGE);
    if (disposed || ticket !== version) return;
    if (error) { setStatus(messageFor(error)); return; }
    list.replaceChildren();
    section.querySelector('.community-prev').disabled = page === 0;
    section.querySelector('.community-next').disabled = data.length <= PAGE;
    for (const post of data.slice(0, PAGE)) {
      const article = element('article', '', 'community-post'); post.commentVersion = 0;
      article.append(element('h3', post.title), element('small', `${post.user_id === userId ? '내가 쓴 글' : '이웃의 이야기'} · ${new Date(post.created_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}`), element('p', post.body));
      if (post.user_id === userId) article.append(deleteButton('community_posts', post.id, load));
      const details = document.createElement('details'); details.append(element('summary', '댓글 보기·쓰기'));
      const commentList = element('div', '', 'community-comments');
      const form = document.createElement('form');
      form.innerHTML = '<label>댓글<textarea name="comment" required maxlength="2000" rows="2" placeholder="이웃에게 답변을 남겨 주세요"></textarea></label><button type="submit">댓글 등록</button>';
      form.onsubmit = event => { event.preventDefault(); const body = form.elements.comment.value.trim(); if (!body) return;
        run(form.querySelector('button'), async () => {
          const { error } = await client.from('community_comments').insert({ post_id: post.id, body });
          if (error) throw error;
          if (disposed) return;
          form.reset(); await comments(post, commentList); setStatus('댓글을 등록했습니다.');
        });
      };
      details.append(commentList, form); details.ontoggle = () => { if (details.open) comments(post, commentList).catch(error => setStatus(messageFor(error))); };
      article.append(details); list.append(article);
    }
    setStatus(data.length ? '' : '아직 이야기가 없습니다. 첫 글을 남겨 보세요.');
  }
  compose.onsubmit = event => { event.preventDefault();
    const title = compose.elements.title.value.trim(), body = compose.elements.body.value.trim();
    if (!title || !body) { setStatus('제목과 내용을 입력해 주세요.'); return; }
    run(compose.querySelector('button'), async () => {
      const { error } = await client.from('community_posts').insert({ title, body });
      if (error) throw error;
      if (disposed) return;
      compose.reset(); page = 0; await load();
    });
  };
  const reload = () => load().catch(error => setStatus(messageFor(error)));
  section.querySelector('.community-refresh').onclick = reload;
  section.querySelector('.community-prev').onclick = () => { page = Math.max(0, page - 1); reload(); };
  section.querySelector('.community-next').onclick = () => { page++; reload(); };
  reload();
  return () => { disposed = true; version++; section.remove(); };
}
