const TOPICS = [
  { words: ['곰팡', '결로', '습기', '축축'], title: '곰팡이·결로가 신경 쓰이나요?', text: '발견한 위치와 날짜, 습기가 생기는 시간대를 기록해 두세요. 창틀·벽 모서리의 전체 사진과 가까운 사진을 함께 남기면 상태 변화를 확인하기 좋습니다. 같은 부위가 반복해서 젖거나 범위가 커지면 관리 담당자에게 사진을 공유하고 원인 점검을 요청하세요.' },
  { words: ['누수', '물새', '물이 새', '물자국', '천장'], title: '물이 새거나 물자국이 보일 때', text: '물이 보이는 위치와 발생 시점을 사진으로 기록하고, 관리 담당자에게 빠르게 알려 점검을 요청하세요. 비가 온 뒤인지, 특정 설비를 사용한 뒤인지도 함께 적어 두면 좋습니다. 젖은 콘센트나 전기기구를 만지지 말고 주변 접근을 피하세요.' },
  { words: ['벽지', '장판', '바닥', '긁힘', '훼손', '손상'], title: '벽지·바닥 상태를 기록하는 방법', text: '문제 부위 전체와 가까운 사진을 찍고 입실 사진에서 같은 위치를 찾아보세요. 처음 발견한 날짜와 이후 변화를 기록해 두세요. 상태를 바꾸거나 수리하기 전에 관리 담당자와 점검·조치 방법을 확인하고 대화 내용을 보관하세요.' },
  { words: ['환기', '냄새', '청소', '관리'], title: '평소 집을 관리할 때', text: '요리나 샤워 후에는 환기 설비를 활용하고, 물기가 남은 곳이 있는지 살펴보세요. 가구 뒤·창틀·싱크대 아래처럼 잘 보이지 않는 곳도 주기적으로 확인하세요. 냄새나 습기가 계속되면 발생 위치·시간을 기록해 관리 담당자에게 점검을 요청하세요.' },
  { words: ['퇴실', '입실', '사진', '보증금'], title: '입실·퇴실 사진을 남길 때', text: '벽·바닥·천장·창틀·욕실·주방·옵션 설비를 전체와 가까운 사진으로 나눠 찍어 두세요. 퇴실 때는 입실 사진과 같은 위치·각도로 촬영하면 비교하기 쉽습니다. 원본 사진과 관리 담당자와 주고받은 내용을 함께 보관하세요.' },
];

export function answerHomeCare(question) {
  const normalized = question.replace(/\s+/g, '').toLowerCase();
  const topic = TOPICS.find(item => item.words.some(word => normalized.includes(word.replace(/\s+/g, ''))));
  return topic || { title: '조금 더 구체적으로 알려주세요', text: '현재는 곰팡이·결로, 누수, 벽지·바닥, 환기·청소, 입실·퇴실 기록에 대한 기본 안내를 제공합니다. 예: “창틀에 결로가 생겨요”처럼 위치와 상황을 적어 주세요. 원인이나 수리비 부담은 이 안내만으로 판단할 수 없습니다.' };
}

export function mountHomeCare(root) {
  const section = document.createElement('section');
  section.className = 'home-care card';
  section.innerHTML = `<span class="step">집 관리 도움말</span><h2>집 관리, 궁금한 점이 있나요?</h2><p class="hint">상황을 적으면 주제별 기본 안내를 보여드려요. AI 상담이 아니며 질문은 저장·전송되지 않습니다.</p><form><label class="sr-only" for="care-question">집 관리 질문</label><div class="care-input"><input id="care-question" maxlength="500" required placeholder="예: 창틀에 결로가 생기는데 어떻게 기록하나요?"><button type="submit">물어보기</button></div></form><div class="care-suggestions"><button type="button">곰팡이가 생겼어요</button><button type="button">벽지가 들떴어요</button><button type="button">누수가 의심돼요</button></div><div class="care-answer" role="status" aria-live="polite" hidden></div>`;
  const input = section.querySelector('input');
  const answer = section.querySelector('.care-answer');
  const show = () => {
    if (!input.value.trim()) return;
    const result = answerHomeCare(input.value.trim());
    answer.replaceChildren();
    const title = document.createElement('h3'); title.textContent = result.title;
    const text = document.createElement('p'); text.textContent = result.text;
    answer.append(title, text); answer.hidden = false;
  };
  section.querySelector('form').onsubmit = event => { event.preventDefault(); show(); };
  section.querySelectorAll('.care-suggestions button').forEach(button => { button.onclick = () => { input.value = button.textContent; show(); }; });
  root.append(section);
}
