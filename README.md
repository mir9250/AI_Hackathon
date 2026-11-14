# 보증금 지킴이

`feature/security-deposit-rebuild`는 AI_Hackathon의 최신 main에서 시작해 Security_Deposit 구현을 반영한 해커톤 MVP 브랜치입니다. 기존 main과 커밋 이력은 보존하며 병합·배포는 수행하지 않습니다.

현재 구현: Supabase Auth·프로필·주택, 입실/퇴실 사진 업로드·조회·AI 분석/비교, 계약서 PDF/이미지 등록·조회·동의 기반 AI 분석, 사진·계약서 삭제와 실패 재시도, 공통 AI 호출 한도입니다. 기능별 실제 환경 검증 이력과 미검증 범위는 docs/verification.md를 참고하세요. 이번 브랜치 업로드는 모의 외부 서비스와 로컬 DB 테스트만 실행합니다.

팀 협업 규칙 `AGENTS.md`는 유지했습니다. 기존 팀 화면·로고·Sites 설정·README·배포 안내는 `legacy/ai-hackathon-main/`에 원본 그대로 보존합니다. 현재 실행 대상은 frontend/와 backend/이며 legacy/와 api_practice/는 서비스 진입점이 아닙니다. Render 준비는 [DEPLOYMENT.md](DEPLOYMENT.md)를 참고하세요.

## 프로젝트 구조

```text
frontend/                  Vite + HTML/CSS/Vanilla JavaScript
  src/app.js               회원가입·로그인·프로필·주택 화면
  src/api.js               Bearer 토큰·JSON/multipart·오류·시간초과 처리
  src/photos.js            입실 사진·공통 파일 검사
  src/moveout.js           퇴실 선택·업로드·사진 쌍·비교 결과
  src/contracts.js         PDF/사진 계약서 등록·순서·완료·조회
  tests/                   UI·API 클라이언트·임베디드 DB 자동 테스트
backend/
  main.py                  uvicorn main:app 진입점
  app/config.py            환경변수 검증
  app/gateway.py           Supabase Auth 검증·PostgREST 저장
  app/api.py               보호 API·오류 처리·CORS
  app/schemas.py           Pydantic 요청·응답 스키마
  app/photos.py            이미지 검사·Storage·메타데이터·signed URL
  app/analysis.py          입실 분석·공통 AI 처리 흐름
  app/comparison.py        두 이미지 비교·연결 검증
  app/contracts.py         PDF/이미지 검사·원본 저장·완료·조회
  app/upload_limit.py      multipart 요청 본문 크기 제한
supabase/migrations/       001: 9개 테이블·RLS·버킷, 002: 입실 AI, 003: 퇴실 비교
tests/                     백엔드 자동 테스트
docs/architecture.md       전체 설계·20개 API·후속 단계 경계
docs/verification.md       검증 결과와 한계
render.yaml                향후 배포용 설정 예시 (미배포)
```

## 준비

Python **3.13.9**, Node.js **22.16.0**을 기준으로 실행합니다. 버전은 `backend/.python-version`, `frontend/.node-version`에 고정했습니다. 이번 환경에서는 Python 3.14.5로 테스트했으므로 3.13.9 실행은 별도 확인이 필요합니다.

프로젝트 루트에서:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.txt
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cd frontend
npm ci
```

현재 작업 환경에는 별도로 `.tools/node-v22.16.0-darwin-arm64/`에 Node.js를 설치했습니다. 이 Mac에서 시스템에 Node.js가 없다면 프로젝트 루트에서 다음 명령을 먼저 실행할 수 있습니다. 다른 OS·CPU에는 이 바이너리를 사용하지 마세요.

```bash
export PATH="$PWD/.tools/node-v22.16.0-darwin-arm64/bin:$PATH"
```

`.env`, `.venv`, `.tools`, `node_modules`, `dist`는 Git에서 제외됩니다. API 키나 실제 계약서·사진을 저장소에 넣지 마세요.

## Supabase 설정 (사용자가 직접 실행)

실제 연결을 시작할 때는 [단계별 연결·승인·확인 안내](docs/supabase-setup.md)를 따릅니다. `.venv/bin/python scripts/check_setup.py`로 비밀값 출력이나 외부 요청 없이 로컬 설정을 점검할 수 있습니다.

1. Supabase 프로젝트에서 SQL Editor를 열고 `supabase/migrations/202611140001_initial.sql` 전체를 **한 번** 실행합니다. 테이블 생성부터 비공개 `deposit-private` 버킷 생성까지 한 트랜잭션으로 수행합니다. 기존 동일 이름 테이블·버킷이 있는 프로젝트에는 그대로 재실행하지 마세요.
2. Auth에서 이메일·비밀번호 로그인을 활성화하고 이메일 확인 정책을 정합니다. 이메일 확인이 켜져 있으면 확인 메일의 링크를 누른 후 로그인해야 합니다.
3. Auth URL Configuration의 Site URL과 Redirect URLs에 로컬 프론트 주소 `http://localhost:5173`을 등록합니다. 배포 시에는 실제 프론트 URL도 등록합니다.
4. 프로젝트 URL과 publishable key(또는 기존 anon key)를 `frontend/.env`에 입력합니다. **Secret Key는 frontend에 넣지 않습니다.**
5. 동일 프로젝트 URL, Publishable Key와 Secret Key를 `backend/.env`에 입력합니다. 이 단계에서 OpenAI 키는 비워 둡니다.

