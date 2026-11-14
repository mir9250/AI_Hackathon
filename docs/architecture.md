# 전체 구현 설계와 단계 경계

기준: 사용자 제공 「보증금 지킴이 자연어 명세서 v1.2」. 1·2단계에 이어 입실 사진 업로드·조회·AI 분석을 구현했다. 퇴실 업로드·두 사진 비교도 로컬 구현했다. 계약서 업로드·완료·조회도 구현했다. 계약서 AI도 로컬 구현했으며 실제 RPC·GPT 검증은 남아 있다. 사진·계약서 삭제도 로컬 구현했으며 실제 삭제는 미검증이다. 삭제 상태·경쟁 방어용 005와 절차는 resource-deletion.md를 참고한다. 배포는 미완료다. 계약서 AI 상세는 contract-analysis.md를 참고한다. 계약서 구현은 contracts-upload.md를 참고한다. 퇴실 구현은 move-out-comparison.md를 참고한다. AI 구현은 photo-analysis.md를 참고한다. 사진 구현 상세는 move-in-photos.md를 참고한다.

## 통신과 책임

```text
브라우저 ── Supabase JS SDK ── Supabase Auth
   │                             │
   └─ HTTPS + Bearer ── FastAPI ──┘ /auth/v1/user 검증
                           │
                           ├─ PostgREST (사용자 JWT + 소유자 필터, RLS)
                           └─ Storage / OpenAI Responses API (입실 분석·퇴실 비교·동의한 계약서 전체 분석)
```

프로필·주택 조회·저장은 사용자 인증 토큰을 PostgREST에도 전달한다. 관리자 키만으로 임의 소유자 레코드를 쓰지 않는다. Auth 서비스에서 토큰 서명을 검증하고, 서버에서 프로젝트 발급자·만료·audience·role·사용자 ID의 일치를 추가 검사한다. 이메일 미확인·익명 사용자는 서비스를 이용할 수 없다. 토큰·주소·원문·외부 서비스 오류 본문을 로그나 오류 응답에 넣지 않는다.

프론트 Auth SDK는 세션 저장·갱신을 담당한다. 서비스 API 호출 직전 현재 세션 토큰을 가져온다. 로그아웃 또는 사용자 변경 시 진행 중인 조회를 취소하고 이전 응답이 새 화면을 덮어쓰지 않도록 화면 세대 번호를 확인한다. HTTP 요청은 제한시간을 두고, 느린 서버 연결 안내와 재조회 버튼을 제공한다. 성공 결과와 오류는 별도로 표시한다.

## DB 9개 테이블

정확한 필드·타입·제약은 `supabase/migrations/202611140001_initial.sql`이 기준이다.

| 테이블 | 식별자·관계 | 핵심 제약 |
|---|---|---|
| profiles | user_id → auth.users | 사용자당 1개 |
| houses | house_id / user_id → auth.users | user_id UNIQUE |
| photos | photo_id / house_id / paired_entry_photo_id | 주택별 upload_id UNIQUE, 입실 1개에 퇴실 1개, 같은 주택·입실 stage·위치 확인 |
| analyses | photo_id → photos | 사진당 최신 1개, 입실 사진만 허용 |
| comparisons | exit_photo_id / entry_photo_id → photos | 퇴실당 최신 1개, 실제 연결된 입실 사진만 허용 |
| contracts | contract_id / house_id | 주택별 upload_id UNIQUE, draft/ready/deleting |
| contract_pages | page_id / contract_id | 계약서별 페이지 번호 UNIQUE, 이미지 계약서 draft에만 등록 |
| contract_analyses | contract_id → contracts | 계약서당 최신 1개, unreadable 완료 금지, 분석·완료에 consent_at 필요 |
| ai_request_logs | request_id / user_id / resource_id | 사용자·시각 인덱스, 실제 호출량 예약용 |

모든 시각은 `timestamptz`로 저장한다. 프론트는 `Asia/Seoul`을 지정해 표시한다. 프로필·주택의 소유자와 주택 ID는 수정할 수 없고, 수정 시 생성 시각을 유지하며 updated_at을 갱신한다.

