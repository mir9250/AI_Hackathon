// 공적 자료만 조회한다. 사용자 입력은 저장·AI 전송하지 않고 HTML에 삽입하지 않는다.
export function mountLegalLibrary(root, { baseUrl = '', fetcher = globalThis.fetch.bind(globalThis) } = {}) {
  const section = document.createElement('section');
  section.className = 'legal-library';
  section.setAttribute('aria-label', '임대차 판례 찾아보기');
  section.innerHTML = `<details><summary>임대차 판례 찾아보기 <span>보증금·수선·원상회복</span></summary>
    <div class="legal-body"><h2>비슷한 쟁점의 판례를 찾아보세요</h2>
    <p>공식 판결요지를 확인하는 참고자료예요. 나의 상황에 같은 결론이 적용된다는 뜻은 아니에요.</p>
    <form class="legal-form"><div><label for="legal-query">쟁점·사건번호 검색</label><input id="legal-query" name="q" autocomplete="off" type="search" maxlength="100" placeholder="예: 보증금, 수선, 원상회복…"></div>
    <div><label for="legal-topic">주제</label><select id="legal-topic" name="topic"><option value="">전체 주제</option></select></div>
    <div><label for="legal-source">출처 확인 범위</label><select id="legal-source" name="source"><option value="all">전체 자료</option><option value="primary">원문 확인 자료만</option></select></div>
    <button type="submit">판례 검색</button></form>
    <p class="legal-notice">전문가 검토 전 자료예요. 주택 외 임대차 사건도 포함되며, 책임이나 공제액을 자동으로 판단하지 않아요. 이름·주소 등 개인정보는 검색어에 넣지 마세요.</p>
    <p class="legal-status" role="status" aria-live="polite"></p><div class="legal-results"></div>
    <div class="legal-paging"><button type="button" class="quiet legal-prev" disabled>이전</button><button type="button" class="quiet legal-next" disabled>다음</button></div></div></details>`;
  root.append(section);
  const get = s => section.querySelector(s);
  const status = get('.legal-status');
  const results = get('.legal-results');
  let offset = 0, generation = 0, controller;
  let query = { q: '', topic: '', source: 'all' };
  const url = path => baseUrl.replace(/\/$/, '') + path;
  async function request(path, signal) {
    const response = await fetcher(url(path), { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('판례를 불러오지 못했어요. 잠시 후 다시 검색해 주세요.');
    return (await response.json()).data;
  }
  function text(tag, value, className) {
    const el = document.createElement(tag); el.textContent = value;
    if (className) el.className = className;
    return el;
  }
  function sourceLink(record) {
    const link = text('a', '공식 출처에서 보기');
    // 출처 데이터가 바뀌어도 스크립트 주소나 외부 추적 링크를 만들지 않는다.
    const parsed = new URL(record.source_url);
    if (parsed.protocol !== 'https:' || !['law.go.kr', 'www.law.go.kr', 'www.easylaw.go.kr'].includes(parsed.hostname)) return text('p', '출처 주소를 확인해 주세요.');
    link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `${record.citation} 공식 출처에서 보기 (새 창)`);
    return link;
  }
  async function load() {
    controller?.abort(); controller = new AbortController();
    const current = ++generation;
    status.textContent = '판례를 찾고 있어요…'; results.replaceChildren();
    get('.legal-prev').disabled = get('.legal-next').disabled = true;
    try {
      const data = await request('/api/legal/cases?' + new URLSearchParams({ ...query, offset, limit: 10 }), controller.signal);
      if (current !== generation) return;
      status.textContent = `${data.total}건 중 ${data.items.length ? offset + 1 : 0}–${offset + data.items.length}건 · 전체 ${data.catalog_total}건(원문 확인 ${data.primary_count}건, 공식 해설 확인 ${data.secondary_count}건)`;
      if (get('#legal-topic').options.length === 1) for (const topic of data.topics) {
        const option = text('option', topic); option.value = topic; get('#legal-topic').append(option);
      }
      if (!data.items.length) results.append(text('p', '일치하는 판례가 없어요. 검색어를 줄이거나 전체 주제로 다시 검색해 주세요.'));
      for (const record of data.items) {
        const article = document.createElement('article'); article.className = 'legal-case';
        article.append(text('h3', record.title), text('p', record.citation, 'legal-citation'),
          text('p', record.verification_level === 'primary_text_checked' ? '공식 원문 확인 · 전문가 적용 검토 전' : '공식 해설에서만 확인 · 자동 답변 근거 제외', 'legal-badge'),
          text('p', record.excerpt, 'legal-excerpt'));
        const detail = document.createElement('details');
        detail.append(text('summary', '판결요지·적용 주의사항 보기'));
        const content = document.createElement('div'); detail.append(content);
        let loaded = false;
        detail.addEventListener('toggle', async () => {
          if (!detail.open || loaded) return;
          content.textContent = '상세 내용을 불러오고 있어요…';
          try {
            const full = await request('/api/legal/cases/' + encodeURIComponent(record.id), controller.signal);
            if (current !== generation) return;
            content.replaceChildren(text('h4', '원문 발췌'), text('p', full.source_scope), text('blockquote', full.source_quote));
            content.querySelector('blockquote').tabIndex = 0;
            content.setAttribute('aria-live', 'polite');
            content.append(text('h4', '사건의 쟁점·배경'), text('p', full.original_context));
            if (full.summary) content.append(text('h4', '편집 요약'), text('p', full.summary));
            content.append(text('h4', '적용 전에 확인하세요'));
            const list = document.createElement('ul');
            for (const warning of full.cautions) list.append(text('li', warning));
            content.append(list, text('p', `출처: ${full.source_publisher} / 조회일: ${full.retrieved_on || '확인 필요'}`), sourceLink(full));
            loaded = true;
          } catch (error) {
            if (error.name !== 'AbortError' && current === generation) content.textContent = error.message;
          }
        });
        article.append(detail, sourceLink(record)); results.append(article);
      }
      get('.legal-prev').disabled = offset === 0;
      get('.legal-next').disabled = offset + 10 >= data.total;
    } catch (error) {
      if (error.name !== 'AbortError' && current === generation) status.textContent = error.message;
    }
  }
  get('.legal-form').onsubmit = event => {
    event.preventDefault(); offset = 0;
    query = { q: get('#legal-query').value.trim(), topic: get('#legal-topic').value, source: get('#legal-source').value };
    load();
  };
  get('.legal-prev').onclick = () => { offset = Math.max(0, offset - 10); load(); };
  get('.legal-next').onclick = () => { offset += 10; load(); };
  let opened = false;
  get('details').addEventListener('toggle', () => { if (get('details').open && !opened) { opened = true; load(); } });
  return () => { generation++; controller?.abort(); section.remove(); };
}
