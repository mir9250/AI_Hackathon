# 돌려받집 배포 소스

Sites에서 사용하는 앱 화면, Cloudflare Worker API, 계정·사진 저장 로직, DB 스키마·마이그레이션 및 테스트를 팀 GitHub에서 함께 관리합니다. 이 폴더는 일반 소스 디렉터리이며 별도 Git 저장소나 submodule이 아닙니다.

## 빌드와 검증

Node.js 22.13 이상이 필요하며 Node.js 24 LTS를 권장합니다. 이 디렉터리에서 실행합니다.

```bash
npm run build
npm test
```

빌드와 테스트는 Node.js 내장 기능만 사용하므로 외부 패키지 설치 없이 실행할 수 있습니다. 빌드 결과는 dist/server/index.js이며 Git에서 제외합니다. 테스트는 정적 자산, AI 입력·응답 검증과 모의 호출, SQLite 기반 계정 분리·DB 왕복, 클라이언트 동기화·충돌 처리를 확인합니다. 실제 사용자 로그인·카메라·유료 AI 호출은 별도 검증이 필요합니다.

스키마를 수정하여 마이그레이션을 생성할 때만 npm ci 후 npm run db:generate를 실행합니다.

## 구조

- app/: 배포하는 HTML/CSS/JS와 로고. ../../rental-demo/의 화면·클라이언트 로직을 바꿀 때 이 복사본도 갱신합니다.
- worker/: 사이트 자산 제공, AI API, 인증된 계정·기록·사진 API.
- db/, drizzle/: D1 스키마, SQL 마이그레이션과 생성 메타데이터.
- scripts/: 빌드와 모의 환경 검증.
- .openai/hosting.json: 기존 Sites 프로젝트 ID와 D1 DB·R2 BUCKET 바인딩 선언. 프로젝트 ID는 비밀키가 아니며 기존 사이트 업데이트 시 유지합니다.

## 운영 환경과 배포

운영 구성은 [DEPLOYMENT.md](../../DEPLOYMENT.md)를 확인합니다. 플랫폼이 제공하는 검증된 사용자 신원 헤더로 인증하고, D1에 계정·기록을, 비공개 R2에 사진을 저장합니다. 일반 서버로 이식할 경우 해당 헤더를 직접 신뢰하지 말고 실제 세션 인증으로 대체해야 합니다. 빌드만으로 로컬 인증·DB·R2가 구성되지는 않습니다. 로컬 화면은 저장소 루트에서 python3 rental-demo/server.py로 실행합니다.

AI는 서버 비밀 환경변수 OPENAI_API_KEY 설정 후 사용할 수 있습니다. 기본 모델은 gpt-4.1-mini이며 OPENAI_MODEL로 변경합니다. worker/ai-config.json은 공개 프롬프트·응답 스키마로 비밀키를 포함하지 않습니다. .env, 키·토큰, 사용자 데이터, 중첩 .git/, 빌드 결과와 node_modules/는 공유하지 않습니다.

GitHub push는 Sites 재배포를 수행하지 않습니다. 실제 배포는 Sites 스킬의 source helper와 native tools로 별도의 Sites 체크아웃에 검증된 소스를 동기화·패키징한 후 진행합니다. 팀 저장소 안에 중첩 .git을 만들지 않으며 인증정보·기존 .git을 복사하지 않습니다. 기존 프로젝트 ID와 접근 범위를 유지합니다.
