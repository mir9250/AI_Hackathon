# 계약서 업로드·저장·조회 — v1.2

이번 범위는 PDF/이미지 계약서의 등록·완료·목록·상세 조회다. 계약서 GPT 분석·위험 조항 탐지·삭제·배포는 구현하지 않는다. 기존 001·002·003 SQL과 9개 테이블·RLS·비공개 deposit-private 버킷을 유지한다. 새 004 SQL 및 환경변수는 필요 없다.

## API와 요청

| API | 입력 | 결과 |
|---|---|---|
| POST /api/contracts | JSON source_type: pdf 또는 images, upload_id: UUID | draft 계약서 메타데이터·contract_id |
| POST /api/contracts/{id}/pdf | multipart file | 원본 저장 여부, 페이지 수, 중복 재요청 여부 |
| POST /api/contracts/{id}/pages | multipart file, page_number: 1~10 | 페이지 저장 여부·page_id·중복 재요청 여부 |
| POST /api/contracts/{id}/complete | JSON all_pages_confirmed: true | ready 계약서 메타데이터 |
| GET /api/contracts | 없음 | 최신 등록순 본인 계약서 목록·주택·페이지 수·상태·분석 여부 |
| GET /api/contracts/{id} | 없음 | 본인 계약서 메타데이터·정렬된 페이지·임시 URL·분석 연결 정보 |

모든 API는 기존 Bearer JWT 인증 및 data/error 구조를 사용한다. 계약서 목록/상세·자식 페이지 조회는 publishable 키와 사용자 JWT로 RLS를 적용하고, 검증된 사용자 ID로 조회한 주택의 house_id를 추가 필터로 사용한다. 다른 사용자 계약서는 404로 숨긴다. 클라이언트 user_id/house_id를 저장 주체로 사용하지 않는다. source_type은 DB와 동일하게 소문자 pdf/images다.

기존 contracts·contract_pages의 브라우저 쓰기 정책이 없으므로 검증된 소유권·등록 상태를 확인한 뒤 백엔드 secret 키로 최소한의 삽입/조건부 갱신·Storage 저장·서명을 수행한다. contract_analyses에는 어떤 모의 결과도 쓰지 않는다. 분석 행이 없으면 analysis=null, analysis_status=not_analyzed다.

## 검증 및 저장

