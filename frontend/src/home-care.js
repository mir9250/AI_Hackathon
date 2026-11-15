import { mountLegalLibrary } from './legal.js';

// Official source summaries reviewed 2026-11-16. These are conditional guides, not fault statistics.
const SOURCES = {
  repair: { label: '생활법령정보 · 임대인의 수선의무', url: 'https://easylaw.go.kr/CSP/CnpClsMain.laf?ccfNo=4&cciNo=2&cnpClsNo=2&csmSeq=629&popMenu=ov' },
  mold: { label: '임대차분쟁조정위원회 · 결로·곰팡이와 통지의무 판례', url: 'https://adrhome.reb.or.kr/adrhome/reb/LO010100/bbs/View.do?Key=10402000000002022101716&boardIdx=143&boardNo=9' },
  wear: { label: '국가법령정보센터 · 통상 손모 판례(서울중앙지법)', url: 'https://law.go.kr/precInfoP.do?precSeq=147076' },
  cost: { label: '민법 제626조 · 필요비 상환', url: 'https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0626&lsiSeq=284415&urlMode=lsScJoRltInfoR' },
  renewal: { label: '주택임대차보호법 제6조의2 · 묵시적 갱신 해지', url: 'https://law.go.kr/lsLinkCommonInfo.do?lsJoLnkSeq=1007710149' },
  deposit: { label: '생활법령정보 · 임차권등기명령', url: 'https://www.easylaw.go.kr/CSP/CnpClsMain.laf?ccfNo=5&cciNo=2&cnpClsNo=1&csmSeq=629' },
};
const topic = (id, words, title, text, landlord, tenant, questions, sources = ['repair']) => ({ id, words, title, text, landlord, tenant, questions, sources: sources.map(key => SOURCES[key]) });
export const HOME_CARE_TOPICS = [
  topic('mold', ['곰팡','결로','습기','축축'], '곰팡이·결로, 원인부터 구분해 볼까요?', '사진만으로 책임 비율을 정할 수 없습니다. 같은 위치의 사진과 발생 날짜를 남기고 임대인에게 점검을 요청하세요. 통지가 늦어져 피해가 커지면 배상 범위에 영향을 줄 수 있습니다.', '누수·단열 등 건물 문제라면 수선의무 검토', '환기 부족·방치로 악화했다면 기여 정도 검토', ['비가 오면 젖나요?', '환기해도 반복되나요?', '발견 후 언제 알렸나요?'], ['mold','repair']),
  topic('leak', ['누수','물새','물이새','물자국','천장'], '물이 새거나 천장에 물자국이 생겼어요', '발생 시각·비·설비 사용과의 관계를 기록하고 누수 탐지 결과를 확보하세요. 윗집·공용배관 등 원인 주체도 확인해야 합니다.', '노후 배관·건물 하자라면 수선 검토', '사용 중 파손·넘침이 원인이라면 부담 검토', ['비가 올 때만 생기나요?', '누수 탐지를 받았나요?']),
  topic('boiler', ['보일러','난방','온수'], '보일러·온수가 작동하지 않아요', '오류 코드와 점검 소견을 남겨 수리를 요청하세요. 노후 고장과 사용 부주의를 구분합니다.', '노후한 필수 설비 고장이라면 수선 검토', '설명받은 관리 수칙 위반이 원인인지 확인', ['기사의 고장 원인 설명이 있나요?', '입주 때부터 고장이었나요?']),
  topic('freeze', ['동파','얼었','얼어'], '배관 동파의 원인을 확인해 주세요', '보온 상태·외기온·장기간 부재 여부와 관리 안내를 기록하세요. 추웠다는 사실만으로 어느 쪽 책임인지 정하지 않습니다.', '보온·설비 결함 여부 검토', '관리 안내 미이행과 동파의 인과관계 검토', ['배관에 보온재가 있었나요?', '동파 예방 안내를 받았나요?']),
  topic('drain', ['막혔','막혀','배수','하수','변기'], '배수구·변기가 막혔어요', '이물질인지 배관 자체 문제인지 기사 소견을 받으세요. 제거 전후 사진과 영수증을 보관하세요.', '배관 노후·구조 문제라면 수선 검토', '투입한 이물질이 원인이라면 부담 검토', ['제거된 이물질이 있나요?', '입주 직후에도 막혔나요?']),
  topic('wall', ['벽지','도배'], '벽지 훼손, 자연스러운 변화인가요?', '입실 사진과 비교하고 교체 시기·손상 범위·원상복구 특약을 확인하세요. 전면 교체 견적이면 해당 범위의 근거를 요청하세요.', '통상 손모·노후라면 임대인 부담 검토', '낙서·찢김 등 사용상 손상이라면 부담 검토', ['햇빛 변색인가요, 찢김인가요?', '특약에 범위가 구체적으로 적혀 있나요?'], ['wear']),
  topic('floor', ['장판','바닥','긁힘','찍힘'], '바닥·장판 손상의 범위를 살펴보세요', '입실 상태와 사용 기간을 비교하고 부분 보수 가능 여부를 확인하세요.', '통상 마모·노후라면 임대인 부담 검토', '깊은 찍힘·화상 등 손상 원인 확인', ['입실 때도 흔적이 있었나요?', '부분 보수가 가능한가요?'], ['wear']),
  topic('window', ['창문','창틀','방충망','유리'], '창문·방충망 수리가 필요해요', '개폐 불량·파손 사진과 수리 견적을 전달하세요. 사소한 수선인지 정상 사용을 방해하는지 구분합니다.', '노후·큰 기능 하자라면 수선 검토', '충격 파손·사소한 수선 여부 검토', ['정상적으로 열고 닫을 수 있나요?', '외부 충격이 있었나요?']),
  topic('electric', ['전기','콘센트','차단기','누전'], '전기 설비에 이상이 있어요', '젖은 설비나 노출 배선에 손대지 말고 전문 점검을 요청하세요. 점검 보고서에 원인을 남기세요.', '고정 배선·설비 결함이라면 수선 검토', '개인 기기·과부하가 원인인지 확인', ['특정 기기를 사용할 때만 발생하나요?', '점검 소견이 있나요?']),
  topic('bulb', ['전구','형광등','건전지'], '전구 같은 소모품도 집주인이 교체하나요?', '소모품과 등기구 자체 고장을 구분하고 계약 내용을 확인하세요.', '등기구 자체의 큰 고장 여부 검토', '저비용으로 쉽게 교체하는 소모품 여부 검토', ['전구를 바꿔도 안 켜지나요?', '관련 특약이 있나요?']),
  topic('appliance', ['에어컨','냉장고','세탁기','옵션'], '옵션 가전이 고장 났어요', '계약에 포함된 옵션인지 확인하고 연식·고장 원인·입실 상태를 기록하세요.', '제공된 옵션의 노후 고장이라면 수선 검토', '사용 부주의로 고장 났는지 확인', ['계약서에 옵션으로 적혀 있나요?', '기사 소견은 무엇인가요?']),
  topic('pest', ['벌레','바퀴','해충'], '벌레가 반복해서 나와요', '유입 경로와 발견 시점을 기록해 방역·시설 점검을 요청하세요.', '건물 틈·공용부 원인이 확인되는지 검토', '음식물·생활 관리와의 관련성 확인', ['입주 직후부터 있었나요?', '다른 세대도 같은 문제인가요?']),
  topic('cost', ['수리비','먼저고쳤','자비','필요비'], '먼저 낸 수리비를 돌려받을 수 있나요?', '보존에 필요한 비용은 상환청구 대상이 될 수 있습니다. 필요성·긴급성·금액·통지 내역을 남기세요. 모든 인테리어 비용이 해당하는 것은 아닙니다.', '필요비 해당 여부와 수선의무 검토', '개인 취향의 개선·과도한 비용인지 확인', ['수리 전 알렸나요?', '견적과 영수증이 있나요?'], ['cost']),
  topic('deposit', ['보증금','임차권','안돌려'], '보증금을 돌려받지 못했어요', '계약이 끝났는데 보증금을 받지 못했다면 임차권등기명령을 검토할 수 있습니다. 이사·전출 전에는 신청만으로 충분하다고 생각하지 말고 등기 완료 여부와 권리 유지 조건을 확인하세요.', '반환 지연 사유와 공제 내역 확인', '종료·인도 일정과 미정산 항목 확인', ['계약이 종료됐나요?', '이사나 전출을 앞두고 있나요?'], ['deposit']),
  topic('renewal', ['묵시','갱신','중도해지'], '갱신 후 이사하려면 언제 알려야 하나요?', '묵시적 갱신이라면 임차인은 해지를 통지할 수 있고 임대인이 받은 날부터 3개월 후 효력이 발생합니다. 합의 갱신·최초 계약 중 해지는 같은 규칙으로 단정하지 않습니다.', '통지를 받은 날짜와 종료 일정 확인', '갱신 유형·통지 도달 증거 확인', ['묵시적 갱신인가요, 새 계약서를 썼나요?', '언제 통지가 도달했나요?'], ['renewal']),
  topic('clean', ['청소','냄새','환기','관리'], '냄새·청소 문제는 원인과 약정을 확인하세요', '일상 관리 기록과 입실 상태를 남기고 지속되는 냄새는 배관·누수 점검을 요청하세요. 퇴실 청소비는 약정과 실제 상태를 확인하세요.', '구조·설비 원인인지 검토', '생활 오염과 청소 약정 확인', ['입주 때부터 냄새가 났나요?', '청소비 특약이 있나요?'], ['repair','wear']),
  topic('damage', ['못','구멍','반려','훼손','손상'], '사용 중 생긴 손상은 범위와 원인을 확인하세요', '손상 부위·입실 상태·동의받은 설치 내역을 남기고 보수 범위와 견적을 비교하세요.', '기존 손상·통상 손모 여부 검토', '설치·반려동물 등에 의한 손상인지 확인', ['설치 전에 동의받았나요?', '손상 전 사진이 있나요?'], ['wear']),
  topic('record', ['입실','퇴실','사진'], '입실·퇴실 사진은 같은 위치로 비교하세요', '전체 사진과 근접 사진을 함께 보관하고 입실 때 있던 손상은 날짜를 남겨 전달하세요. 사진 기록은 원인 판단을 돕지만 책임을 자동 확정하지 않습니다.', '기존 상태와 수선 요청 내역 확인', '사용 중 변한 부분과 통상 손모 구분', ['입실 원본이 있나요?', '같은 위치·각도로 촬영했나요?'], ['wear']),
];
const normalize = value => String(value ?? '').replace(/\s+/g, '').toLowerCase();
// A user's description is a lead for inspection, never proof of fault.
const EVIDENCE_RULES = {
  mold: {
    building: [/환기(?:를)?(?:해도|했는데도|하는데도)/, /단열(?:불량|결함|문제)/, /누수(?:가|때문에|로)/, /입주(?:전|직후|때부터)/],
    use: [/환기(?:를)?(?:안했|안해|하지않|못했)/, /가습기(?:를)?(?:계속|하루종일|과도)/, /곰팡이(?:를)?(?:방치했|방치해)/],
    buildingText: '환기 후에도 반복되거나 건물 하자를 언급하셨습니다. 단열·누수 점검을 먼저 요청하고, 건물 원인이 확인되면 임대인의 수선의무를 검토하세요.',
    useText: '환기 부족이나 방치를 언급하셨습니다. 생활 관리가 영향을 줬을 가능성을 점검하되 단열·누수 문제가 함께 있는지도 확인해야 합니다.',
    evidence: '습도·환기 기록, 비 온 날의 변화, 단열·누수 점검 소견, 최초 통지 날짜를 확보하세요.',
  },
  leak: {
    building: [/노후(?:한)?배관/, /공용배관/, /비(?:가)?(?:오면|온뒤|올때)/, /윗집(?:에서|배관)/],
    use: [/수도(?:를)?(?:안잠|잠그지않|틀어놓)/, /내가.*(?:배관|호스).*(?:깨뜨|파손|뽑았)/, /세탁기호스(?:가)?빠/],
    buildingText: '비·노후 배관·윗집 등과 연결된 증상입니다. 건물이나 다른 세대의 원인을 우선 점검하고, 원인 주체가 확인된 뒤 수리·배상 범위를 나누세요.',
    useText: '수도 사용이나 호스·배관 조작과 관련된 상황입니다. 그 행동이 실제 누수 원인인지와 기존 설비 결함이 있었는지 확인하세요.',
    evidence: '누수 탐지 보고서, 발생 시각, 수리 전후 사진, 피해 범위와 영수증을 확보하세요.',
  },
  wall: {
    building: [/햇빛.*변색/, /자연(?:스럽게)?변색/, /오래(?:돼|되어|돼서|되어서)/, /입주(?:전|때부터)/],
    use: [/낙서(?:를)?(?:했|해|한)/, /내가.*(?:찢|뜯)/, /반려(?:동물|묘|견).*(?:긁|뜯)/],
    buildingText: '노후·변색·기존 상태를 언급하셨습니다. 통상 손모인지 먼저 비교하고, 이를 임차인에게 부담시키는 구체적인 약정이 있는지 확인하세요.',
    useText: '낙서·찢김 등 사용 중 손상을 언급하셨습니다. 실제 손상 부위와 보수 필요 범위를 확인하고 전면 교체비를 곧바로 인정하지 마세요.',
    evidence: '입실 사진, 도배 시기, 원상복구 특약, 부분 보수·전면 교체 견적을 비교하세요.',
  },
  boiler: {
    building: [/노후/, /오래된보일러/, /입주(?:전|직후|때부터)/, /기사.*(?:수명|노후|부품고장)/],
    use: [/내가.*(?:깨뜨|파손)/, /관리수칙(?:을)?(?:안지켰|지키지않)/, /전원(?:을)?꺼.*동파/],
    buildingText: '노후 또는 입주 초기 고장을 언급하셨습니다. 필수 설비의 정상 사용을 막는 고장인지 점검하고 임대인에게 수선을 요청하세요.',
    useText: '파손이나 관리 수칙 미이행을 언급하셨습니다. 해당 행동과 고장의 인과관계 및 설비 자체 결함을 함께 확인하세요.',
    evidence: '오류 코드, 기사 진단서, 설비 연식, 관리 안내와 수리 요청 내역을 보관하세요.',
  },
};
function suppliedFact(text, patterns) {
  // Reject a matched clause when the immediately following words deny that fact.
  return patterns.some(pattern => {
    const match = pattern.exec(text);
    if (!match) return false;
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 12);
    return !/^(?:은|는|이|가|도|때문은|문제는|문제가|한것은|한건)?(?:없|아니|아님|아닌|아닙|않)/.test(after);
  });
}
function evaluateFacts(item, text) {
  const rule = EVIDENCE_RULES[item.id];
  const fallback = { assessment: '원인 확인 필요 · 책임 비율 산정 불가', caseText: '현재 설명만으로 원인 방향을 정하기 어렵습니다. 아래 질문에 해당하는 상황을 더 적어 주세요.' };
  if (!rule) return fallback;
  const building = suppliedFact(text, rule.building);
  const use = suppliedFact(text, rule.use);
  if (!building && !use) return { ...fallback, evidence: rule.evidence };
  if (building && use) return { assessment: '복합 원인 점검 필요 · 책임 비율 산정 불가', caseText: '건물 문제와 사용·관리 요인이 함께 언급되었습니다. 어느 한쪽으로 단정하지 말고 각각 피해에 얼마나 영향을 줬는지 점검해야 합니다.', evidence: rule.evidence };
  return { assessment: `${building ? '건물·설비 원인 점검 우선' : '사용·관리 원인 점검 우선'} · 책임 비율 산정 불가`, caseText: building ? rule.buildingText : rule.useText, evidence: rule.evidence };
}
export function answerHomeCare(question) {
  const normalized = normalize(question);
  const matches = HOME_CARE_TOPICS.map(item => ({ item, score: item.words.filter(word => normalized.includes(word)).reduce((sum, word) => sum + word.length, 0) })).filter(match => match.score > 0).sort((a,b) => b.score - a.score);
  if (!matches.length) return { title: '어떤 상황인지 조금 더 알려주세요', text: '집 관리와 임대차에 관한 기본 안내를 제공합니다. “비가 오면 천장에 물이 새요”, “퇴실 때 도배비를 요구해요”처럼 위치·증상·발생 시점을 적어 주세요.', questions: [], sources: [] };
  return { ...matches[0].item, related: matches.slice(1,3).map(match => match.item.title), ...evaluateFacts(matches[0].item, normalized) };
}
export function mountHomeCare(root, legalOptions = {}) {
  const section = document.createElement('section');
  section.className = 'home-care card';
  section.innerHTML = `<span class="step">집 관리 질문</span><h2>집 관리, 궁금한 점이 있나요?</h2><p class="hint">상황을 검색하면 공식 자료를 바탕으로 확인할 조건과 다음 행동을 안내해요. 질문은 저장·전송되지 않습니다.</p><form><label class="sr-only" for="care-question">집 관리 질문</label><div class="care-input"><input id="care-question" type="search" maxlength="500" required placeholder="예: 환기해도 창틀에 곰팡이가 생겨요"><button type="submit">답변 보기</button></div></form><div class="care-suggestions"><button type="button">곰팡이가 생겼어요</button><button type="button">벽지가 들떴어요</button><button type="button">보증금을 안 돌려줘요</button></div><div class="care-answer" role="status" aria-live="polite" hidden></div>`;
  const input = section.querySelector('input');
  const answer = section.querySelector('.care-answer');
  const add = (tag, text) => { const element = document.createElement(tag); element.textContent = text; answer.append(element); return element; };
  const show = () => {
    if (!input.value.trim()) return;
    const result = answerHomeCare(input.value);
    answer.replaceChildren();
    add('h3', result.title); add('p', result.text);
    if (result.assessment) {
      add('p', result.assessment).className = 'hint';
      add('p', result.caseText);
      if (result.evidence) add('p', result.evidence);
      add('p', `임대인 측 확인: ${result.landlord}`);
      add('p', `임차인 측 확인: ${result.tenant}`);
      add('h4', '이 조건을 확인해 주세요');
      const list = add('ul', '');
      result.questions.forEach(question => { const item = document.createElement('li'); item.textContent = question; list.append(item); });
      add('p', '책임은 원인·특약·통지·증거에 따라 달라집니다. 아래 자료의 일반 원칙을 적용한 안내이며 개별 사건의 판정은 아닙니다.').className = 'hint';
    }
    result.sources.forEach(source => { const link = add('a', source.label); link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.style.display = 'block'; });
    if (result.sources.length) add('small', '자료 확인: 2026-11-16 · 질문은 저장·전송되지 않습니다.');
    answer.hidden = false;
  };
  section.querySelector('form').onsubmit = event => { event.preventDefault(); show(); };
  section.querySelectorAll('.care-suggestions button').forEach(button => { button.onclick = () => { input.value = button.textContent; show(); }; });
  root.append(section);
  const disposeLegal = mountLegalLibrary(section, legalOptions);
  return () => { disposeLegal(); section.remove(); };
}
