# 입실 사진 업로드·조회

기존 자연어 명세서 v1.2와 9개 테이블·비공개 버킷을 유지한다. 마이그레이션·외부 설정 변경은 없다. 이 문서는 사진 업로드 단계의 기록이다. 이후 입실 AI 분석은 photo-analysis.md에 정리했다. 퇴실·계약서·사용자 사진 삭제 API는 없다.

## API

- `POST /api/move-in/photos`: Bearer 사용자 JWT와 multipart `file`, `location`(공백 제거 후 1~80자), `upload_id`(UUID). 성공 `data`는 `photo_id`, `upload_status: stored`, `already_uploaded`를 포함한다.
- `GET /api/move-in/photos`: 본인 주택의 `stage=entry` 사진 목록. 메타데이터와 `signed_url`, `signed_url_expires_at`, `analysis`, `analysis_status`를 반환한다. 분석 행이 없으면 `analysis=null`, `analysis_status=not_analyzed`다. 주택이 없으면 빈 목록을 반환하며 업로드는 `409 HOUSE_REQUIRED`다.
- 오류는 기존 `error: {code,message,retryable}` 형식을 사용한다. 파일·필드 오류는 422, 인증 실패는 401, 외부 저장 실패는 5xx다.

## 처리·권한

Auth 검증과 주택·사진 조회는 publishable 키 + 사용자 JWT로 RLS를 적용한다. 기존 정책이 사진 삽입·Storage 접근을 허용하지 않으므로, 검증된 사용자·주택을 기준으로 서버가 생성한 경로에만 secret 키로 쓰고 URL을 발급한다. 새 브라우저 Storage 정책은 필요 없다.

원본은 변경하지 않고 `{user_id}/{house_id}/{attempt_uuid}/original.ext`에 저장한다. HEIC만 동일 폴더에 2048픽셀 이하 JPEG 미리보기를 추가한다. 이미지 원본 MIME과 확장자·실제 디코더 형식이 일치해야 한다. `.heic`는 `image/heic` 또는 호환 MIME `image/heif`를 받되 실제 HEIF 디코더 검사도 수행한다. 일반 `.heif` 확장자는 지원하지 않는다.

크기는 20MiB 이하, 내부 해상도 상한은 2천만 화소 및 한 변 10,000픽셀이다. 이는 원본 명세의 비정상적 대형 이미지 거부를 구체화한 메모리 보호 기준이다. multipart 요청 전체는 21MiB로 제한한다. 업로드 원본은 임시 스풀 파일에서 256KiB씩 전송하며 이미지 디코딩·저장은 서버 프로세스당 하나씩 수행한다.

주택·upload_id의 기존 행을 우선 조회한다. 동시 요청은 시도별 경로를 사용하고 DB UNIQUE 제약으로 최종 중복을 막는다. 실패하거나 경쟁에서 진 시도의 파일만 정리한다. DB 응답 타임아웃·5xx는 실제 저장 여부를 재조회한다. DB 확인까지 실패하면 이미 저장된 사진을 지우지 않고 `UPLOAD_CONFIRMATION_PENDING`을 반환한다. 같은 화면의 재시도는 동일 upload_id를 유지한다. 새로고침 후 파일을 다시 선택하면 새로운 요청 ID가 생성된다.

정리 실패는 비밀값 없이 `PHOTO_CLEANUP_FAILED attempt=...`로 기록한다. 저장 결과 미확인은 `PHOTO_COMMIT_UNKNOWN attempt=...`로 기록한다. 실패한 Storage 작업의 지연 완료·서버 강제 종료 시 남는 파일에 대한 자동 영구 정리 작업은 없으며 시연에서는 로그와 해당 시도 UUID로 확인한다.

signed URL은 15분간 유효하다. 화면은 12분마다 목록을 다시 조회하고, '다시 조회' 버튼으로 즉시 새 URL을 받는다. HEIC는 브라우저가 지원하지 않으면 선택 직후 미리보기를 표시할 수 없으며 업로드 후 서버 JPEG로 표시한다.

## 실행·직접 확인

먼저 추가한 패키지를 설치한다.

```bash
.venv/bin/python -m pip install -r backend/requirements-dev.txt
```

프로젝트 루트에서 터미널 1:

```bash
cd backend
../.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

프로젝트 루트에서 터미널 2:

```bash
export PATH="$PWD/.tools/node-v22.16.0-darwin-arm64/bin:$PATH"
cd frontend
npm run dev
```

실제 외부 Storage 업로드와 이에 따른 DB 메타데이터 삽입·실패 파일 정리는 사용자 승인 후 실행한다. 기존 테스트 계정·가상 사진만 사용한다.

1. http://localhost:5173 로그인 → 주택 등록 여부 확인 → **입실 사진 등록·조회**.
2. `tests/fixtures/move-in-demo.png` 등 가상 사진 선택, 각 사진 위치 입력, 업로드.
3. 파일별 저장 상태와 목록 미리보기·위치·업로드 시각·미분석 표시 확인.
4. 새로고침 후 사진 화면을 다시 열고, 로그아웃·재로그인 후에도 목록 유지 확인.
5. 다른 테스트 계정으로 로그인해 기존 계정 사진이 보이지 않는지 확인.
6. 손상 파일·20MiB 초과 파일·11장 선택이 차단되는지 확인. 일부 실패해도 성공한 사진은 남아야 한다.
7. Dashboard Table Editor의 photos에서 stage=entry·house_id·upload_id를 확인하고 Storage의 deposit-private에서 원본, HEIC의 preview.jpg를 확인한다. 관리자 Dashboard 조회는 사용자 RLS 테스트를 대체하지 않는다.

Supabase 실제 파일 쓰기·삭제는 이번 개발 중 실행하지 않았다. 브라우저 시각 검수·실기기 HEIC·모바일 테스트는 별도로 필요하다.
