"""미리보기는 실제 공개 판례 라우터만 실행한다. 로그인·저장·AI를 흉내내지 않는다."""
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from app.errors import ApiError
from app.legal import router

app = FastAPI(title='돌려받집 공개 판례 미리보기')
app.include_router(router)


@app.exception_handler(ApiError)
async def error_handler(request, exc):
    return JSONResponse(status_code=exc.status, content={'error': exc.detail.model_dump()})
