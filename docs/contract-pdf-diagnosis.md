# 실제 더미 계약서 PDF의 인용문 불일치 진단

검사 대상은 사용자가 웹사이트에 업로드했던 것과 동일하다고 제공한 `tests/fixtures/dummy_rental_contract.pdf`다. 다른 PDF를 생성하거나 대체하지 않았다. 46,455바이트, 2페이지, SHA-256:

`9893b7813fb4c380f97586ed158824da1cac11a401e04b8a05c7e6f69d424615`

## 확정한 문제와 미확정 부분

두 페이지의 글꼴은 AppleSDGothicNeo 서브셋, `/Encoding /Identity-H`, `/CIDSystemInfo`는 Adobe/Korea1이며 `/ToUnicode`가 없다. 설치된 pypdf 7.1.0의 `_cmap.py`는 Identity-H를 UTF-16BE로 해석한다. 이 문서에서는 CID 값을 Unicode 문자로 잘못 읽어 한글·숫자·공백이 깨진다. 기존 검사는 U+FFFD, 길이, 추출 예외만 검사했는데 실제 출력에는 U+FFFD가 없어 잘못된 문자열을 대조 원문으로 채택했다.

| 물리 페이지 | 기존 pypdf 문자 수 | 기존 비정상 제어문자 수 | 수정 후 문자 수 | 수정 후 비정상 제어문자 수 |
|---|---:|---:|---:|---:|
| 1 | 735 | 270 | 739 | 0 |
| 2 | 947 | 265 | 949 | 0 |

기존 추출 결과는 한글 음절이 0개이며 특약사항·150,000원·벽지·장판·원상복구 문구가 나오지 않는다. 실제 PDF를 로컬 PDFKit으로 렌더링해 시각적으로 확인한 특약 여섯 문장을 그대로 `validate_evidence()`에 넣어도 기존 추출 결과에서는 **여섯 개 모두 실패 / AI_EVIDENCE_MISMATCH**한다. 공백이나 Unicode 정규화만으로 해결할 수 있는 차이가 아니다.

동일 파일을 pdfminer.six 20260107의 Adobe-Korea1 CMap 처리로 추출하면 원문의 한글·금액·특약 여섯 개가 복원된다. 페이지 1에는 보증금 10,000,000원, 월세 500,000원, 관리비 70,000원, 2026년 11월 14일~2028년 11월 13일 기간이 있고, 특약 여섯 개는 모두 페이지 2에만 있다. 청소비 150,000원, 벽지 및 장판 교체비, 원상복구 특약도 해당 페이지에서 원문대로 검증된다. 페이지 연결과 기존 문자열 대조 자체는 올바른 추출 원문을 주면 정상 작동한다.

**이것은 실제 PDF로 재현한 추출 결함이다. 이전 두 GPT 응답 자체는 저장되지 않아 그 응답의 재작성·잘못된 페이지·추가 환각 여부를 확정하거나 배제할 수 없다.** 정상 인용문도 실패하게 만드는 서버 결함은 확인했지만 실제 응답의 모든 실패 사유가 이것 하나였다고 주장하지 않는다. 유료 모델의 추출 정확도도 이번 모의 검증으로 증명되지 않는다.

## 처리 흐름과 최소 수정

1. Storage 원본 PDF → 기존 크기·유효성·페이지 수 검사 유지.
2. `extract_contract_texts()`가 각 페이지 글꼴을 검사. `/ToUnicode` 없이 Adobe-Korea1 Identity-H/V를 쓰는 페이지만 pdfminer.six로 추출한다. 일반 페이지는 기존 pypdf 유지.
3. 비정상 제어문자·U+FFFD·미변환 `(cid:숫자)`·빈 값·과도한 길이는 원문 대조 불가로 취급한다. fallback 실패 시 깨진 pypdf 결과를 재사용하지 않는다.
4. GPT에는 이전처럼 **원본 PDF 전체**를 전달한다. 원본 수정, OCR, 영구 파일 업로드, 프롬프트 변경은 하지 않았다.
5. `clause_excerpt` → 기존 NFKC/공백/비가시 서식 정규화 → 지정한 물리 페이지 원문과 부분 문자열 대조. 다른 페이지 일치·범위 초과·불일치·원문 없음 구분 유지.
6. 일부 검증 성공 시 성공 항목만 보존하고 경고, 모두 실패하면 실패. 금액·기간·부정 표현·금액의 한글 단위 변환·의미 유사도 허용은 추가하지 않았다.

본문을 운영 로그에 추가하지 않았다. 기존 검증 진단은 항목 순번·페이지·사유만, fallback 오류는 고정 코드만 남긴다. 로컬 CLI도 길이·추출기·제어문자 수·일치 항목 번호·해시만 출력한다.

공식 [pdfminer.six API](https://pdfminersix.readthedocs.io/en/latest/reference/highlevel.html)의 extract_pages를 사용하며 [20260107 릴리스](https://pypi.org/project/pdfminer.six/20260107/)로 고정했다. 이 의존성은 해당 CID 글꼴 원문 복원에 필요하며 사용자 기능·DB 설계 변경이 아니다. CLI와 테스트는 macOS PDFKit에 의존하지 않으며 Python으로 실행된다.

## 유료 호출 없이 재확인

```bash
# 프로젝트 루트: 새 의존성 설치 (패키지 다운로드만 수행)
.venv/bin/pip install -r backend/requirements.txt

# 실제 PDF 추출 + 실제 특약 문구 6개로 기존 검증 함수 실행
.venv/bin/python scripts/check_contract_pdf.py tests/fixtures/dummy_rental_contract.pdf --check-dummy

# 실제 파일 회귀 테스트만 실행
.venv/bin/python -m pytest tests/test_contract_pdf_fixture.py -q

# 사진 분석·퇴실 비교를 포함한 전체 백엔드 회귀 테스트
.venv/bin/python -m pytest
```

`dummy_check_passed: true`, `verified_findings: 6`, 두 페이지 `extractor: pdfminer_korea1`, page 2 clause_matches가 1~6인지 확인한다. 이 스크립트는 .env를 읽지 않고 외부 서비스에 연결하지 않는다. `--check-dummy`는 이 가상 계약서 전용이며 다른 계약서의 분석 정확성을 판단하는 기능은 아니다.

자동 테스트는 위 실제 PDF로 기존 오류 재현, 새 추출 결과, 페이지·금액·기간·부정·재작성·환각 거절, 부분 실패, fallback 실패 시 검증 차단, 모의 분석 저장·GET 재조회·캐시를 확인한다. 백엔드 243개(신규 12개), 프론트·로컬 DB 61개 통과. pip check 성공. 기존 Starlette/AnyIO deprecation 경고 1건은 남아 있다.

## 실제 재시도 전후

로컬 검사를 먼저 통과시킨 뒤 백엔드를 재시작한다. 새 의존성을 포함한 백엔드 변경만 있어 프론트 재빌드는 필요 없다. 이후 사용자가 유료 재시험을 결정하면 같은 ready/failed 계약서의 원본을 재사용할 수 있다. SQL 적용·수동 상태 변경·재업로드는 필요 없다. 실제 응답이 원문을 바꿔 쓰거나 페이지를 틀리면 여전히 해당 항목을 제외하거나 실패 처리한다.

이번 작업에서 001~004 SQL 및 사용자 제공 PDF를 변경하지 않았고, 실제 Supabase 변경·유료 GPT 호출은 하지 않았다.
