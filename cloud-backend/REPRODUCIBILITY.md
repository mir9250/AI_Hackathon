# Worker 재현 환경 — 이슈 #1

2026-11-09 기준. 이전 소스 미확보 상태는 GitHub 소스 공유로 해결되었다. 새 사이트나 대체 Worker를 만들지 않고 기존 `sites/deposit-guardian/worker/`를 빌드·실행한다. 저장 타이밍 수정 worktree는 포함하지 않는다.

## 소스와 기준 버전

- 팀 저장소: https://github.com/mir9250/AI_Hackathon
- 가져온 main: `2e0c4df` (Merge complete deployment source and verified release workflow).
- 배포 소스 최초 공유 커밋: `73861fc874240116cf8a0f976ad76671f582e7af`.
- 실제 소스: `sites/deposit-guardian/`. 일반 추적 디렉터리이며 별도 저장소/submodule이 아니다.
- `.openai/hosting.json`의 기존 project ID로 Sites `get_site`에 성공했다. ‘돌려받집’, 기존 URL, latest_version_number=11을 확인했다. 이는 최신 저장 버전 메타데이터이며 운영 배포 버전이라고 단정하지 않는다.
- `list_site_versions`는 `SitesConnectorError: Sites project not found`로 거부됐다. 따라서 **현재 운영 배포 버전↔Sites source commit SHA 대응은 미확인**이다. GitHub 공유 커밋을 운영 커밋으로 대체 표기하지 않는다.
- 운영 D1/R2 데이터나 비밀 환경변수는 읽거나 변경하지 않았다. 운영 R2의 공개 접근 설정도 재확인하지 않았다. 플랫폼에서 버전/소스 이력을 볼 수 있는 접근 또는 소유자가 제공하는 배포 provenance가 필요하다.

팀원이 복제할 때는 저장소를 clone하고 검토 대상 브랜치/확정 commit을 checkout한다. 이번 실행 설정은 `chore/issue-1-backend-repro` 작업 브랜치에서 공유한다. main만 clone하면 새 설정은 없으므로 아래 브랜치를 먼저 선택하고 `git rev-parse HEAD`로 받은 commit을 기록한다. 리뷰 시에는 그 전체 commit SHA로 고정한다.

```sh
git clone https://github.com/mir9250/AI_Hackathon.git
cd AI_Hackathon
git fetch origin
git switch --track origin/chore/issue-1-backend-repro
# 재현 기준을 확정할 때: git switch --detach <기록한-전체-commit-SHA>
git rev-parse HEAD
```

`rental-demo/` 변경은 배포 `app/`와 diff를 검토해 필요한 부분만 동기화한다. 배포는 별도의 Sites 체크아웃과 source helper를 사용한다. GitHub clone 경로에 중첩 `.git`이나 토큰을 복사하지 않는다. 이번 작업은 소스 동기화·푸시·배포를 하지 않는다.

## 설치·초기화·실행

Node.js 22.13 이상이 필요하다(기존 테스트의 `node:sqlite`). 실제 검증은 Node 22.16.0 / npm 10.9.2이며 `.nvmrc`에 고정했다. Python은 Worker 실행에 필요하지 않다. 최초 npm 설치에는 레지스트리 네트워크 접근과 지원되는 workerd 플랫폼(macOS/Linux/Windows)이 필요하다.

아래는 **프로젝트 루트에서** 시작한다.

```sh
cd sites/deposit-guardian
npm ci
npm run db:local
npm run db:local
npm run dev:local
```

주소: `http://127.0.0.1:8787/`. Ctrl+C로 종료한다. 두 번째 DB 초기화는 `already applied`를 출력해야 한다. `dev:local`도 미적용 로컬 마이그레이션만 자동 적용한다.