PDF: 확장자 .pdf, MIME application/pdf, 실제 %PDF- 헤더, 0바이트 초과·20MiB 이하, 1~20페이지. pypdf의 strict 모드에서 문서 구조·페이지·페이지 내용 연산을 파싱하고 암호화·손상·과도한 파싱 작업을 거절한다. 문서 텍스트를 추출하거나 문서의 명령을 실행하지 않는다. 파서 원문 경고는 로그에 출력하지 않는다. PDF 검증은 모든 PDF 뷰어에서의 완벽한 렌더링을 보장하지 않으므로 실제 브라우저 원본 열기도 확인해야 한다. [pypdf 공식 문서](https://pypdf.readthedocs.io/en/stable/modules/PdfReader.html).

이미지: 기존 사진 기능의 JPG/JPEG/PNG/HEIC/WEBP·20MiB·실제 디코딩·손상 검사·해상도 상한(2천만 화소/한 변 10,000픽셀)을 재사용한다. 계약서당 10페이지, 각 페이지 번호 1~10이며 중복 슬롯은 교체하지 않는다. HEIC는 JPEG 미리보기를 함께 만든다.

원본은 수정하지 않으며 사용자/주택/계약서별 경로 아래 저장한다.

```text
{user_id}/{house_id}/contracts/{contract_id}/{pdf 또는 page-N}/{sha256}/{attempt_uuid}/original.ext
HEIC: 같은 폴더의 preview.jpg
```

파일 해시를 내부 경로에 보관해 별도 컬럼 없이 같은 페이지/동일 PDF의 동일 파일 재전송을 구분한다. 계약서 생성은 house_id·upload_id UNIQUE로 중복을 막는다. 한 주택의 여러 계약서를 허용한다.

파일은 임시 스풀에서 처리하고 256KiB씩 전송한다. 전체 multipart 요청 상한은 21MiB다. 이미지·PDF 처리에는 기존 공유 세마포어를 사용해 서버 프로세스 내 메모리 집약 작업의 병렬 실행을 제한한다.

## 동시 요청·중복·실패 복구

- PDF 슬롯은 contract_id·house_id·source_type=pdf·upload_status=draft·original_path IS NULL 조건으로 갱신한다. 이미 저장된 PDF는 덮어쓰지 않는다.
- 이미지 페이지는 기존 계약서/페이지 번호 UNIQUE와 부모 계약서 FOR UPDATE 트리거를 사용한다. 다른 파일이 먼저 같은 번호를 차지하면 409를 반환하고 패배한 요청의 파일만 정리한다.
- 재전송한 같은 파일의 해시가 기존 경로와 같으면 추가 Storage 쓰기 없이 기존 성공을 반환한다. 다른 파일이면 CONTRACT_FILE_EXISTS로 거절한다.
- Storage 성공 후 DB 실패 시 이번 시도의 파일 정리를 시도한다. 공통 정리 실패 로그 PHOTO_CLEANUP_FAILED attempt=...를 사용하며 문서/키는 출력하지 않는다.
- DB 응답이 불확실하면 RLS 조회로 저장 여부를 재확인한다. 확인까지 실패하면 파일을 지우지 않고 UPLOAD_CONFIRMATION_PENDING과 CONTRACT_COMMIT_UNKNOWN attempt=... 로그를 남긴다. 같은 파일·계약서·페이지 번호로 재시도하면 된다.
- 강제 종료/지연된 외부 커밋의 모든 고아 파일을 자동 정리하는 영구 작업은 이번 MVP에 도입하지 않았다. 정리 실패는 로그로 확인한다.

## 완료 상태

업로드 성공 후에도 draft다. 완료 요청은 strict boolean all_pages_confirmed=true가 필요하다. PDF는 저장 경로와 검사된 1~20페이지 정보가 있어야 하고, 이미지는 페이지 번호가 정확히 1부터 연속되어야 한다. 빈 계약서는 완료되지 않는다.

완료는 upload_status=draft 조건의 PATCH로 수행한다. 기존 DB 트리거도 이미지 페이지 수·연속성을 재검사한다. ready 후 이미지 삽입은 DB 트리거가, PDF 추가/교체는 조건부 갱신과 API 상태 검사가 차단한다. 이미 완료된 작업의 동일 완료 요청은 기존 결과를 반환한다. 시스템은 실제 문서의 마지막 페이지까지 포함됐는지 알 수 없으므로 사용자가 직접 전체성 확인을 해야 한다.

## 화면과 이어서 등록

메인 화면의 **계약서 분석** 메뉴는 현재 등록·조회 화면이며 AI 분석은 '준비 중'이라고 명시한다.

1. 새 계약서 등록 → PDF 또는 사진 방식 선택 → 파일 선택.
2. 사진은 최대 10장. 위로/아래로 버튼과 번호 입력으로 업로드 전에 페이지 순서를 조정한다. 첫 업로드 시작 후 해당 배치의 순서는 고정되며, 이미 저장한 페이지는 교체하지 않는다.
3. 파일을 개별 업로드하고 파일별 성공·실패를 표시한다. 재시도는 실패한 항목만 처리한다. 알려진 대기/실패 파일이 남아 있으면 완료 버튼을 사용할 수 없다.
4. 새로고침/재로그인 후 최신 계약서를 기본 표시한다. 목록에서 draft를 선택하면 저장된 페이지가 보인다. 누락한 파일을 다시 선택하면 저장되지 않은 번호를 우선 배정한다. 로컬에서 선택만 하고 전송하지 않은 파일은 브라우저 보안상 다시 선택해야 한다.
5. 전체 페이지를 직접 확인하고 체크 → 계약서 등록 완료.
6. PDF는 새 탭에서 임시 URL로 원본을 열고, 이미지는 페이지순 미리보기와 원본 링크를 제공한다. HEIC 표시용 JPEG는 경로에서 계산하므로 DB 컬럼을 추가하지 않는다.
7. URL은 15분 유효하다. 다시 조회나 12분 주기 조회로 갱신한다.

## 직접 실제 환경에서 검증

이번 개발에서는 실제 Supabase 업로드·삭제·SQL 실행·OpenAI 유료 호출을 하지 않았다. 사용자가 다음 절차로 테스트 문서를 직접 업로드한다. 새 SQL은 실행하지 않는다.

추가 패키지 설치 (프로젝트 루트):

```bash
.venv/bin/python -m pip install -r backend/requirements-dev.txt
```

터미널 1:

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

- http://localhost:5173 에서 기존 테스트 계정 로그인 → 주택 등록 확인 → 계약서 분석 메뉴.
- 가상의 암호화되지 않은 PDF(20MiB 이하·20페이지 이하) 한 개를 업로드한다. draft 확인 → PDF 원본 열기 → 전체 페이지 확인 체크 → 완료한다.
- 새 계약서를 만들고 가상 이미지 2~3장을 선택한다. 순서를 바꾸고 업로드 → 페이지순 미리보기 → 전체 페이지 확인 → 완료한다.
- 다른 draft를 만들어 일부 페이지만 업로드하고 새로고침·재로그인한다. 해당 draft를 선택하고 누락 페이지를 등록해 이어서 완료한다.
- 다른 테스트 계정에서 이전 계정의 목록·상세가 보이지 않는지 확인한다.
- Dashboard의 contracts, contract_pages 및 비공개 deposit-private 경로에서 원본을 확인한다. contract_analyses는 이번 작업으로 생성되지 않아야 한다.
- ready 계약서의 추가 업로드가 차단되는지, 손상/암호화/21페이지 PDF와 20MiB 초과 파일이 거절되는지 확인한다.

## 이후 계약서 AI에서 재사용할 부분

계약서 소유권 조회, source_type/page_count, 연속된 페이지 메타데이터, 원본·HEIC JPEG 경로, draft/ready 상태, Pydantic 응답, 재조회 UI를 재사용할 수 있다. 외부 AI 전송 동의, 분석 스키마/원문 검증, 호출 예약·한도, AI 결과 저장·표시는 다음 단계에 별도 구현해야 한다. 이번 화면은 그 처리를 실행하지 않는다.
