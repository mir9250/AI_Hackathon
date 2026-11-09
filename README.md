# 돌려받집 — AI 보증금 기록 도우미

월세 입주부터 퇴실까지 공간을 기록하고, 실제 AI로 사진·특약을 살펴보며 보증금 정산을 준비하는 웹 프로토타입입니다.

공개 데모: **https://dollyeobatjip-demo.newflask.chatgpt.site**

노란색 `#FFD966`을 중심으로 로고와 화면 색상을 통일했습니다. 배포·접근 범위·AI 키 설정은 [DEPLOYMENT.md](DEPLOYMENT.md)를 확인하세요.

## 빠른 시작

Python 3.9 이상. 외부 패키지 설치 없이 실행합니다.

```bash
cp rental-demo/.env.example rental-demo/.env
# rental-demo/.env를 열어 OPENAI_API_KEY를 설정합니다.
python3 rental-demo/server.py
```

**http://localhost:8001/** 접속. 키가 없으면 촬영 안내·사진/메모 저장·수동 비교·로컬 키워드 확인·리포트를 체험할 수 있습니다. AI 결과는 키 설정 후에만 실제 요청으로 생성합니다. 키는 GitHub나 채팅에 공유하지 마세요.

## 주요 기능

- **입주/퇴실 기록:** 네 공간의 촬영 가이드, 사진·상태·메모 등록.
- **AI 사진 관찰:** 한국어 상태 태그와 위치별 흔적 후보, 관찰 근거와 해석을 분리한 결과.
- **특약 확인:** 로컬 키워드 확인 및 별도 AI 분석. 인용 문구가 입력 원문에 존재하는지 검증.
- **전후 비교:** 수동 비교 슬라이더와 두 사진을 입력하는 AI 변화 관찰.
- **정산 초안:** 제공한 사실만을 바탕으로 공제 근거를 요청하는 문장 작성·복사.
- **기기 저장:** IndexedDB로 사진·메모·특약·AI 응답 복원.
- **리포트:** 사진·메모·AI 참고 기록을 HTML로 다운로드.

AI 분석 전에는 자료의 OpenAI 전송에 동의해야 하며 API 사용료가 발생할 수 있습니다. 자동 전송하지 않습니다. API 키는 Python 서버에서만 읽고 브라우저에 노출하지 않습니다.

## 검증

```bash
python3 -m unittest discover -s rental-demo -p 'test_*.py' -v
node rental-demo/smoke-test.cjs
node rental-demo/ai-smoke-test.cjs
node rental-demo/storage-smoke-test.cjs
node --check rental-demo/app.js
node --check rental-demo/ai-ui.js
node --check rental-demo/storage.js
```

AI 테스트는 모의 응답으로 API 요청·응답 경로를 검증합니다. API 키가 없는 개발 환경에서는 실제 모델 호출을 검증하지 않습니다. 브라우저 대역 테스트는 실제 화면·카메라 검수를 대신하지 않습니다.

## 범위와 협업

이 서버는 로컬 개발용이며 공개 서비스 배포 구성은 아닙니다. 법령 검색은 연결하지 않았으며 법 조항·판례를 생성하지 않습니다. AI는 통상 마모·배상 책임·비용·반환 여부를 확정하지 않습니다. 등록 시각은 공인 시점 인증이 아닙니다.

자세한 실행·API·개인정보 처리·제한 사항은 [rental-demo/README.md](rental-demo/README.md)를 확인하세요. 팀 작업은 [AGENTS.md](AGENTS.md)의 브랜치·검증·main 반영 규칙을 따릅니다.

공식 분쟁조정 안내: [대한법률구조공단 임대차분쟁조정위원회](https://www.hldcc.or.kr/).

현재 서비스와 시작 화면은 돌려받집으로 통일합니다.

## 배포 소스 공동 개발

실제 Sites 배포용 전체 소스는 [sites/deposit-guardian/](sites/deposit-guardian/)에 포함합니다. 앱 화면, Worker API, DB 스키마·마이그레이션, 빌드·테스트 스크립트를 함께 내려받을 수 있습니다.

```bash
cd sites/deposit-guardian
npm run build
npm test
```

Node.js 22.13 이상이 필요하며 Node.js 24 LTS를 권장합니다. 위 빌드·테스트는 외부 패키지 설치나 실제 API 키 없이 실행합니다. 로그인·DB·사진 저장의 운영 환경은 Sites 플랫폼이 제공하므로 빌드만으로 로컬에 자동 생성되지는 않습니다. 로컬 화면은 기존 Python 서버로 실행합니다. 자세한 내용은 [배포 소스 안내](sites/deposit-guardian/README.md)를 확인하세요.
