# 사진·계약서 삭제: 005 검토 및 수동 검증

이번 사진 DELETE는 v1.2의 원래 제외 범위를 사용자의 명시적 요청으로 확장했다. 계약서 DELETE는 기존 v1.2 기능이다. 기존 인증·RLS·비공개 버킷·세 AI 모델/호출 한도를 유지한다. 실제 Supabase 변경·파일 삭제·유료 호출·배포는 실행하지 않았다.

## API와 확인 흐름

- `DELETE /api/photos/{photo_id}`: 입실 또는 퇴실 사진. 연결된 퇴실 사진이 있는 입실 사진은 `?paired_exit_photo_id=<확인한 퇴실 사진 UUID>`가 필요하다. 화면은 삭제 버튼을 누를 때 서버의 기존 퇴실 목록을 다시 읽고, 실제 연결 여부를 안내한 뒤 브라우저 확인창을 표시한다. 서버는 시작 트랜잭션에서 실제 연결을 재검사한다. 확인 후 연결이 바뀌면 `409 DELETE_CONFIRMATION_CHANGED`, 파일 삭제 없음.
- `DELETE /api/contracts/{id}`: PDF·이미지, draft·ready·deleting 모두 삭제/재시도 가능.
- 성공: `{"data":{"deleted":true,"already_deleted":false}}`. 이미 없는 ID는 idempotent 200/already_deleted=true, 타 사용자에게 실제 존재하는 자료는 404. JWT 누락/오류는 기존 401, 잘못된 UUID는 422.
- 파일 경로·사용자 ID는 클라이언트에서 받지 않는다. 검증된 JWT 사용자 ID를 관리자 전용 RPC에 전달한다.

각 화면에 삭제 버튼·명시적 확인창·처리 중 비활성화·실패 메시지를 추가했다. 입실 삭제는 연결된 퇴실과 두 분석 결과까지 삭제함을, 퇴실 삭제는 입실이 보존됨을 안내한다. 계약서는 모든 페이지와 AI 결과 삭제를 안내한다. 삭제 실패 시 성공 표시나 카드 제거를 하지 않는다. 삭제 중 자료는 목록에 남겨 재시도할 수 있고, 부분 삭제된 파일의 signed URL은 새로 발급하지 않는다.

## DB 관계와 실제 삭제 순서

| 관계 | 기존 FK 동작 | 삭제 처리 |
|---|---|---|
| analyses.photo_id → photos | CASCADE | 사진 삭제 시 결과 자동 삭제 |
| photos.paired_entry_photo_id+house_id → photos | 기본 NO ACTION | 연결 퇴실을 먼저 삭제한 뒤 입실 삭제 |
| comparisons.exit_photo_id → photos | CASCADE | 퇴실 삭제 시 비교 자동 삭제 |
| comparisons.entry_photo_id → photos | 기본 NO ACTION | 연결 퇴실/비교를 먼저 정리 |
| contract_pages.contract_id → contracts | CASCADE | 계약서 삭제 시 전 페이지 행 삭제 |
| contract_analyses.contract_id → contracts | CASCADE | 계약서 삭제 시 summary/findings 등 결과 삭제 |
| ai_request_logs.resource_id | FK 없음 | 삭제 리소스의 무작위 UUID와 최소 호출 기록 유지 |
| 분석 active_request_id → ai_request_logs | SET NULL | 로그를 삭제하지 않으므로 사용량 보존 |

입실만 삭제해도 같은 주택의 다른 입실·계약서는 건드리지 않는다. 퇴실만 삭제하면 입실과 그 analyses를 보존하며 새로운 퇴실을 연결할 수 있다. DB 정리는 finish RPC의 단일 트랜잭션으로 수행한다.

`ai_request_logs`의 user_id/task_type/resource_id/status/attempted_at/시각/오류 코드는 보존한다. 이 테이블에는 문서 본문·사진·금액 요약·이름·주소·파일명은 저장하지 않는다. resource_id는 삭제된 리소스를 가리키는 불투명 UUID로 남으며, 물리 리소스와 FK로 연결되어 있지 않다. user_id/attempted_at을 지우지 않으므로 사진·계약서를 재등록해도 KST 공통 30회 한도가 초기화되지 않는다.

## Storage와 DB 사이의 재시도

