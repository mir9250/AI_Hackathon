# 계약서 GPT 분석: 로컬 구현 및 실제 연결 절차

## 구현 범위와 입력

`POST /api/contracts/{id}/analyze`, Bearer JWT, JSON `{"consent":true}`. FastAPI가 검증한 사용자 ID만 RPC에 전달한다. 소유권·ready·명시적 동의를 검사하고, 완료 결과는 재사용한다. 기존 목록/상세 GET이 `contract_analyses`를 함께 읽으므로 재로그인 후에도 결과를 조회한다.

PDF는 비공개 Storage의 원본을 20MiB 제한으로 임시 파일에 가져와 PDF 유효성·20페이지·등록 페이지 수를 확인한다. 전체 원본을 base64 `input_file.file_data`로 Responses API에 직접 전달한다. OpenAI Files 업로드나 공개 URL은 사용하지 않는다. 이미지 계약서는 등록된 1~10페이지 원본을 순서대로 가져와 기존 제한된 이미지 디코더로 HEIC를 포함해 JPEG 입력으로 변환하고 페이지 번호와 함께 모두 전달한다. 원본은 바꾸지 않는다. 준비 실패에는 GPT 사용량을 예약하지 않는다. 큰 문서의 동시 메모리 사용을 제한하는 서버 프로세스별 semaphore를 추가했다.

기존 HTTP Responses 연동을 재사용한다. `OPENAI_MODEL` 기본값 `gpt-5.4-mini`, `store:false`, Structured Outputs strict JSON Schema 및 Pydantic 검증을 사용한다. 공식 문서에서 모델의 이미지 입력·Structured Outputs와 PDF 텍스트/페이지 이미지 입력을 확인했다. 실제 모델 호출 호환성은 이번 작업에서 실행 검증하지 않았다.