- 비밀값 없는 실제 설정 예시: `local/config.json`. compatibility date, localhost 포트, 로컬 DB 식별자와 BUCKET 바인딩을 선언한다. 운영 database ID/bucket 이름이나 프로젝트 ID는 사용하지 않는다.
- 실행 구현: `scripts/local-runtime.mjs` → Miniflare/workerd, D1 `DB`, R2 `BUCKET`. Miniflare는 `4.20260730.0`으로 lockfile에 고정했다.
- 데이터: 해당 소스 디렉터리의 `.local-state/`만 사용하며 Git 제외다. 환경변수의 Cloudflare 자격증명·OpenAI 키나 `.env`를 읽지 않는다. 외부 Worker fetch는 기본적으로 차단한다.
- 마이그레이션: `scripts/local-migrations.mjs`가 실제 `drizzle/*.sql`을 순서대로 D1에 적용한다. `local_migrations`에 파일명/SHA-256을 기록하며, 파일별 D1 batch로 스키마와 이력을 함께 적용한다. 재실행은 건너뛰고 이미 적용한 SQL의 변경은 오류로 차단한다. 이는 로컬 전용 이력이며 Sites 운영 이력과 별개다.
- 로컬 서버는 **비로그인 화면·AI 무키 상태만 제공**한다. 일반 요청의 `oai-authenticated-user-*` 및 테스트 헤더를 제거한다. 따라서 임의 헤더로 로컬 계정 로그인할 수 없다.
- 계정 경로는 아래 격리 테스트로 확인한다. `local/entry.mjs`는 배포 빌드에 포함되지 않는다. 테스트 러너만 프로세스별 난수 토큰을 메모리에 생성하고, 테스트 인스턴스의 binding과 요청에 사용한다. dev 서버에는 테스트 토큰 binding이 없고 키를 출력/파일 저장하지 않는다.
- 의존성 감사에서 새 Miniflare 경로의 취약 버전을 피하기 위해 Miniflare 하위 `undici=7.30.1`, `sharp=0.35.5`를 overrides로 고정하고 실제 런타임을 재검증했다. 기존 drizzle-kit 개발 의존성에서 moderate 4건이 남는다. 강제 downgrade/기능 수정은 하지 않았다. 운영 Worker에는 npm 개발 의존성을 번들하지 않는다.

## 실제 Worker 테스트

위 디렉터리에서 실행한다. 실키/실비용 호출은 없다.

```sh
npm run test:all
```

이는 `npm run build` → 기존 `npm test` → `scripts/runtime-test.mjs`를 실행한다. 개별로는 `npm run test:runtime`을 사용한다.

- 기존 `scripts/test.mjs`: 정적 자산, AI 입력·동의·인증·응답 형식과 provider mock.
- 기존 `scripts/account-test.mjs`: Node SQLite 기반 계정/사진 소유권, workspace 409, 일지 저장. D1 런타임 테스트와 구분한다.
- 기존 `scripts/cloud-client-test.mjs`: 계정 cache 분리, 사진 복원, 오프라인 dirty 보존, 기기간 충돌 복구.
- 새 `scripts/runtime-test.mjs`: **실제 빌드 산출물을 workerd에서 실행**한다. 빈 Miniflare D1 마이그레이션 2개, 이력 2행, 재실행 0개, 인스턴스 재시작 후 이력/workspace/R2 복원 확인. Worker HTTP 경로로 Alice/Bob 프로필 등록, workspace 조회·저장·409, 타인 사진 참조 저장 403, R2 사진 바이트 왕복, 비로그인 401/타인 404, 원본 key 직접 URL 404를 검증한다. 실제 localhost 요청으로 위조 신원 헤더 차단도 확인한다.
- AI는 무키 503과 네트워크 대역 응답 200을 검증한다. 테스트 인스턴스는 가짜 키 문자열만 사용하며 모든 외부 fetch를 대역에서 처리한다. 실제 OpenAI로 나가는 경로가 없다.
- 런타임 테스트는 새 임시 디렉터리를 생성하고 finally에서 dispose/삭제한다. 개발 `.local-state/`나 운영 리소스를 사용하지 않는다.

## API·인증·저장 차이

