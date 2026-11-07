# 돌려받집 배포 관리

배포 주소: https://dollyeobatjip-demo.newflask.chatgpt.site

Sites로 배포합니다. 현재 접근 범위는 공개(public)이며, 링크가 있는 누구나 웹 화면을 사용할 수 있습니다. 로컬 Python 서버를 켜 두지 않아도 웹 화면을 사용할 수 있습니다.

배포 소스는 `sites/deposit-guardian/`의 별도 Git 저장소에 있습니다. GitHub 프로젝트에 중첩 저장소로 추가하지 않도록 이 경로는 제외합니다. 사이트 소스는 Sites 전용 원격 저장소에 저장됩니다.

- `.openai/hosting.json`: 기존 프로젝트 ID를 유지합니다. 같은 사이트를 다시 만들지 않습니다.
- `app/`: 배포하는 HTML/CSS/JS. 원본 `rental-demo/` 변경을 이 복사본에도 반영합니다.
- `worker/`: 호스팅용 AI API. 로컬 Python 서버 대신 동작합니다.
- `node scripts/build.mjs` → `node scripts/test.mjs`로 빌드와 검증을 수행합니다.
- 실제 소스 업로드·아카이브·버전 저장·배포는 Sites 스킬의 source helper와 native tools를 사용합니다.

## 실제 AI 기능 연결

현재 배포에는 API 키가 없습니다. 사진 기록·수동 비교·로컬 특약 확인·리포트는 사용 가능하며, AI 결과는 키를 설정하기 전 생성하지 않습니다.

OpenAI Developers 플러그인의 `openai-platform-api-key` 절차로 키를 준비한 뒤 사이트의 **서버 비밀 환경변수** `OPENAI_API_KEY`에 설정합니다. 키를 채팅·GitHub·클라이언트 JS에 넣지 않습니다. 기본 모델은 gpt-4.1-mini이며 `OPENAI_MODEL`로 변경할 수 있습니다. 환경변수를 변경하면 해당 설정으로 재배포한 뒤 검증합니다.

## 기록과 접근 범위

기록은 접속한 사이트 주소의 브라우저 IndexedDB에 저장됩니다. localhost의 기록이 배포 주소로 자동 이전되지 않으므로 원본 사진과 HTML 리포트를 별도 보관합니다. 브라우저·기기 간 자동 동기화는 없습니다.

공개 전환은 사이트 화면 접근 권한을 변경한 것입니다. 사진과 메모가 다른 사용자에게 공유되지는 않습니다. AI 기능은 여전히 키 미설정으로 비활성 상태입니다. 공개 사이트에서 AI를 활성화하기 전에는 사용자별 인증·권한과 분산 호출 제한을 준비해야 합니다.