- [OpenAI PDF/File Inputs](https://developers.openai.com/api/docs/guides/file-inputs)
- [gpt-5.4-mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)

## 응답 구조

아래는 스키마 예시이며 실제 분석 결과가 아니다. API는 이를 상태·요청 ID·모델·동의/처리 시각과 함께 `data`에 반환한다.

```json
{
  "document_quality": "readable",
  "summary": {
    "deposit": null,
    "monthly_rent": null,
    "maintenance_fee": null,
    "contract_period": null,
    "special_clauses_summary": null
  },
  "findings": [{
    "category": "청소비", "priority": "medium", "title": "부담 조건 확인",
    "page_number": 2, "clause_excerpt": "실제 해당 페이지 문구",
    "reason": "검토 이유", "recommended_action": "확인할 사항",
    "evidence_type": "explicit_clause"
  }],
  "checklist": [{"title": "추가 확인", "reason": "확인 이유", "action": "할 일"}],
  "warnings": ["원본과 직접 확인하세요."]
}
```

quality는 readable/partially_readable/unreadable, priority는 high/medium/low, evidence_type은 explicit_clause/ambiguous_clause다. 금액은 원 단위 비음수 정수 또는 null이다. 텍스트 PDF는 해당 페이지의 추출 원문과 인용문을 Unicode·공백 정규화 후 대조한다. 범위 밖 페이지·다른 페이지·불일치 인용문은 findings에서 제외한다. 하나 이상 검증되면 검증된 항목만 저장하고 제외한 항목 번호·페이지·사유를 warnings에 기록한다. 모든 항목이 실패하면 AI_EVIDENCE_MISMATCH 또는 AI_PAGE_RANGE로 실패 처리한다. 스캔/이미지 등 서버 원문 추출 불가 항목도 표시하지 않는다. 모든 인용문이 원문 추출 불가이면 AI_EVIDENCE_UNAVAILABLE로 실패하며, 추출 가능한 PDF 등록을 안내한다. 금액·기간의 정확성을 별도 OCR로 증명하는 구현은 없으므로 원본 대조가 필요하다.

unreadable은 `failed/AI_CONTRACT_UNREADABLE`로 저장하며 summary는 모두 null, findings는 빈 배열로 정리하고 재등록 안내 warnings를 보존한다. 부분 판독은 경고와 확인 가능한 값만 표시한다. 법적 효력·책임의 확정, 외부 법령 검색은 구현하지 않았다.

## DB 및 호출 상태

기존 `contract_analyses`의 계약서당 한 행에 결과 JSON, consent_at, model_name, error_code, started_at/updated_at, active_request_id를 저장한다. `ai_request_logs`에는 contract_analysis 작업과 실제 호출 직전 attempted_at을 기록한다. 사용자 ID는 JWT에서 얻으며 RPC는 service_role만 실행할 수 있다. 조회는 기존 사용자 JWT/RLS를 유지한다.

새 004 SQL의 함수는 다음 세 개다.

- `begin_contract_analysis`: 동의·소유권·ready 확인, 계약서별 잠금, 완료 재사용, 동시 요청 차단, 3분 정체 복구.
- `reserve_contract_ai_attempt`: 기존 002/003과 같은 `ai-usage:{user_id}` advisory lock과 attempted_at 집계로 한국 시간 하루 합산 30회 예약. 자동 재시도도 별도 시도다.
- `finish_contract_ai_attempt`: active_request_id/상태 조건부 저장, 성공/실패·판독 불가 기록, 오래된 결과 차단.

150초 HTTP 처리 제한, 일시 오류만 1회 재시도, 인증/크레딧 오류 무재시도를 적용했다. 영구 백그라운드 작업은 없다. DB 장애로 실패 저장도 실패하면 analyzing이 남을 수 있으며 3분 후 요청으로 복구한다. 로그에는 요청 UUID만 남기고 원문·키·외부 오류 본문을 남기지 않는다.

## 004 적용: 사용자 검토·승인 후 직접 실행

이번 작업에서 실제 SQL/외부 파일 변경/유료 호출은 하지 않았다. 기존 001·002·003 파일은 변경하지 않았다. 새 테이블·컬럼·버킷·RLS 변경은 없고 RPC 세 개만 추가한다.

1. Supabase Dashboard에서 기존 프로젝트 선택 → SQL Editor → New query.
2. `supabase/migrations/202611140004_contract_analysis.sql` 전체를 검토한 뒤 붙여넣는다. 기존 001~003은 재실행하지 않는다.
3. 사용자가 적용을 승인한 뒤 Run. 오류가 있으면 분석 버튼을 실행하지 말고 오류 내용을 확인한다.
4. SQL Editor에서 읽기 전용 확인:

```sql
select routine_name, security_type
from information_schema.routines
where routine_schema='public'
  and routine_name in ('begin_contract_analysis','reserve_contract_ai_attempt','finish_contract_ai_attempt');

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where specific_schema='public'
  and routine_name in ('begin_contract_analysis','reserve_contract_ai_attempt','finish_contract_ai_attempt');
```

세 함수가 SECURITY DEFINER이며 사용자 역할 anon/authenticated/PUBLIC에 EXECUTE가 부여되지 않았는지 확인한다. 함수 소유자의 권한 표시는 정상이다.

## 환경 및 수동 시연

새 환경변수는 없다. `backend/.env`의 기존 `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5.4-mini`, `AI_DAILY_REQUEST_LIMIT=30`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`를 사용한다. 키는 직접 입력하고 채팅/프론트에 넣지 않는다. OpenAI Platform의 Billing에서 API 크레딧과 프로젝트 사용 한도를 확인한다. ChatGPT 구독과 API 결제는 별개다. 실제 호출은 유료다.

1. 004 적용 후 백엔드/프론트를 기존 README 명령으로 실행한다.
2. 테스트 계정으로 로그인 → 계약서 분석 → 가상 계약서 선택 또는 등록 → 모든 페이지 직접 확인 → 등록 완료(ready).
3. PDF 전체/이미지 페이지 수와 원본을 확인한다. 실 개인정보 대신 가상 계약서를 사용한다.
4. 외부 전송 안내와 비용을 읽고 동의 체크 → AI 계약서 분석하기. 이 단계에서 실제 유료 호출이 발생한다.
5. 주요 정보, 주의 조항(실제 페이지 링크/인용문), 체크리스트, 경고를 원본과 비교한다.
6. 새로고침/재로그인 후 동일 결과를 확인한다. 다시 조회해도 새 GPT 호출이 없어야 한다.
7. Supabase Table Editor → contract_analyses에서 completed, consent_at, 결과를 확인한다. ai_request_logs에서 contract_analysis/attempted_at/상태를 확인한다. 개인정보가 들어간 결과를 공개 공유하지 않는다.
8. 실패 시 오류와 경고를 확인한다. 판독 불가라면 선명한 페이지를 새 계약서로 등록한다. 일시 오류는 기존 원본으로 재시도하며 실제 호출 시도 한도에 포함된다.

## 자동 검증과 남은 한계

외부 연결 없이 모의 HTTP OpenAI/Storage/PostgREST와 PGlite에 실제 001~004 SQL을 적용해 검증한다. 정상 2페이지 PDF 전체 바이트 전달, 이미지 순서/HEIC, 인용문/페이지 검증, schema, null, 판독 불가, 동의·소유권·ready, 캐시/동시 요청, 공유 30회 한도, 재시도/시간초과/정체 복구/재조회, UI와 기존 기능 회귀를 확인한다.

최초 구현 당시 `tests/fixtures/dummy_rental_contract.pdf`가 없어 별도 가상 테스트를 사용했다. 이후 사용자가 실제 파일을 제공했으며, 현재는 [실제 PDF 진단·회귀 테스트](contract-pdf-diagnosis.md)로 추출 및 인용문을 검증했다. 아래 내용은 최초 구현 때의 이력이다: 대신 테스트 안에서 텍스트가 있는 가상 2페이지 PDF(보증금·월세·관리비·청소비·벽지/장판·원상복구)를 메모리로 생성해 모의 결과를 검증한다. 실제 해당 PDF의 내용이나 GPT의 추출 정확도를 검증했다고 간주하지 않는다.

실제 Supabase RPC, OpenAI PDF 입력, 한국어/스캔 품질 및 모바일 시각 레이아웃은 사용자 승인 후 실연동 검증이 필요하다. `store:false`는 응답 저장 비활성화 옵션이며 외부 제공자의 모든 보관 정책 부재를 뜻하지 않는다.


## 첫 실연동 AI_EVIDENCE_MISMATCH 수정

코드에서 확인한 발생 조건은 정규화된 인용문이 지정 페이지에 포함되지 않거나, 추출 불가/짧은 페이지의 인용문이 다른 페이지에 존재하는 경우였다. 단 한 항목만 실패해도 예외로 전체를 종료했고, 실패 저장은 result=None이므로 summary/document_quality가 NULL이 됐다. 이번 요청의 실제 모델 응답은 보관하지 않아 어떤 문구가 어긋났는지는 소급 확인하지 못했다.

pypdf는 OCR을 실행하지 않는다. 기존 코드는 추출 예외, 100,000자 초과, 대체문자 U+FFFD 포함을 대조 불가(None)로 처리한다. 한글은 추출된 Unicode 그대로 NFKC와 공백 제거를 거쳐 비교했다. 텍스트 레이어가 일부만 있거나 글꼴 매핑/읽기 순서가 잘못된 경우, 시각 입력과 추출 텍스트가 다를 가능성은 있으나 이번 PDF에서 확인된 사실은 아니다.

현재 비교는 기존 NFKC·공백 제거에 zero-width space/BOM/soft hyphen 같은 비가시 서식 문자 제거만 추가했다. 짧은 페이지도 실제 텍스트가 있으면 비교하며 기존 20자 휴리스틱을 없앴다. 숫자·단위·기간·부정문·문장부호·유사 문장에 대한 느슨한 일치나 금액 변환은 없다. `150,000원`과 `15만 원`도 자동으로 같은 인용으로 인정하지 않는다. 프롬프트는 표기까지 그대로 복사하도록 강화했다.

진단 로그 `CONTRACT_EVIDENCE_REJECTED`에는 finding 순번, 지정 페이지, 다음 사유만 기록한다: page_out_of_range / wrong_page / source_unavailable / quote_mismatch. 원문·인용문·이름·주소·키·경로는 기록하지 않는다. 부분 실패 결과는 원본 인용문을 경고에도 복사하지 않으며 금액 요약 검증과 인용문 검증을 구분해 안내한다.

모든 항목이 실패한 기존 계약서는 백엔드 재시작/프론트 재빌드 후 같은 ready 계약서를 선택하고 다시 동의해 재시도할 수 있다. failed 상태이므로 캐시된 completed 결과에 막히지 않고 기존 원본을 사용한다. 재시도는 유료 실제 호출이며 공통 한도에 포함된다. 원문 추출 불가나 원문에 없는 인용이 계속되면 안전상 계속 실패할 수 있다. SQL 재적용이나 DB 상태 수동 수정은 필요 없다.