1. JWT 확인 후 `begin_resource_deletion`이 실제 소유권·연결·AI 상태를 검사한다.
2. 사진은 신규 `photos.deleting=true`, 계약서는 기존 `upload_status=deleting`을 커밋한다. 파일 경로와 연결 행은 그대로 보존한다.
3. 백엔드가 manifest의 소유 주택·리소스·파일 경로를 재검사한다. 사진 원본은 기존 UUID 업로드 폴더, 미리보기는 같은 폴더의 preview.jpg만 허용한다. 계약서는 해당 contract_id의 기존 원본 경로만 사용하고 HEIC 미리보기는 같은 폴더에서 파생한다.
4. Storage remove API에 **정확한 객체 키 목록**을 전달한다. 폴더 열거·광범위 prefix 삭제·Storage SQL DELETE는 하지 않는다.
5. 각 키를 Storage info API로 확인한다. HTTP 200이면 파일이 남았으므로 중단한다. HTTP 400/404와 **NoSuchKey** 코드가 함께 있을 때만 부재로 인정한다. 일반 404, NoSuchBucket, 권한 오류, 잘못된 응답은 부재로 간주하지 않는다.
6. 모든 파일의 부재 확인 후 `finish_resource_deletion`이 종속 행과 대상 DB 행을 삭제한다.

Storage 실패·부분 성공·부재 확인 실패에는 DB 행/경로/삭제 상태를 보존한다. Storage 성공 후 DB 실패에도 동일하다. 서버가 재시작돼도 다음 DELETE가 DB manifest로 경로를 다시 얻고 이미 없는 객체를 포함해 재확인하므로 프로세스 메모리에 의존하지 않는다. 동시 중복 요청도 동일한 불변 경로를 정리하고 DB finish는 이미 없는 리소스에 성공을 반환한다. DB 응답 유실로 최종 커밋 여부가 불명확하면 성공을 추정하지 않고 재시도를 안내한다.

