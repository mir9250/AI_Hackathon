import logging

from pydantic import ValidationError

from app.api import create_app
from app.config import Settings

try:
    settings = Settings()
except ValidationError as exc:
    fields = ", ".join(sorted({str(error["loc"][0]) for error in exc.errors()}))
    logging.getLogger("app").critical("Invalid or missing environment settings: %s", fields)
    raise SystemExit("환경변수 설정을 확인하세요. 오류 필드: " + fields) from None

app = create_app(settings)
