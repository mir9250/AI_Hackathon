# Render API 연결

운영 API: https://ai-hackathon-nd4y.onrender.com
운영 웹: https://dollyeobatjip-demo.newflask.chatgpt.site

Render `/api/health` 및 `/openapi.json` 확인 결과 API v0.2.0이 정상 동작하고 거주 중 기록 API까지 포함되어 있습니다. Render가 웹 origin을 CORS로 허용하지 않아, Sites Worker의 동일 origin `/api/*` 경로가 고정 Render origin으로 요청을 전달합니다.

- 프론트 빌드: `VITE_UI_PREVIEW=false`, `VITE_ACCOUNT_DIRECT=false`, `VITE_API_BASE_URL=https://dollyeobatjip-demo.newflask.chatgpt.site`.
- Supabase Auth는 기존 프로젝트를 사용합니다. 프로필·주택도 다른 기능과 동일한 FastAPI API를 사용합니다.
- 중계는 Authorization·Content-Type·Accept만 전달합니다. 쿠키를 전달하지 않고 응답을 캐시하지 않습니다. 원격 주소를 사용자 입력으로 받지 않습니다.
- 브라우저 토큰은 Render가 기존 방식으로 검증합니다. 중계가 임의 사용자 신원을 만들거나 권한 검사를 생략하지 않습니다.
- 업로드 요청 본문은 최대 21MiB로 스트리밍 제한합니다. 실제 20MiB 이미지 검사와 사진 형식 검사는 Render가 수행합니다.
- `hosting/render-worker.js`: API 중계 및 빌드된 정적 파일 응답.
- `hosting/build-render-site.mjs`: Sites 배포 체크아웃에서 `web-build`를 Worker 모듈로 패키징합니다. 실제 빌드 산출물은 GitHub에 넣지 않습니다.
- Worker 배포는 `.openai/hosting.json`의 `static`을 제거하고 `dist/server/index.js`를 사용합니다. 이전 서버 소스와 DB 마이그레이션은 배포 저장소에 보존되어 있습니다.

검증은 상태 확인, API 목록, 토큰 전달·오류 전달·타 origin 거절·업로드 제한 테스트입니다. 실제 사용자 로그인과 파일 업로드·유료 AI 호출은 자동으로 수행하지 않습니다. AI 기능은 Render의 OpenAI 키 및 결제 설정에 따라 동작합니다.
