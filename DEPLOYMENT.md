# 신규 구현 배포 준비 상태

이 브랜치는 기존 main을 보존한 `feature/security-deposit-rebuild`다. Security_Deposit의 FastAPI/Supabase/Vite 구현을 반영했으며, 이 작업에서 main 병합·사이트 재배포·Render 연결·외부 DB 변경은 하지 않았다.

- 현재 프론트: `frontend/` (Vite). 현재 API: `backend/` (FastAPI).
- `render.yaml`은 이 두 디렉터리를 rootDir로 사용하는 후속 배포용 템플릿이다. 아직 실행하지 않았다.
- 실제 환경값은 GitHub에 넣지 않고 Render 환경변수 화면에 별도로 입력한다. backend/.env.example, frontend/.env.example에는 예시 이름만 있다.
- Supabase SQL은 배포 시작 과정에서 자동 실행하지 않는다. 001~005 적용 여부는 실제 프로젝트에서 별도 확인해야 한다. 이미 적용한 SQL을 다시 실행하지 않는다.
- 실제 DB/Storage 삭제나 유료 GPT 호출은 이 브랜치 업로드 검증에서 실행하지 않는다.

## 기존 팀 자료 보존

`AGENTS.md`는 루트에 그대로 유지했다. 기존 main의 README·배포 설명·정적 진입점·두 화면 소스·로고·테스트·Sites 식별자는 `legacy/ai-hackathon-main/`에 원문 그대로 보존했다. 이 디렉터리는 새 Render 앱의 rootDir가 아니며 자동 배포 대상으로 사용하지 않는다. 기존 Sites 식별자는 자격증명이 아닌 프로젝트 식별 메타데이터로, 기존 사이트를 재배포하거나 설정을 변경하지 않았다.

새 브랜치를 Render에 연결하는 작업은 사용자가 별도로 진행한다. 저장소 branch는 `feature/security-deposit-rebuild`, API root는 backend, 프론트 root는 frontend다. 실제 주소에 맞춘 CORS_ORIGINS·VITE_API_BASE_URL과 Supabase/OpenAI 환경값 설정 후 프론트를 빌드하고 실연동 테스트해야 한다.