공식 문서: [Storage 삭제](https://supabase.com/docs/guides/storage/management/delete-objects), [객체 info](https://supabase.com/docs/reference/javascript/file-buckets-info), [NoSuchKey/NoSuchBucket 코드](https://supabase.com/docs/guides/storage/debugging/error-codes).

## 분석·업로드와의 경쟁 방지

005의 begin/finish와 리소스 쓰기 트리거는 기존 house 행을 잠가 소유 주택 내 작업을 직렬화한다. Python의 사전 조회만으로 잠금을 대신하지 않는다.

- 분석 중(3분 이내 또는 시작 시각 불명)이면 상태를 바꾸지 않고 409 DELETE_BUSY. 연결 퇴실의 비교가 진행 중이어도 입실 삭제를 거절한다.
- 3분 이상 정체된 analyzing은 같은 트랜잭션에서 failed/AI_STALE로 바꾼 뒤 삭제 상태로 전환한다. 추가 유료 복구 호출은 필요 없다. attempted_at은 보존한다.
- 사진·계약서·페이지·세 분석 테이블의 BEFORE INSERT/UPDATE 방어 트리거가 삭제 중 쓰기를 거부한다. 따라서 기존 002~004 RPC가 사전 조회를 통과해도 새로운 AI 시작/완료 쓰기에서 차단된다. 늦은 결과는 기존 상태/요청 ID 가드 및 삭제 방어에 걸린다.
- 삭제 중 입실에 새 퇴실 연결이나 계약서 페이지 추가를 차단한다. 파일 경로도 DB에서 바꿀 수 없다.
- 기존 RPC와의 행 잠금 경쟁에서 DB가 deadlock/serialization 오류를 반환하면 트랜잭션이 롤백되며 409 재조회/재시도를 안내한다. 영구 백그라운드 작업은 없다.

업로드는 기존처럼 Storage 저장 후 DB 기록, 실패 시 파일 보상 정리를 한다. **DB에 한 번도 기록되지 않은 과거 업로드 고아 파일을 이 삭제 기능이 탐색/정리하는 것은 아니다.** 업로드가 강제 종료되고 기존 보상 정리마저 실행되지 않은 파일은 별도 확인이 필요하다. 이를 찾기 위해 폴더를 광범위하게 삭제하지 않는다.

## 005 적용: 사용자 검토·승인 후 직접 실행

기존 001~004 파일과 9개 테이블 구성을 유지했다. 새 005는 사진 삭제 상태 컬럼 1개, 삭제 시작/종료 RPC, 공통 방어 트리거를 추가한다. 계약서의 기존 deleting을 재사용한다. RPC는 service_role만 호출하며 기존 RLS 정책·Storage 공개 설정은 변경하지 않는다.

1. `supabase/migrations/202611140005_resource_deletion.sql` 전체를 검토한다.
2. Supabase Dashboard → 현재 프로젝트 → SQL Editor → New query.
3. **사용자 승인 후** 005 전체만 붙여넣고 Run. 001~004는 재실행하지 않는다.
4. SQL Editor에서 읽기 전용 확인:

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema='public' and table_name='photos' and column_name='deleting';

select event_object_table, trigger_name, event_manipulation
from information_schema.triggers
where trigger_schema='public' and trigger_name='deletion_guard';

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where specific_schema='public'
  and routine_name in ('begin_resource_deletion','finish_resource_deletion');
```

photos.deleting은 boolean/not null/default false, 6개 테이블에 INSERT/UPDATE 방어가 있어야 한다. 삭제 RPC에 anon/authenticated/PUBLIC EXECUTE가 없어야 한다. 함수 소유자 권한 표시는 정상이다. 적용 전 DELETE는 DELETE_SETUP_REQUIRED로 중단하고 Storage를 변경하지 않는다.

## 실제 가상 자료로 사용자가 직접 확인할 순서

새 환경변수는 없다. 기존 백엔드 Secret Key만 Storage 삭제/RPC에 사용하며 프론트에 전달하지 않는다.

1. 005 적용 후 백엔드 재시작, 프론트 실행 또는 재빌드.
2. 테스트 계정으로 로그인. 지워도 되는 가상 입실 사진 두 장, 한 장에 연결된 가상 퇴실 사진, 가상 PDF, 이미지 계약서 draft/ready를 준비한다. 기존 소중한 자료로 테스트하지 않는다. 삭제 확인만으로 새 GPT 호출은 발생하지 않는다.
3. 퇴실 삭제 → 확인창의 입실 보존 문구 확인 → 삭제. 입실은 남고 해당 위치에 새 퇴실 업로드가 가능해야 한다.
4. 입실 삭제 → 실제 연결 상태와 경고 확인 → 삭제. 연결 퇴실·분석·비교만 없어지고 다른 입실과 계약서는 남아야 한다.
5. PDF와 이미지 계약서를 각각 삭제한다. draft도 확인한다. 목록 갱신, 새로고침/재로그인 후 부재, 기존 계약서 상세 API 404를 확인한다.
6. Table Editor에서 해당 photos/analyses/comparisons 또는 contracts/contract_pages/contract_analyses가 정리됐는지 확인한다. Storage → deposit-private에서 해당 정확한 원본/미리보기 키가 없는지 확인한다.
7. ai_request_logs는 삭제 전후 attempted_at 있는 행 수가 유지되는지 확인한다. 별도 GPT 호출로 한도를 소모할 필요는 없다.
8. 분석 중 삭제는 409여야 한다. 이를 확인하려고 새 유료 호출을 할 필요는 없으며 자동 테스트에서 모의/DB 상태로 검증했다.
9. 오류가 나면 성공으로 간주하지 않는다. 같은 화면의 삭제 버튼으로 재시도한다. 삭제 중에는 AI 분석·페이지 추가 대신 삭제 재시도를 이용한다.

## 검증과 남은 제한

백엔드 282개, 프론트·PGlite DB 76개 전체 테스트 및 프론트 빌드 통과. 테스트는 실제 파일을 삭제하지 않는 모의 Supabase와 로컬 PGlite만 사용한다. 사진 단독/쌍·원본/HEIC preview·계약서 PDF/이미지/draft/ready·종속 데이터·소유권·부분 삭제·DB 실패·재시작·중복 요청·분석 충돌·정체 복구·늦은 결과·한도 보존·확인 취소·UI 재조회와 기존 세 AI 기능 회귀를 검증했다.

실제 Supabase RPC/Storage 삭제, 실제 다중 DB 세션 부하, 모바일 실기기 레이아웃은 아직 검증하지 않았다. PGlite는 DB 순서와 가드를 실행하지만 실제 다중 세션 부하 테스트를 대체하지 않는다. Storage 버전/오류 응답이 예상과 다르면 삭제를 확인하지 못한 상태로 남겨 재시도를 안내하며 DB를 먼저 지우지 않는다.

삭제 완료는 현재 DB/Storage의 정리 확인을 뜻한다. 이미 내려받은 파일·브라우저 캐시·백업·외부 보관본까지 즉시 영구 소거하거나 모든 이전 signed URL의 캐시 접근이 즉시 끝난다고 보장하지 않는다. [Supabase CDN 안내](https://supabase.com/docs/guides/storage/cdn/smart-cdn)도 참고한다.


## 005 적용 전 실제 업로드 경로 최종 대조

`photos.py:upload()`와 `contracts.py:upload()`의 실제 문자열 조립 및 DB INSERT/PATCH를 기준으로 확인했다. 테스트는 이 API에 실제 multipart 파일을 보내 모의 Storage/DB에 생성된 경로를 그대로 검사한다. 유효 경로를 임의로 만들어 넣지 않는다.

공통 접두사 `{user_id}/{house_id}/` 이후 구조:

| 대상 | 실제 원본 경로 | 미리보기 |
|---|---|---|
| 입실·퇴실 사진 | `{photo_id}/original.ext` | HEIC만 같은 폴더 `preview.jpg` |
| PDF 계약서 | `contracts/{contract_id}/pdf/{sha256}/{attempt_uuid}/original.pdf` | 없음 |
| 이미지 계약서 | `contracts/{contract_id}/page-{page_number}/{sha256}/{page_id}/original.ext` | HEIC만 같은 폴더 `preview.jpg` |

사진 업로드의 attempt UUID는 photos.photo_id에도 저장한다. 따라서 삭제 검증은 폴더 UUID가 해당 행의 photo_id와 같아야 한다. 연결 퇴실은 입실 ID가 아니라 퇴실 자신의 photo_id를 검사한다. 이전 검증은 UUID 형식만 검사했으므로 이 연결 검사를 보완했다.

계약서의 `len(parts)==6`은 공통 접두사를 제거한 뒤 contracts/계약서ID/슬롯/해시/업로드UUID/파일명의 여섯 부분으로 정확히 맞는다. 길이는 변경하지 않았다. PDF 슬롯 pdf, 이미지 슬롯 page_number, 이미지 폴더 UUID=page_id, SHA-256 64자리 소문자 hex 형식도 실제 업로드 규칙과 대조한다. 삭제할 때 파일을 재다운로드해 내용 해시를 다시 계산하는 기능은 추가하지 않았다.

경로 검증 실패는 begin RPC가 이미 삭제 상태를 저장한 뒤 발생하지만 파일과 DB 경로를 보존한다. 검증 코드 수정 후 재요청하면 기존 deleting 자료를 다시 읽어 정상 진행한다. 상태 초기화·재업로드·SQL 수정은 필요 없다. 실제 DB 경로 자체가 손상된 경우까지 코드 수정만으로 복구된다는 의미는 아니다.

Storage 공식 소스에서 DELETE `/{bucketName}`에 prefixes 배열, 성공 HTTP 200/객체 배열을 확인했다. GET `/object/info/{bucketName}/{key}`도 공식 경로이며 부재는 NoSuchKey, 본문 statusCode 404이고 실제 HTTP는 400 또는 404일 수 있다. 기존 코드는 이 조합을 처리하고, 일반 404/NoSuchBucket/권한 오류를 부재로 오인하지 않는다. 응답 처리 코드는 변경하지 않았다. 근거: [삭제 라우트](https://github.com/supabase/storage/blob/master/src/http/routes/object/deleteObjects.ts), [info 라우트](https://github.com/supabase/storage/blob/master/src/http/routes/object/getObjectInfo.ts), [에러 직렬화](https://github.com/supabase/storage/blob/master/src/internal/errors/storage-error.ts).

이번 검토에서 backend/app/deletion.py의 경로 검사, tests/test_deletion.py, 이 안내와 verification.md만 변경했다. 신규 15개 테스트를 추가해 백엔드 282개, 프론트/DB 76개가 통과했다. 001~005의 SHA-256은 검토 전후 동일하다. 이번 경로/응답 검토 기준으로 005 SQL 수정 사유는 없으며 사용자 검토 후 기존 파일 그대로 적용할 수 있다. 실제 프로젝트의 Storage 응답·실제 삭제는 여전히 실연동 미검증이다.
