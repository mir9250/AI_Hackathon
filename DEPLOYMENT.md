# 돌려받집 배포 상태

기존 사이트 주소: https://dollyeobatjip-demo.newflask.chatgpt.site

서버 재개발을 위해 저장소의 Python 서버·Worker API·DB 스키마와 마이그레이션·서버 실행 및 빌드 설정을 제거했습니다. 화면 파일은 `rental-demo/`와 `sites/deposit-guardian/app/`에 그대로 보존합니다.

기존 사이트 식별자는 `sites/deposit-guardian/.openai/hosting.json`에 남겨 두었습니다. DB와 사진 저장소 바인딩 설정은 제거했습니다. 새 서버와 배포 구성을 준비하기 전에는 이전 빌드·배포 명령을 사용할 수 없습니다.

이번 변경은 로컬 저장소 소스 정리입니다. 공개 사이트 재배포나 운영 DB·사진 데이터 삭제는 수행하지 않았습니다.