서버는 토큰의 발급자·만료·대상·역할을 확인하고, **Supabase Auth의 `/auth/v1/user` 서버 검증이 성공한 경우에만** 사용자 ID를 신뢰합니다. 로컬 JWT 디코딩 자체를 서명 검증으로 취급하지 않습니다. DB 요청에도 해당 사용자 JWT와 사용자 ID 필터를 함께 전달해 RLS를 적용합니다. [Supabase JWT 공식 지침](https://supabase.com/docs/guides/auth/jwts), [RLS 공식 지침](https://supabase.com/docs/guides/database/postgres/row-level-security)을 기준으로 구성했습니다.

### 시연 계정 준비

- 실제 시연 전에 회원가입 → 이메일 확인 → 로그인 → 프로필·주택 저장 → 로그아웃 → 재로그인 후 재조회를 확인합니다.
- 두 계정으로 각각 다른 이름·주소를 저장하고 서로의 기록이 보이지 않는지 확인합니다.
- 필요하면 Supabase Dashboard에서 미리 시연용 사용자를 생성·확인 처리합니다. 확인 이메일이 필요한 계정은 반드시 실제 확인 절차를 완료합니다.
- 기본 이메일 발송에는 횟수·수신자 제한이 있으므로 시연 직전에 반복 가입하지 마세요. 프로젝트의 최신 Auth rate limit·이메일 발송 설정을 확인하고, 필요하면 사전에 별도 SMTP를 설정합니다. [공식 발송 제한 안내](https://supabase.com/docs/guides/auth/rate-limits).
- 시연 당일 기존 계정으로 로그인할 수 있는지 다시 확인합니다. 현재 자동 테스트는 실제 메일 발송과 로그인을 검증하지 않습니다.

## 환경변수

| 위치 | 변수 | 현재 용도 |
|---|---|---|
| frontend | `VITE_API_BASE_URL` | FastAPI origin, 로컬 `http://localhost:8000` |
| frontend | `VITE_SUPABASE_URL` | Supabase 프로젝트 origin |
| frontend | `VITE_SUPABASE_PUBLISHABLE_KEY` | 공개 키 |
| backend | `SUPABASE_URL` | 동일 Supabase 프로젝트 origin |
| backend | `SUPABASE_PUBLISHABLE_KEY` | 사용자 JWT와 함께 Auth·DB 요청에 사용 |
| backend | `SUPABASE_SECRET_KEY` | 소유권 확인 후 Storage·사진 삽입·AI 상태 RPC |
| backend | `CORS_ORIGINS` | 정확한 프론트 origin의 JSON 배열 |
| backend | `APP_ENV` | 실행 환경 이름 |
| backend | `OPENAI_API_KEY`, `OPENAI_MODEL` | 입실 사진 분석, 기본 gpt-5.4-mini |
| backend | `AI_DAILY_REQUEST_LIMIT` | KST 하루 실제 호출 예약 상한, 1~30, 기본 30 |
| backend | `OPENAI_REQUEST_TIMEOUT_SECONDS` | AI 호출별 제한, 1~60초, 기본 60 |

`CORS_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]`처럼 설정하며 끝에 `/`를 붙이지 않습니다. 외부 origin은 HTTPS만 허용합니다. Vite 환경변수 변경은 개발 서버 재시작 또는 재빌드가 필요합니다. 환경변수 오류는 오류 필드 이름만 출력하며 비밀값을 출력하지 않습니다. Health는 외부 서비스 상태가 아닌 서버 생존 상태를 나타냅니다.

## 실행

터미널 1 — **backend 디렉터리에서 실행**해야 `.env`와 `main:app` 위치가 일치합니다.

```bash
cd backend
../.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

터미널 2:

```bash
cd frontend
npm run dev
```

- 프론트: `http://localhost:5173`
- Health: `http://localhost:8000/api/health`
- API 문서: `http://localhost:8000/docs`

프론트에서 회원가입·로그인 후 프로필과 주택을 각각 저장합니다. 두 저장 작업은 독립적이며 하나의 저장이 다른 폼의 작성 중인 내용을 지우지 않습니다. 다시 로그인하면 실제 API에서 저장된 정보를 조회합니다. 주택 등록 후 입실 사진 등록·조회 버튼을 사용할 수 있습니다. 입실 AI 분석은 별도 002 SQL 적용과 API 키 설정 후 사용할 수 있습니다. 퇴실 메뉴는 003 SQL 적용 후 AI 비교까지 사용할 수 있습니다. 계약서 등록·조회는 계약서 분석 메뉴에서 제공하며 계약서 AI는 준비 중입니다.

## 자동 테스트 및 빌드

실제 API 키가 필요하지 않고 외부 Supabase·OpenAI에 연결하지 않습니다.

```bash
# 프로젝트 루트
.venv/bin/python -m pytest
# 실제 로컬 서버 기동 확인 (외부 API 호출 없음, 종료까지 자동 처리)
.venv/bin/python tests/smoke_local.py

cd frontend
npm test
npm run build
```

`npm test`는 jsdom의 UI 흐름과 PGlite의 임베디드 PostgreSQL 테스트를 함께 실행합니다. PGlite 테스트의 `auth.users`, `auth.uid()`, `storage.buckets`는 로컬 fixture입니다. 실제 Supabase Auth·Storage 동작을 재현하거나 검증한 것으로 보지 않습니다.

## 현재 API

| 메서드 | 경로 | 인증 | 요청 |
|---|---|---|---|
| DELETE | `/api/photos/{photo_id}` | Bearer | 사진 및 연결 자료 삭제, 입실의 연결 퇴실은 paired_exit_photo_id로 확인 |
| DELETE | `/api/contracts/{id}` | Bearer | PDF/이미지 계약서·페이지·분석 삭제 |
| GET | `/api/health` | 불필요 | 없음 |
| POST | `/api/photos/{photo_id}/analyze` | Bearer | 없음, 저장된 입실 사진 분석 |
| POST | `/api/move-out/photos` | Bearer | multipart: file·paired_entry_photo_id·upload_id |
| GET | `/api/move-out/photos` | Bearer | 없음, 사진 쌍·비교 결과·signed URL |
| POST | `/api/move-out/photos/{photo_id}/compare` | Bearer | 없음, 저장된 입실·퇴실 사진 비교 |
| POST | `/api/contracts` | Bearer | JSON: source_type·upload_id |
| POST | `/api/contracts/{id}/pdf` | Bearer | multipart: file |
| POST | `/api/contracts/{id}/pages` | Bearer | multipart: file·page_number |
| POST | `/api/contracts/{id}/analyze` | Bearer | JSON: consent=true, 계약서 전체 AI 분석 |
| POST | `/api/contracts/{id}/complete` | Bearer | JSON: all_pages_confirmed=true |
| GET | `/api/contracts` | Bearer | 없음 |
| GET | `/api/contracts/{id}` | Bearer | 없음 |
| POST | `/api/move-in/photos` | Bearer | multipart: file·location·upload_id |
| GET | `/api/move-in/photos` | Bearer | 없음 |
| GET | `/api/profile` | Bearer | 없음 |
| PUT | `/api/profile` | Bearer | `{"display_name":"세입자"}` |
| GET | `/api/house` | Bearer | 없음 |
| PUT | `/api/house` | Bearer | `{"name":"나의 집","address":"서울시 ..."}` |

성공은 `{"data": ...}`, 실패는 `{"error":{"code":"...","message":"...","retryable":false}}`입니다. 미등록 프로필·주택은 `{"data":null}`을 반환합니다. 필수 문자열은 앞뒤 공백을 제거하고, 이름·별칭은 1~80자, 주소는 1~500자로 검사합니다. 이 길이는 누락된 입력 경계값을 구체화한 구현 결정입니다. 사용자 ID·주택 ID 등의 임의 추가 필드는 422로 거절합니다. CORS preflight는 표준 CORS 응답으로 처리합니다.

## 배포 준비와 중단 경계

현재 입실·퇴실 사진과 계약서 등록·조회·AI 분석을 로컬 구현했습니다. 계약서 AI는 [구현·004 적용·수동 테스트 안내](docs/contract-analysis.md)를 참고하세요. 기존 001·002·003은 변경하지 않았으며, 새 004 SQL은 사용자 검토·승인 후 Supabase SQL Editor에서 직접 적용해야 합니다. 실제 Supabase RPC 및 계약서 OpenAI 호출은 아직 실행하지 않았습니다. 이번 작업에서 외부 데이터 변경·유료 호출·Render 배포·GitHub push는 하지 않았습니다. 사진·계약서 삭제를 로컬 구현했으며 별도 [005 적용 및 삭제 테스트 안내](docs/resource-deletion.md)를 참고하세요. 실제 적용·삭제는 수행하지 않았습니다. Render 배포는 이번 범위에 포함하지 않습니다.
