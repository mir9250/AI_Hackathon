# AI_Hackathon 신규 구현 브랜치 인계

- 대상 브랜치: `feature/security-deposit-rebuild`.
- 시작 기준: AI_Hackathon main `61054a25d8fc87dadbfc4794712e82237e637109`.
- 구현 출처: Security_Deposit `52363a9e2ab848ff968cb16774ee4de10a024016`의 추적 파일 스냅샷. 개인 저장소의 파일·커밋·원격은 수정하지 않았다.
- main 병합·강제 push·Render/Sites 배포·Supabase 변경·유료 OpenAI 호출은 이번 범위가 아니다.

## 팀 자료 보존과 실행 대상

기존 AGENTS.md는 바이트 단위로 그대로 유지했다. 기존 팀 파일 33개(README·DEPLOYMENT·정적 index·rental-demo·Sites 화면/로고/식별 메타데이터)는 `legacy/ai-hackathon-main/`에 바이트 단위로 보존했다. 기존 .gitignore는 신규 구현에 맞게 확장하고 원래의 Python/.env/중첩 Git 제외 의미를 유지했다. Git 이력은 main을 부모로 하는 일반 커밋으로 이어진다.

현재 실행/배포 대상은 frontend와 backend다. 소스의 앱·SQL·테스트·fixture·실행 설정은 개인 저장소 추적 파일과 동일하다. 이식 과정의 변경은 README·DEPLOYMENT·인계 문서와 저장소 제외 규칙이다. legacy나 api_practice를 신규 Render rootDir로 사용하지 않는다. render.yaml은 템플릿이며 아직 배포하지 않았다.

## 커밋 전 검사

- Gitleaks 8.30.1 공식 배포본의 SHA-256을 검증한 뒤 후보 파일 전체 및 신규 커밋 범위를 검사한다. 보고서는 키를 완전 마스킹하고 저장소 밖에 보관한다.
- 개인 저장소 backend/frontend .env의 실제 민감값·프로젝트 URL 네 개를 메모리에서 읽어 커밋 후보 전체의 원문/base64/JSON 이스케이프 표현과 대조했다. 값은 출력하거나 복사하지 않았다.
- 실제 .env, node_modules, dist, 가상환경, Git 내부 정보는 복사/커밋하지 않는다. .env.example에는 예시값만 있다.
- fixture PDF는 가상 계약서이며 작성자 필드·개인 로컬 경로가 없고, PNG 세 개에는 EXIF/위치 메타데이터가 없음을 확인했다. 코드의 단위 테스트 계정과 키 문자열은 모의값이다. 보존된 Sites project_id는 사이트 식별자이며 인증 토큰이 아니다.
- 검사에서 실제 자격증명이나 실제 개인정보를 발견하지 않았다. 자동 패턴 검사가 모든 형태의 비밀정보 부재를 수학적으로 보장하는 것은 아니다. 기존 main의 과거 커밋을 재작성하거나 정리하지 않는다.

## 검증 결과

별도 clone에서 모의 외부 서비스만 사용했다.

- Python 3.14.5: 백엔드 282개 통과. 기존 Starlette/AnyIO deprecation 경고 1건.
- Node 22.16.0: 프론트·로컬 PGlite DB 76개 통과.
- Vite 프로덕션 빌드 성공. 실제 키 없는 상태로 빌드한 산출물은 테스트용이며 커밋하지 않는다. 후속 배포에서 환경변수를 입력하고 재빌드한다.
- 보존된 legacy app.js 구문 검사와 git diff --check 통과.
- Supabase 마이그레이션과 분석/삭제 동작은 로컬/모의 테스트다. 실제 프로젝트 적용 여부는 배포 전에 별도로 확인한다.