| 영역 | Python `rental-demo/server.py` | 배포 소스 `sites/deposit-guardian/` |
| --- | --- | --- |
| 진입점 | `main` / `Handler` | `worker/index.mjs` → `scripts/build.mjs` → `dist/server/index.js` default fetch |
| 상태·AI | GET `/api/health`, POST `/api/analyze`; `validate_input`, `call_openai` | 동일 경로; `worker/index.mjs`의 `validate`, `check`, `analyze`; `worker/ai-config.json` |
| 계정 | 미지원 | `worker/accounts.mjs`: `accountAPI`; GET me/history, POST register/session/logout |
| workspace | 미지원 | GET/PUT `/api/workspace`, `cloudWorkspace`, baseVersion 갱신·409 |
| 사진 | AI 요청 내 data URL만 처리 | POST `/api/photos`, GET `/api/photos/:id`, `accountPhoto`; D1 소유권 확인 후 BUCKET 조회 |
| 인증 | loopback/Host/Origin 검사, 사용자 인증 없음 | Sites가 검증한 신원 헤더 전제; 쓰기 Origin·X-Account-Id 검사. X-Account-Id 자체는 인증 아님 |
| 영속 저장 | 서버 저장 없음, 브라우저 IndexedDB | D1 프로필·이력·workspace·사진 메타데이터, R2 원본, 계정별 IndexedDB 오프라인 cache |
| 한도 | AI 이미지당 8MB, 본문 24MB | AI 이미지당 4MB/본문 12MB, 사진 업로드당 4MB·계정 합계 128MB |

`cloud-backend/accounts.mjs`와 SQL은 참고본이다. 실제 API 원본은 배포 디렉터리의 worker/db/drizzle이며 중복 참고본을 실행 서버로 쓰지 않는다. `db/schema.ts`는 drizzle-orm, `drizzle.config.ts`는 drizzle-kit으로 마이그레이션을 생성한다. 생성은 `npm run db:generate`이며 #1에서는 기존 SQL을 수정하지 않는다.

일반 인터넷 서버로 이식할 때는 Sites 인증 경계를 대체하는 실제 세션 검증이 필요하다. 여기 추가한 localhost gateway는 테스트/개발 전용이며 배포 인증을 구현한 것이 아니다.

## 검증 결과·제한

실행 결과는 아래 표에 기록한다. `cloud-backend/scripts/check_migrations.py`는 이전 작업의 격리 SQLite 참고 검사로 유지하지만 D1/R2 증거로 사용하지 않는다.

| 검증 | 결과 |
| --- | --- |
| `npm run build`, `npm test` | 기존 Worker/클라이언트 테스트 통과 |
| `npm run test:runtime` | workerd + 로컬 D1/R2 전체 흐름 통과 |
| 깨끗한 사본 `npm ci`, `npm run db:local` 2회, `npm run test:all` | 모두 통과. 초기 2개 적용 → already applied → 전체 통과 |
| 깨끗한 사본 `npm run dev:local` | 준비 완료 후 HTTP health(DB/BUCKET=true, configured=false), 위조 신원 미인증 확인 |
| 변경 JS 구문 검사, `git diff --check`, 추가 파일 공백·비밀값 패턴 검사 | 통과(변경 범위만, 전체 이력 감사 아님) |
| 실제 플랫폼 사용자 로그인/운영 R2 공개 설정/운영 배포 provenance | 미확인. 운영 데이터는 사용하지 않음 |
| 유료 AI/운영 변경/재배포 | 미실행 |

이슈 #2~#7이나 저장 타이밍 수정은 구현하지 않았다. 기존 drizzle 개발 도구의 audit moderate 경고와 Node SQLite experimental 경고를 남긴다.

| #1 완료 조건 | 상태 |
| --- | --- |
| 새 환경에서 Worker·테스트 저장소 실행 | 로컬 환경 구현·검증 완료 |
| 테스트 D1 마이그레이션·비공개 R2 바인딩 | 로컬 완료. 운영 R2 설정 확인과 구분 |
| 계정·사진·workspace·AI 구현 위치·테스트 명령 | 완료 |
| 비밀키 저장소 미포함 | 이번 변경은 실키 불필요. 최종 변경 파일 패턴 검사 범위로 확인 |

