# 돌려받집 배포용 화면 소스

`app/`의 HTML·CSS·브라우저 JavaScript·이미지는 변경하지 않았습니다.

기존 Worker API, DB 스키마·마이그레이션, 로컬 서버 실행 도구, 서버 전용 빌드·테스트 및 의존성을 제거했습니다. 기존 `npm run build`와 서버 테스트 명령은 더 이상 제공하지 않습니다.

화면 미리보기:

```bash
python3 -m http.server 8002 --bind 127.0.0.1 --directory sites/deposit-guardian/app
```

프로젝트 루트에서 실행한 뒤 http://localhost:8002/ 에 접속합니다. 실제 AI·인증·클라우드 저장에는 새 서버가 필요합니다.

`.openai/hosting.json`에는 기존 사이트 식별자만 보존합니다. 기존 DB·사진 저장 바인딩은 제거했습니다. 새 서버와 배포 구성을 준비한 후 배포해야 합니다.
