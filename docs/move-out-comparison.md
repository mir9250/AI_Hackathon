# 퇴실 사진 업로드·입실/퇴실 AI 비교

자연어 명세서 v1.2의 퇴실 사진·두 사진 비교 범위만 구현한다. 기존 인증, 주택, 입실 업로드 및 입실 AI 분석을 유지한다. 계약서·PDF·좌표 표시·법적 책임 판정·배포는 제외한다.

## API

| API | 입력·응답 |
|---|---|
| POST /api/move-out/photos | multipart file, paired_entry_photo_id(UUID), upload_id(UUID). photo_id·upload_status=stored·already_uploaded 반환 |
| GET /api/move-out/photos | 본인 퇴실 사진 메타데이터, 연결 입실 사진, 양쪽 signed URL·만료 시각, comparison_status·comparison 반환 |
| POST /api/move-out/photos/{photo_id}/compare | body 없음. 저장된 두 사진을 비교하고 comparisons의 결과 행 반환 |

모두 Bearer 사용자 JWT가 필요하며 data/error 응답 구조를 유지한다. 선택 입실 사진이 본인 주택의 entry인지 RLS로 조회하고 검증한다. 다른 사용자·다른 주택·퇴실 사진을 입실 대상으로 선택할 수 없다. 접근 가능한 입실 사진이 없으면 404, 이미 퇴실 사진이 연결되어 있거나 업로드 ID 충돌이면 409, 파일·필드 오류는 422다.

촬영 위치는 입력받지 않고 입실 사진 값을 복사한다. 기존 이미지 검사·20MiB·20백만 화소/한 변 10,000픽셀·HEIC JPEG 변환·원본 보존·256KiB 전송·실패 파일 정리를 재사용한다. multipart 전체는 입실과 동일하게 21MiB로 제한한다.

주택별 upload_id UNIQUE와 paired_entry_photo_id UNIQUE 및 동일 주택·입실 stage·위치 트리거가 최종 무결성을 보장한다. 성공한 동일 요청은 기존 결과를 반환하고, 다른 stage/입실 대상에 같은 ID를 쓰면 거절한다. 동시 등록 충돌은 패배한 시도의 파일만 정리하고 기존 입실·성공한 퇴실 원본은 보존한다.

## 데이터 흐름과 AI 규칙

1. JWT·주택·입실 사진 소유권 확인 → 퇴실 파일 검사 → 비공개 원본·필요한 JPEG 저장 → stage=exit, paired_entry_photo_id, 입실 location을 photos에 저장.
2. 조회 시 실제 연결된 입실 사진을 다시 확인하고 양쪽 15분 signed URL 발급. 화면의 다시 조회 및 주기적 조회로 재발급.
3. AI 비교 클릭 → 본인 exit와 실제 연결 entry 검증 → 003 함수로 작업 시작·동시성 확인 → 두 Storage 파일을 서버에서 순차적으로 읽고 분석용 JPEG 생성.
4. 호출 직전에 사용자 공통 사용량 예약 → Responses API에 입실, 퇴실 순서로 두 이미지·위치·비교 지침 전달 → Structured Outputs/Pydantic 검증 → 요청 ID 조건부 comparisons 저장 및 호출 로그 완료 → 화면 표시.

