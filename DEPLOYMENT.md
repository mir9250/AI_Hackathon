# 배포 준비 상태

현재 main의 실행 대상은 `frontend/`(Vite)와 `backend/`(FastAPI)입니다. 마이페이지·촬영 안내·거주 중 기록 저장이 추가되었습니다. 최신 앱을 실행하려면 실제 Supabase 연결과 아래 마이그레이션 적용이 필요합니다.

- 기존 001~005 적용 여부를 확인한 뒤 `supabase/migrations/202611140006_living_records.sql`을 적용합니다.
- 배포 대상 브랜치는 `main`입니다. `render.yaml`의 프론트·API 서비스를 연결하고 각각 실제 환경변수를 설정합니다.
- 로컬 테스트 통과와 GitHub main 업로드는 운영 배포 완료를 의미하지 않습니다.
- 실제 운영 키·API 주소는 저장소에 포함하지 않습니다. 현재 환경에서 실제 Supabase·Render 연결은 확인되지 않았습니다.
- 저장 방식과 운영 확인 절차: [거주 중 기록](docs/living-records.md).

기존 Sites 주소 `https://dollyeobatjip-demo.newflask.chatgpt.site`는 별도 구버전 앱입니다. FastAPI 서버는 해당 Cloudflare Worker 배포 방식에서 그대로 실행되지 않으므로, 최신 앱의 API를 배포한 뒤 프론트를 연결해야 합니다. 구버전 사이트를 연결 설정 없는 화면으로 덮어쓰지 않습니다.
