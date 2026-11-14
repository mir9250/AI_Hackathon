# 돌려받집 — 입주·퇴실 기록 및 보증금 정산 준비

서버를 새로 개발하기 위해 기존 Python 서버, Worker API, DB 스키마·마이그레이션, 서버 전용 빌드·테스트·실행 설정을 제거했습니다.

화면 소스는 그대로 유지합니다.

- `rental-demo/`: HTML, CSS, 브라우저 JavaScript, 로고 및 프런트엔드 테스트.
- `sites/deposit-guardian/app/`: 기존 배포용 화면 소스.

## 화면 실행

프로젝트 루트에서 Python 기본 정적 파일 서버로 화면을 확인할 수 있습니다. 별도 패키지나 API 키는 필요하지 않습니다.

```bash
python3 -m http.server 8001 --bind 127.0.0.1 --directory rental-demo
```

http://localhost:8001/ 에 접속합니다. 이 명령은 화면 파일만 제공합니다. AI 분석, 로그인, 계정별 클라우드 저장·동기화 API는 새 서버를 연결하기 전까지 사용할 수 없습니다. 기존 화면의 API 호출 코드는 새 서버 연결을 위해 보존했습니다.

## 프런트엔드 검증

```bash
node --check rental-demo/app.js
node rental-demo/smoke-test.cjs
node rental-demo/ai-smoke-test.cjs
node rental-demo/photo-flow-test.cjs
node rental-demo/ai-unconfigured-test.cjs
node rental-demo/storage-smoke-test.cjs
node rental-demo/records-test.cjs
```

위 테스트의 API 응답은 모의 응답이며 실제 서버 동작 검증이 아닙니다.

협업 규칙은 [AGENTS.md](AGENTS.md), 배포 상태는 [DEPLOYMENT.md](DEPLOYMENT.md)를 참고하세요.