세 분석 테이블의 `active_request_id`는 명세서의 중복·지연 결과 덮어쓰기 방지를 위한 내부 보완 필드다. 테이블 개수와 사용자 기능은 바꾸지 않는다. 입실 AI 처리와 상태·원자적 사용량 예약은 별도 002 SQL과 app/analysis.py에 구현했다. ai_request_logs.attempted_at은 실제 호출 예약과 미호출 작업을 구분하기 위한 내부 보완 필드다.

모든 테이블에 RLS를 적용한다. 프로필·주택만 본인 읽기/삽입/수정을 허용한다. 사진·계약서·결과는 주택 소유권을 따라 본인 읽기만 허용하고, 실제 업로드·분석·삭제는 후속 백엔드에서 검증한 뒤 처리한다. ai_request_logs는 본인 읽기만 허용한다. anon은 모든 서비스 테이블에 접근할 수 없다. 비공개 `deposit-private` Storage 버킷은 20MiB 상한이며 브라우저 직접 파일 접근 정책은 제공하지 않는다. 입실 사진의 임시 signed URL 발급은 구현했으며 나머지 파일 기능은 후속 단계다.

## 20개 서비스 API 추적표

로그인은 별도 FastAPI 경로를 만들지 않고 Supabase Auth SDK를 사용한다.

| 메서드 | 경로 | 구현 단계 |
|---|---|---|
| GET | /api/health | 1 (완료) |
| GET | /api/profile | 2 (완료) |
| PUT | /api/profile | 2 (완료) |
| GET | /api/house | 2 (완료) |
| PUT | /api/house | 2 (완료) |
| POST | /api/move-in/photos | 3 (로컬 구현 완료) |
| GET | /api/move-in/photos | 3 (로컬 구현 완료) |
| POST | /api/photos/{photo_id}/analyze | 4 (로컬 구현 완료) |
| GET | /api/photos/{photo_id} | 3 |
| POST | /api/move-out/photos | 3 (로컬 구현 완료) |
| GET | /api/move-out/photos | 3 (로컬 구현 완료) |
| POST | /api/move-out/photos/{photo_id}/compare | 4 (로컬 구현 완료) |
| POST | /api/contracts | 3 (로컬 구현 완료) |
| POST | /api/contracts/{id}/pdf | 3 (로컬 구현 완료) |
| POST | /api/contracts/{id}/pages | 3 (로컬 구현 완료) |
| POST | /api/contracts/{id}/complete | 3 (로컬 구현 완료) |
| POST | /api/contracts/{id}/analyze | 4 |
| GET | /api/contracts | 3 (로컬 구현 완료) |
| GET | /api/contracts/{id} | 3 (로컬 구현 완료) |
| DELETE | /api/contracts/{id} | 3 |

## 후속 단계의 필수 구현 사항

3단계: 파일별 업로드·실제 형식/크기/해상도 검사·HEIC preview·PDF 유효성/암호화/페이지 수 검사, 원본 보존, 제한된 크기의 임시 처리, upload_id 재전송 일관성, Storage 실패·DB 실패 보상 정리와 정리 실패 로그, 계약서 전체 페이지 사용자 확인, 부분 삭제의 deleting 재시도, 소유권 확인 후 signed URL 발급·재발급.

4단계: Responses API + Pydantic Structured Outputs, 계약서 전송 동의 기록, 문서 내 명령 무시, store=false, 판독 불가 숫자 null·실제 인용 검증, unreadable 재업로드 오류, 균형 잡힌 입실 의심 분석·촬영 차이를 고려한 퇴실 비교, 분석 status·오류 구분, 동시 시작 방지와 active_request_id 조건부 결과 저장, KST 날짜별 실제 호출 시도 DB 원자 예약(자동 재시도 포함 30회), 일시 오류만 1회 재시도, 인증·크레딧 오류 무재시도, 저장된 원본 재사용, 시작/요청 시 3분 이상 정체 작업 복구, HTTP 내 처리와 타임아웃 실패 기록. 지속 백그라운드 작업은 사용하지 않는다.

5단계: 명세서 10개 화면 완성, 승인된 실제 Supabase·OpenAI·Render 검증, 모바일 시연·유휴 후 접속·서버 재시작 후 재조회. 사용자 승인 없이 유료 GPT·실배포·push를 실행하지 않는다.
