# 계정 저장 API 참고본

실제 배포 소스는 Sites 전용 저장소 sites/deposit-guardian/입니다. 이 폴더는 팀원이 검토·이식할 수 있는 서버 로직 및 생성된 스키마 참고본입니다. accounts.mjs는 Worker의 json, headers, check, AI 전역과 함께 번들링하며 독립 실행용 서버가 아닙니다.

인증은 Sites의 검증된 oai-authenticated-user-id/email 헤더만 사용합니다. 일반 인터넷 서버로 이식할 때는 클라이언트 헤더를 신뢰하면 안 되며, 팀의 실제 세션 검증 결과로 대체해야 합니다.

- GET /api/account/me: 로그인·프로필 여부
- POST /api/account/register: displayName, consent (프로필 등록)
- POST /api/account/session: 로그인 방문 기록
- POST /api/account/logout: 로그아웃 요청 기록
- GET /api/account/history: 자신의 최근 접속 기록
- POST /api/photos: 이미지 바이트 업로드, 자신의 사진 ID 반환
- GET /api/photos/:id: 소유자만 원본 접근
- GET /api/workspace: 자신의 기록·버전 조회
- PUT /api/workspace: workspace와 baseVersion을 이용한 조건부 저장. 충돌 시 409.

프로필과 메모는 D1, 원본 사진은 비공개 R2에 저장합니다. DB에는 비밀번호·플랫폼 로그인 토큰을 저장하지 않습니다. 플랫폼이 로그인 상태를 관리합니다. 예시 테스트 계정은 실제 배포 DB에 생성하지 않았습니다.

같은 플랫폼 계정의 회원 ID를 DB 키로 사용하므로 브라우저가 달라도 같은 회원·사진·메모를 조회합니다. users.last_login_at에는 마지막 로그인 확인 시각을 기록합니다.

/api/account/me 이외의 계정 API에는 X-Account-Id를 전달합니다. 쓰기 요청에는 필수이며, 서버 인증 사용자와 일치하지 않으면 ACCOUNT_CHANGED 코드와 409로 차단합니다. 이 헤더 자체는 인증 수단이 아닙니다.

### 저장된 기록 · 생활 일지

- #archive: 공간별 최신 입주·퇴실 기록, 생활 일지, AI 결과를 유형/검색어로 모아보기. 전체 사진 버전 이력은 아님.
- #journal: 날짜·제목·분류·공간·진행 상태·내용 작성 및 수정. 최대 100개, 제목 80자, 내용 2,000자. 임시 작성 내용과 완료된 일지는 구분.
- 로그인한 사용자의 일지와 임시 작성 내용은 기존 D1 workspaces.payload에 계정별 저장. 비회원은 기기 저장. 같은 계정으로 다른 브라우저에 로그인하면 복원. 기존 버전 충돌 보호 유지.
- HTML 리포트에 저장 완료한 일지도 포함. 발생일/예정일은 사용자 입력이며 시각을 인증하는 기록은 아님.
- 검증: records-test.cjs와 배포 소스 account-test.mjs, cloud-client-test.mjs로 작성/수정/검색, DB 왕복, 기기간 복원 및 계정 분리 확인. 실제 브라우저 시각 검수는 이 환경에서 미실행.