기본 모델 gpt-5.4-mini, OPENAI_MODEL, store=false, 기존 환경변수를 사용한다. 새 패키지·환경변수는 없다. 이미지 원본을 바꾸지 않고 공개 URL도 OpenAI에 전달하지 않는다. [공식 이미지 입력 안내](https://developers.openai.com/api/docs/guides/images-vision)에 따라 두 input_image를 하나의 요청에 포함한다.

결과는 overall_result(change_suspected / needs_review / no_visible_change), changes 배열이다. 각 항목은 type/status/description/recommendation이며 좌표 등 임의 필드는 거절한다. no_visible_change는 빈 changes, change_suspected는 하나 이상의 항목이어야 한다. 촬영 각도·거리·그림자·조명·화질 차이는 손상으로 단정하지 않고 불확실하면 needs_review로 표시한다. 실패는 failed이며 변화 미발견으로 표시하지 않는다.

## 003 SQL — 로컬 작성만, 실제 적용 전 승인 필요

`supabase/migrations/202611140003_photo_comparison.sql`

001·002는 수정하지 않았고 재실행하지 않는다. 003은 기존 테이블·컬럼·RLS를 바꾸지 않고 다음 함수 3개와 service_role 전용 실행 권한만 추가한다.

- begin_photo_comparison: exit/entry·소유권 재검사, 사진 단위 트랜잭션 잠금, 완료 결과 재사용, 동시 시작 차단, 3분 정체 작업 복구.
- reserve_photo_comparison_attempt: 002와 같은 `ai-usage:{user_id}` 잠금 및 ai_request_logs.attempted_at의 KST 날짜 집계를 사용한다. 입실 분석·퇴실 비교·자동 재시도를 합산해 설정 한도(최대 30회)를 원자 예약한다. 기존 예약 재사용은 status=analyzing일 때만 허용한다.
- finish_photo_comparison_attempt: status=analyzing 및 active_request_id 일치 시에만 결과·실패 저장. 과거 결과는 최신 상태를 덮어쓰지 못한다.

기존 AI 처리의 일시 오류만 자동 1회 재시도, 크레딧/인증 오류 무재시도, 호출별 최대 60초·전체 150초 제한과 3분 정체 복구를 재사용한다. 완료된 비교는 키나 크레딧이 없어도 결과를 재사용한다. 호출 예약 직후 서버가 중단되면 보수적으로 사용량 1회가 남을 수 있으며 자동 환급·중복 호출은 하지 않는다. 상태 DB 자체가 실패하면 저장 여부 재조회가 필요하고 정체 작업은 다음 요청에서 복구한다. 영구 백그라운드 작업은 없다.

## 승인 후 실제 사진 두 장으로 확인

이번 개발에서는 실제 Supabase DB/Storage 쓰기·삭제·SQL 실행·유료 OpenAI 호출을 하지 않았다. 아래 단계는 각각 사용자 승인 후 진행한다. 개인 식별 정보가 없는 가상 또는 테스트 사진을 사용한다.

1. 기존 001·002 적용 상태에서 SQL Editor → New query에 003 파일 전체를 복사하고 한 번 실행한다. 이전 SQL은 재실행하지 않는다.
2. 함수 존재 여부를 조회한다.

```sql
select proname from pg_proc where pronamespace='public'::regnamespace
and proname in ('begin_photo_comparison','reserve_photo_comparison_attempt','finish_photo_comparison_attempt');
```

3. 기존 .env의 Supabase 설정, OPENAI_API_KEY·OPENAI_MODEL=gpt-5.4-mini·AI_DAILY_REQUEST_LIMIT=30·OPENAI_REQUEST_TIMEOUT_SECONDS=60을 유지하고 두 서버를 재시작한다.

프로젝트 루트, 터미널 1:

```bash
cd backend
../.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

프로젝트 루트, 터미널 2:

```bash
export PATH="$PWD/.tools/node-v22.16.0-darwin-arm64/bin:$PATH"
cd frontend
npm run dev
```

4. http://localhost:5173 에서 기존 계정으로 로그인. 입실 메뉴에서 첫 사진을 등록하거나 기존 입실 사진을 선택한다. 입실 AI 분석을 먼저 할 필요는 없다.
5. **퇴실** → 비교할 입실 사진 선택 → 같은 위치의 두 번째 사진 선택 → **퇴실 사진 업로드**. 위치는 자동 상속되고 입실·퇴실이 나란히 표시되어야 한다.
6. **AI 비교하기**를 누른다. 이 단계는 두 사진 외부 전송과 유료 API 호출을 발생시킨다. 진행 표시 후 전체 판정·변화 항목·설명·권장 조치가 나와야 한다. 실제 사진에 따라 변화 미발견이나 추가 확인 필요도 정상 결과다.
7. 새로고침·재로그인 → 퇴실 메뉴에서 같은 사진 쌍·결과가 유지되는지 확인한다. 완료된 결과에는 재호출 버튼이 없어야 한다. 등록 완료 입실 사진은 선택이 차단되어야 한다.
8. Dashboard의 photos(stage=exit·paired_entry_photo_id·location), comparisons(두 사진 ID·completed·결과), ai_request_logs(task_type=photo_comparison·attempted_at·상태)를 확인한다. 다른 테스트 계정에서 해당 사진이 보이지 않아야 한다.

실제 모델의 비교 품질·Supabase RPC 및 Storage 실연동·브라우저 시각 검수는 아직 미검증이다. 자동 테스트는 외부 HTTP 모의 응답, PGlite SQL 실행 및 jsdom UI 검증을 사용한다. PGlite는 실제 Supabase 다중 세션 부하 테스트를 대체하지 않는다.
