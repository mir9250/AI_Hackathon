# Supabase 실제 연결 절차

마이그레이션·인증·프로필·주택 코드는 이미 구현되어 있다. 실제 프로젝트에는 아직 연결하지 않았다. 마지막 로컬 점검에서 `.env`의 Supabase URL과 키는 예시값이었다. 사용자 제공 원본 「보증금 지킴이 — 자연어 명세서 v1.2」를 기준으로 기존 구조를 유지하며, 우선 아래 5개 API의 실제 동작을 확인한다.

| API | 확인할 동작 |
|---|---|
| GET /api/health | 인증 없이 서버 응답 |
| GET /api/profile | 등록 전 null, 저장 후 이름 조회 |
| PUT /api/profile | 가상 이름 저장·수정 |
| GET /api/house | 등록 전 null, 저장 후 주택 조회 |
| PUT /api/house | 가상 주택 저장·수정, 기존 주택 ID 유지 |

## 1. 로컬 환경변수 입력

키는 채팅에 보내지 말고 에디터에서 `.env`에 직접 입력한다. 기존 파일을 예시 파일로 덮어쓰지 않는다.

| 파일 | 변수 | 입력값 |
|---|---|---|
| frontend/.env | VITE_API_BASE_URL | http://localhost:8000 |
| frontend/.env | VITE_SUPABASE_URL | Dashboard의 프로젝트 URL |
| frontend/.env | VITE_SUPABASE_PUBLISHABLE_KEY | publishable 키 또는 기존 anon 키 |
| backend/.env | SUPABASE_URL | 프론트와 동일한 프로젝트 URL |
| backend/.env | SUPABASE_PUBLISHABLE_KEY | 프론트와 동일한 publishable 키 |
| backend/.env | SUPABASE_SECRET_KEY | secret 키 (관리자 작업 전용) |
| backend/.env | CORS_ORIGINS | ["http://localhost:5173","http://127.0.0.1:5173"] |

프로젝트 Connect 또는 Settings의 API Keys에서 확인한다. 사용자 Auth 검증·프로필·주택 DB 요청은 publishable 키와 사용자 JWT를 사용한다. Secret Key는 소유권 확인 후 사진 Storage 저장·정리·서명과 사진 메타데이터 삽입에 사용한다. 기존 프로필·주택 요청에는 사용하지 않는다. 최신 키의 실연동은 아직 수행하지 않았다. DB 비밀번호는 현재 Auth·PostgREST 연결에 필요 없다. OPENAI_API_KEY는 비워 둔다.

프로젝트 루트에서 값 노출 없이 오프라인 검사:

```bash
.venv/bin/python scripts/check_setup.py
```

이 검사는 키의 진위나 실제 테이블 존재 여부를 확인하지 않는다.

## 2. 외부 변경 승인

사용자 확인 전 SQL 적용·Auth 설정 변경·실제 회원 생성·데이터 저장은 실행하지 않는다.

승인 대상 SQL: `supabase/migrations/202611140001_initial.sql`.
이 SQL은 9개 테이블, 인덱스·트리거·RLS·역할별 권한과 비공개 deposit-private 버킷(20MiB)을 한 트랜잭션으로 생성한다. 데이터 삭제 명령은 없지만 동일 이름 객체가 존재하면 실패하므로 한 번만 적용한다. 프로젝트가 Healthy여도 적용 여부는 별도다. 기존 객체가 있으면 먼저 확인하고 SQL을 반복 실행하지 않는다.

승인 후 SQL Editor에서 해당 파일을 실행하고, Authentication에서 이메일 로그인을 활성화한다. 이메일 확인을 사용하는 경우 확인 메일 링크를 누른 뒤 로그인한다. URL Configuration의 Site URL은 `http://localhost:5173`, Redirect URLs에는 `http://localhost:5173` 및 `http://127.0.0.1:5173`을 등록한다.

## 3. 직접 실행·확인

터미널 1 (프로젝트 루트에서):

```bash
cd backend
../.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

터미널 2 (프로젝트 루트에서):

```bash
export PATH="$PWD/.tools/node-v22.16.0-darwin-arm64/bin:$PATH"
cd frontend
npm run dev
```

1. http://localhost:8000/api/health 응답 확인. 이는 외부 DB 연결 성공을 뜻하지 않는다.
2. http://localhost:5173 에서 회원가입 → 이메일 확인 → 로그인.
3. 표시 이름 `시연 사용자 A`, 주택 이름 `해커톤 테스트 주택`, 주소 `테스트시 가상구 예시로 123`을 저장한다. 두 폼은 별도로 저장한다. 실제 개인정보는 사용하지 않는다.
4. 새로고침 및 로그아웃·재로그인 후 값이 유지되는지 확인.
5. 다른 테스트 계정에는 이전 계정의 이름·주소가 보이지 않는지 확인.
6. 주택 정보를 수정하고 재조회. 기존 주택이 중복 생성되지 않는지 Dashboard에서 확인.

브라우저 개발자 도구 Network에서 위 5개 경로의 정상 응답을 확인한다. 토큰이 포함된 요청 헤더나 HAR 파일은 공유하지 않는다. Dashboard의 Table Editor에서 profiles·houses에 테스트 계정의 행이 생겼는지 확인한다. 사용자 간 격리는 관리자 Dashboard 화면이 아니라 각 계정으로 로그인한 앱에서 확인한다.

설정 변경 후 개발 서버를 재시작한다. 실패 시 오류 코드·화면 문구만 공유하고 키·비밀번호·토큰·실제 주소는 공유하지 않는다. 이메일 제한이 발생하면 반복 가입을 중지하고 프로젝트 발송 설정을 확인한다.

공식 자료: [API 키](https://supabase.com/docs/guides/getting-started/api-keys), [리디렉션 URL](https://supabase.com/docs/guides/auth/redirect-urls).
