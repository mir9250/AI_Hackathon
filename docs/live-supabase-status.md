# 실제 Supabase 연결 상태

대상 조직: Security_Deposit (`twsjhumflwxmcmmjlglz`). 프로젝트: `zyhvvqadtgzzzxdzdmmw`.

기존 001~005 구조와 데이터가 이미 적용되어 있어 재실행하지 않았습니다. 새 `living_records` 테이블만 마이그레이션으로 추가했고, RLS·권한을 확인했습니다. 비공개 사진 버킷은 그대로 보존했습니다.

현재 웹은 `VITE_ACCOUNT_DIRECT=true`, `VITE_UI_PREVIEW=false`로 빌드합니다. Supabase Auth와 profiles/houses의 기존 소유자 RLS를 사용합니다. `getUser()`로 검증한 사용자 ID만 쿼리·저장에 사용하며, 소유자 ID를 입력값에서 받지 않습니다. 브라우저에는 공개 publishable 키만 포함합니다.

검증: 실제 Auth settings HTTP 200, 이메일 로그인 활성화 확인, 익명 프로필 접근 HTTP 401, 관계없는 authenticated 사용자에게 profiles/houses/living_records 조회 결과 0행 확인. 실제 사용자 비밀번호로 로그인·저장·재로그인하는 브라우저 검증은 수행하지 않았습니다.

현재 사진·계약서 업로드 및 AI 분석 API는 FastAPI 배포가 필요합니다. 직접 연결 모드에서 해당 요청을 성공 처리하거나 샘플 저장으로 대체하지 않으며 서버 준비 중 안내를 반환합니다. 기존 FastAPI 코드는 변경하지 않았습니다. 배포 후 실제 API 주소를 지정하고 `VITE_ACCOUNT_DIRECT=false`로 전환합니다.

Supabase Auth의 운영 Site URL 및 허용 Redirect URL은 운영자가 배포 웹 주소와 일치하는지 확인해야 합니다. 현재 연결 도구에는 Auth 설정 변경 기능이 없습니다.

보안 advisor에는 기존의 유출 비밀번호 차단 기능 미활성화 경고가 있습니다: https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection
