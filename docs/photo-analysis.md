# 입실 사진 AI 분석 — 명세서 v1.2

이번 단계는 입실 사진 한 장의 분석·결과 저장·표시만 구현한다. 기본 모델은 `gpt-5.4-mini`를 유지한다. [공식 모델 문서](https://developers.openai.com/api/docs/models/gpt-5.4-mini)에서 이미지 입력, Responses API, Structured Outputs 지원을 확인했다. 실제 프로젝트의 모델 사용 권한·크레딧은 유료 호출 없이 확인하지 않았다.

## 데이터 흐름과 API

`POST /api/photos/{photo_id}/analyze` → 기존 JWT 서버 검증 → publishable 키+JWT로 본인 주택·입실 사진 조회 → DB 작업 잠금 → 비공개 Storage 이미지 읽기 → 분석용 JPEG 변환 → 호출 직전 DB 원자 예약 → OpenAI Responses API → Pydantic 검증 → 요청 ID를 대조하여 분석과 호출 로그 저장 → `data`로 분석 행 반환.

- 사용자 권한 조회와 기존 GET 목록의 RLS를 유지한다. 관리자 SQL 함수도 사용자·사진·주택 소유권과 stage=entry를 재검사한다.
- 이미지 자체는 사용자/주택 경로를 확인한 뒤 서버에서만 읽는다. OpenAI에 공개 URL이나 signed URL을 전달하지 않고 최대 2048픽셀 JPEG data URL을 전달한다. 원본·Storage는 변경하거나 삭제하지 않는다.
- 촬영 위치는 JSON 데이터로 함께 전달한다. 사진 속 지시문과 위치 문자열을 프로그램 지침으로 취급하지 않는다.
- `store=false`, Responses API의 `text.format.type=json_schema`, `strict=true`를 사용한다. 기존 httpx로 공식 REST API를 호출하므로 SDK의 숨은 자동 재시도는 없다.
- 결과 필드는 `overall_result`와 `damages`뿐이다. damages 항목은 type/status/description/recommendation을 포함한다. `none`은 빈 배열, `suspected`는 하나 이상의 항목이어야 한다. 잘못된 응답·거절·미완료는 completed로 저장하지 않는다.
- `data`에는 photo_id, status, overall_result, damages, model_name, error_code, started_at, updated_at, active_request_id가 포함된다. 기존 GET /api/move-in/photos도 분석 행을 반환한다.

## 추가 SQL — 아직 외부에 적용하지 않음

기존 초기 마이그레이션을 재실행하지 않는다. 별도 승인 후 다음 파일만 한 번 적용한다.

`supabase/migrations/202611140002_photo_analysis.sql`

기존 9개 테이블과 RLS를 유지하면서 다음을 추가한다.

1. `ai_request_logs.attempted_at timestamptz` 및 집계 인덱스. 이미지 준비 실패 등의 미호출 작업과 실제 호출 예약을 구분하기 위한 내부 필드다.
2. `begin_photo_analysis`: 사진 단위 트랜잭션 advisory lock, 소유권 재확인, 완료 결과 재사용, 동시 시작 차단, 3분 정체 작업 복구.
3. `reserve_photo_ai_attempt`: 사진 잠금과 사용자 단위 트랜잭션 advisory lock 안에서 한국 시간 날짜별 예약 수를 확인·기록한다. 설정값을 넘지 않고 SQL에서도 최대 30회로 제한한다. 자동 재시도마다 새 예약 행을 만든다.
4. `finish_photo_ai_attempt`: 상태가 analyzing이고 active_request_id가 같은 경우에만 결과·오류를 기록한다. 오래된 응답은 superseded로 거절한다.

세 함수는 SECURITY DEFINER이며 search_path를 고정하고 service_role만 실행할 수 있다. 일반 브라우저 사용자의 함수 실행 권한을 추가하지 않는다. 향후 비교·계약서 분석도 동일한 사용자 사용량 잠금과 attempted_at 집계를 사용해야 합산 30회 제한을 지킬 수 있다.

호출 직전에 예약하지만 서버가 예약 직후 중단되거나 예약 응답 자체가 유실되면 실제 OpenAI 수신 여부와 무관하게 보수적으로 1회가 남을 수 있다. 자동 환급·중복 호출을 하지 않는다. 이 방식은 동시 요청의 한도 초과와 중복 과금을 우선 방지한다.

## 오류·재시도·복구

- 일시적 연결 오류·타임아웃·408·409·일반 429·5xx만 자동 1회 재시도한다. 재시도도 예약 및 호출량에 포함한다.
- 401, 403, 모델 없음, 크레딧 부족 429, 잘못된 입력·결과·거절은 자동 재시도하지 않는다.
- `AI_DAILY_LIMIT`, `AI_CREDIT_REQUIRED`, `AI_AUTH_ERROR`, `AI_MODEL_UNAVAILABLE`, `AI_TIMEOUT`, `AI_INVALID_RESPONSE`, `AI_SETUP_REQUIRED` 등을 기존 error/code/message/retryable 구조로 전달한다.
- 이미지 읽기·변환 실패는 호출 예약 전 발생하므로 유료 호출량에 포함하지 않는다.
- 호출별 타임아웃은 환경변수로 설정하며 1~60초다. 요청 전체는 150초 제한을 두어 3분 정체 기준 전에 종료를 시도한다. 브라우저 분석 요청은 최대 180초 대기한다.
- 상태 저장소 자체가 실패하면 `AI_STATE_SAVE_FAILED request=...`만 기록한다. 사진·AI 원문·키를 로그에 넣지 않는다. 저장 결과가 불확실하면 목록을 다시 조회한다. 실제 완료가 저장됐다면 다음 요청은 재호출하지 않는다.
- 서버가 강제 종료되어 failed 기록도 못 남긴 경우 해당 사진의 다음 분석 요청에서 3분 정체를 복구한다. 영구 백그라운드 작업은 없다.

## 환경변수·크레딧

백엔드 `.env`만 사용한다. 프론트 환경변수는 추가하지 않는다.

```dotenv
OPENAI_API_KEY=직접_입력
OPENAI_MODEL=gpt-5.4-mini
AI_DAILY_REQUEST_LIMIT=30
OPENAI_REQUEST_TIMEOUT_SECONDS=60
```

API 키는 채팅·저장소·프론트에 넣지 않는다. 기존 Supabase 환경변수도 유지한다. OPENAI_API_KEY가 비어 있으면 미분석 사진은 안전한 설정 오류를 반환하며, 저장된 완료 결과는 키 없이도 재조회할 수 있다.

OpenAI Platform의 프로젝트에서 API 키를 만들고 Billing에서 API 크레딧·결제 한도·프로젝트 사용 권한을 확인한다. 결제나 크레딧 구매는 사용자가 직접 진행한다. [공식 결제 안내](https://help.openai.com/en/articles/8264644-setting-up-and-managing-prepaid-api-billing), [Structured Outputs 안내](https://developers.openai.com/api/docs/guides/structured-outputs).

## 승인 후 실연동 순서

이번 개발에서는 아래 외부 작업을 수행하지 않았다. SQL 적용과 실제 유료 호출은 각각 사전 승인 후 진행한다.

1. Supabase SQL Editor에서 002 SQL을 검토하고 한 번 적용한다. 001 초기 SQL은 재실행하지 않는다.
2. 아래 조회 SQL로 추가 컬럼과 함수 3개 존재를 확인한다.

```sql
select column_name from information_schema.columns
where table_schema='public' and table_name='ai_request_logs' and column_name='attempted_at';
select proname from pg_proc where pronamespace='public'::regnamespace
and proname in ('begin_photo_analysis','reserve_photo_ai_attempt','finish_photo_ai_attempt');
```

3. backend/.env에 키·모델·호출 제한·타임아웃을 입력하고 기존 방식으로 백엔드와 프론트를 재시작한다. 새 라이브러리 설치는 필요 없다.
4. 기존 테스트 계정으로 로그인 → 입실 사진 등록·조회 → 저장된 가상 사진 한 장의 **AI 분석하기**를 누른다. 이 동작은 외부 AI 전송과 API 비용을 발생시킨다.
5. 전체 판정·항목별 상태·설명·권장 조치를 확인한다. 새로고침·재로그인 후에도 표시되어야 하며 완료 사진에는 재호출 버튼이 없다.
6. Dashboard에서 analyses의 completed/result/model_name, ai_request_logs의 attempted_at/status를 확인한다. 모의 결과의 정확한 문구나 하자 발견을 실제 모델에 기대하지 않는다.
7. 같은 사진에 POST를 다시 보내도 AI 호출 로그가 증가하지 않는지 확인한다. 다른 테스트 계정에서는 사진과 분석이 보이지 않아야 한다.

## 로컬 검증과 한계

백엔드는 별도 Supabase·OpenAI MockTransport를 사용한다. SQL은 PGlite에서 실제 초기 SQL과 추가 SQL을 실행해 권한·예약·KST 집계·상태 전이를 검사한다. PGlite의 단일 연결은 실제 Supabase의 여러 서버·DB 세션 부하 테스트를 대체하지 않는다. 화면은 jsdom으로 클릭·중복 방지·오류·재조회·HTML escaping을 검증했다. 실제 모델의 판독 품질·API 크레딧·실제 Supabase RPC·브라우저 시각 검수는 미검증이다.