로컬 실행 재현 조건은 충족했으나 **요청된 운영 배포 버전↔소스 SHA 확인은 남아 있다**. 운영과 동일 소스임을 완전히 입증했다고 보고하지 않는다. main 반영 검토 시 이 제한과 개발 의존성 경고를 함께 검토해야 한다.

## PR 초안 (생성하지 않음)

제목: `[Backend][#1] 기존 Worker의 격리 D1·R2 개발 및 통합 검증 환경 추가`

본문: 실제 공유된 Worker를 변경 없이 빌드하여 Miniflare/workerd에서 실행하는 로컬 환경을 추가합니다. 로컬 D1 이력/재실행과 R2, 계정·workspace·사진 권한·409, AI 무키/mock을 실제 Worker 경로로 확인하며 일반 요청의 신원 헤더 위조는 차단합니다. lockfile·런타임·팀 재현 절차를 고정했습니다. 운영 데이터/배포와 저장 타이밍 수정은 포함하지 않습니다. 검증은 `npm ci`, `npm run db:local` 2회, `npm run test:all`이며 운영 배포 provenance 및 운영 R2 설정 확인은 미완료입니다. 관련 #1, 이슈 자동 종료 문구는 넣지 않습니다.

최초 dev 명령 검증은 준비 완료 전에 프로세스를 종료해 초기화 도중 ECONNREFUSED를 출력했다. 서버 준비 로그 이후 검증하도록 수정한 재실행은 정상 종료까지 통과했다. 제품 코드의 기능 변경으로 우회하지 않았다.

반영 검토 대상은 `DEPLOYMENT.md`, `cloud-backend/README.md`, 이 문서, 기존 `cloud-backend/scripts/check_migrations.py`, `sites/deposit-guardian/`의 `.gitignore`, `.nvmrc`, `README.md`, `package.json`, `package-lock.json`, `local/{config.json,entry.mjs}`, `scripts/{local-runtime.mjs,local-migrations.mjs,local.mjs,runtime-test.mjs}`다. 기존 Worker/app/SQL은 수정하지 않았다. `.DS_Store`, node_modules, dist, .local-state, 저장 타이밍 worktree는 제외한다. 이전 미커밋 작업의 안전 사본 stash도 유지한다. 커밋·푸시·PR·main 병합·배포·이슈 종료는 수행하지 않았다.

## 조건부 푸시 요청에 대한 재확인

2026-11-09: Sites 버전 목록을 다시 조회했으나 동일하게 `project_not_found`(404)로 실패했다. 로컬 실행 코드와 테스트는 완료됐지만, 요청 범위의 운영 배포 소스 대응과 운영 R2 설정 확인은 미완료이므로 완료를 전제로 한 푸시·main 반영·배포는 진행하지 않았다. 필요한 최소 조치는 소유자가 배포 버전↔소스 commit 정보와 R2 비공개 설정의 비밀값 없는 증거를 제공하거나, 현재 연결에서 해당 버전/설정을 조회할 수 있도록 기존 프로젝트 접근을 연결하는 것이다. API 키·운영 사용자 데이터는 불필요하다. 실제 인증/접근 상태를 추측하거나 새 사이트로 대체하지 않는다.

## 팀 인계 업로드

사용자가 미확인 항목을 포함한 현재 상태를 팀원에게 공유하도록 요청하여 작업 브랜치 `chore/issue-1-backend-repro`에 커밋·푸시한다. 앞의 미커밋/미푸시 기록은 당시 상태다. main 병합·운영 배포·이슈 종료는 하지 않으며, 이 업로드는 #1 전체 완료를 뜻하지 않는다. 팀원은 위 명령으로 로컬 테스트를 재현한 뒤 운영 배포 버전↔소스 commit 및 R2 비공개 설정 확인 결과를 이어서 기록하면 된다. 비밀키·운영 사용자 데이터는 필요하지 않다.
