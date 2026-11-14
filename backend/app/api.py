import logging
import asyncio
from uuid import UUID
from typing import Annotated
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
from fastapi import Depends, FastAPI, Request, UploadFile, File, Form, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.exceptions import HTTPException

from .config import Settings
from .errors import ApiError, ErrorResponse
from .gateway import SupabaseGateway
from .schemas import DataResponse, House, HouseInput, Profile, ProfileInput, PhotoUploadResult, PhotoRecord, AnalysisRecord, MoveOutPhotoRecord, ComparisonRecord

from .analysis import EntryAnalysisService
from .comparison import ComparisonService
from .contracts import ContractService
from .contract_analysis import ContractAnalysisService
from .schemas import ContractAnalyzeInput, ContractAnalysisRecord
from .schemas import (ContractCreateInput, ContractCompleteInput, ContractRecord, ContractDetail, ContractFileResult)
from .deletion import DeletionService
from .photos import PhotoService
from .upload_limit import UploadLimitMiddleware

bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Identity:
    user_id: str
    token: str


def gateway(request: Request) -> SupabaseGateway:
    return request.app.state.gateway


async def identity(credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
                   service: SupabaseGateway = Depends(gateway)) -> Identity:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise ApiError(401, "AUTH_REQUIRED", "로그인 후 이용해 주세요.")
    return Identity(await service.authenticate(credentials.credentials), credentials.credentials)


def create_app(settings: Settings, transport: httpx.AsyncBaseTransport | None = None,
               openai_transport: httpx.AsyncBaseTransport | None = None) -> CORSMiddleware:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(timeout=15, transport=transport, follow_redirects=False,
                                     limits=httpx.Limits(max_connections=10)) as client:
            app.state.gateway = SupabaseGateway(settings, client)
            app.state.photo_lock = asyncio.Semaphore(1)
            app.state.contract_ai_lock = asyncio.Semaphore(1)
            async with httpx.AsyncClient(timeout=settings.openai_request_timeout_seconds,
                                         transport=openai_transport, follow_redirects=False) as ai_client:
                app.state.ai_client = ai_client
                yield

    app = FastAPI(title="보증금 지킴이 API", version="0.2.0", lifespan=lifespan,
                  responses={status: {"model": ErrorResponse} for status in
                             (401, 403, 404, 409, 422, 500, 502, 503, 504)})

    @app.exception_handler(ApiError)
    async def api_error_handler(request, exc):
        headers = {"WWW-Authenticate": "Bearer"} if exc.status == 401 else None
        return JSONResponse(status_code=exc.status, content={"error": exc.detail.model_dump()}, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request, exc):
        # Do not echo input values, addresses, passwords or bearer tokens.
        return JSONResponse(status_code=422, content={"error": {
            "code": "VALIDATION_ERROR", "message": "입력 항목의 형식과 길이를 확인해 주세요.", "retryable": False}})

    @app.exception_handler(HTTPException)
    async def http_error_handler(request, exc):
        if request.scope.get('photo_upload_too_large'):
            return JSONResponse(status_code=422, content={"error": {
                "code": "IMAGE_SIZE_LIMIT", "message": "파일은 20MiB 이하로 하나씩 전송해 주세요.",
                "retryable": False}})
        return JSONResponse(status_code=exc.status_code, content={"error": {
            "code": "NOT_FOUND" if exc.status_code == 404 else "HTTP_ERROR",
            "message": "요청한 경로를 찾을 수 없습니다." if exc.status_code == 404 else "허용되지 않은 요청입니다.",
            "retryable": False}})

    @app.exception_handler(Exception)
    async def unexpected_handler(request, exc):
        logging.getLogger("app").error("Unhandled server error: %s", type(exc).__name__)
        return JSONResponse(status_code=500, content={"error": {
            "code": "INTERNAL_ERROR", "message": "서버 오류가 발생했습니다.", "retryable": False}})

    @app.get("/api/health", response_model=DataResponse[dict[str, str]])
    async def health():
        return {"data": {"status": "ok", "version": "0.2.0"}}

    @app.get("/api/profile", response_model=DataResponse[Profile | None])
    async def get_profile(user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await service.record("profiles", user.user_id, user.token)}

    @app.put("/api/profile", response_model=DataResponse[Profile])
    async def put_profile(body: ProfileInput, user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await service.record("profiles", user.user_id, user.token, body.model_dump())}

    @app.get("/api/house", response_model=DataResponse[House | None])
    async def get_house(user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await service.record("houses", user.user_id, user.token)}

    @app.put("/api/house", response_model=DataResponse[House])
    async def put_house(body: HouseInput, user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await service.record("houses", user.user_id, user.token, body.model_dump())}

    @app.post("/api/move-in/photos", response_model=DataResponse[PhotoUploadResult])
    async def upload_move_in(request: Request,
                             file: Annotated[UploadFile, File()],
                             location: Annotated[str, Form(min_length=1, max_length=80)],
                             upload_id: Annotated[UUID, Form()],
                             user: Identity = Depends(identity), service=Depends(gateway)):
        location = location.strip()
        if not location:
            raise ApiError(422, "VALIDATION_ERROR", "촬영 위치를 1~80자로 입력해 주세요.")
        try:
            return {"data": await PhotoService(service, request.app.state.photo_lock).upload(
                user, file, location, upload_id)}
        finally:
            await file.close()

    @app.get("/api/move-in/photos", response_model=DataResponse[list[PhotoRecord]])
    async def get_move_in(request: Request, user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await PhotoService(service, request.app.state.photo_lock).listing(user)}

    @app.post("/api/photos/{photo_id}/analyze", response_model=DataResponse[AnalysisRecord])
    async def analyze_photo(photo_id: UUID, request: Request,
                            user: Identity = Depends(identity), service=Depends(gateway)):
        result = await EntryAnalysisService(service, request.app.state.ai_client,
                                            request.app.state.photo_lock).analyze(user, photo_id)
        return {"data": result}

    @app.post("/api/move-out/photos", response_model=DataResponse[PhotoUploadResult])
    async def upload_move_out(request: Request,
                              file: Annotated[UploadFile, File()],
                              paired_entry_photo_id: Annotated[UUID, Form()],
                              upload_id: Annotated[UUID, Form()],
                              user: Identity = Depends(identity), service=Depends(gateway)):
        try:
            return {"data": await PhotoService(service, request.app.state.photo_lock).upload_exit(
                user, file, paired_entry_photo_id, upload_id)}
        finally:
            await file.close()

    @app.get("/api/move-out/photos", response_model=DataResponse[list[MoveOutPhotoRecord]])
    async def get_move_out(request: Request, user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await PhotoService(service, request.app.state.photo_lock).exit_listing(user)}

    @app.post("/api/move-out/photos/{photo_id}/compare", response_model=DataResponse[ComparisonRecord])
    async def compare_photo(photo_id: UUID, request: Request,
                            user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await ComparisonService(service, request.app.state.ai_client,
            request.app.state.photo_lock).analyze(user, photo_id)}

    @app.post("/api/contracts", response_model=DataResponse[ContractRecord])
    async def create_contract(body: ContractCreateInput, request: Request,
                              user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await ContractService(service, request.app.state.photo_lock).create(
            user, body.source_type, body.upload_id)}

    @app.post("/api/contracts/{id}/pdf", response_model=DataResponse[ContractFileResult])
    async def upload_contract_pdf(id: UUID, request: Request, file: Annotated[UploadFile, File()],
                                  user: Identity = Depends(identity), service=Depends(gateway)):
        try:
            return {"data": await ContractService(service, request.app.state.photo_lock).upload(user, id, file)}
        finally:
            await file.close()

    @app.post("/api/contracts/{id}/pages", response_model=DataResponse[ContractFileResult])
    async def upload_contract_page(id: UUID, request: Request, file: Annotated[UploadFile, File()],
                                   page_number: Annotated[int, Form(ge=1, le=10)],
                                   user: Identity = Depends(identity), service=Depends(gateway)):
        try:
            return {"data": await ContractService(service, request.app.state.photo_lock).upload(user, id, file, page_number)}
        finally:
            await file.close()

    @app.post("/api/contracts/{id}/complete", response_model=DataResponse[ContractRecord])
    async def complete_contract(id: UUID, body: ContractCompleteInput, request: Request,
                                user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await ContractService(service, request.app.state.photo_lock).complete(user, id, body.all_pages_confirmed)}

    @app.get("/api/contracts", response_model=DataResponse[list[ContractRecord]])
    async def list_contracts(request: Request, user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await ContractService(service, request.app.state.photo_lock).listing(user)}

    @app.get("/api/contracts/{id}", response_model=DataResponse[ContractDetail])
    async def get_contract(id: UUID, request: Request, user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await ContractService(service, request.app.state.photo_lock).detail(user, id)}

    @app.post("/api/contracts/{id}/analyze", response_model=DataResponse[ContractAnalysisRecord])
    async def analyze_contract(id: UUID, body: ContractAnalyzeInput, request: Request,
                               user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await ContractAnalysisService(service,request.app.state.ai_client,
            request.app.state.photo_lock,request.app.state.contract_ai_lock).analyze_contract(user,id,body.consent)}

    @app.delete("/api/photos/{photo_id}")
    async def delete_photo(photo_id: UUID, request: Request,
                           paired_exit_photo_id: UUID | None = Query(default=None),
                           user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await DeletionService(service,request.app.state.photo_lock).remove(user,'photo',photo_id,paired_exit_photo_id)}

    @app.delete("/api/contracts/{id}")
    async def delete_contract(id: UUID, request: Request,
                              user: Identity = Depends(identity), service=Depends(gateway)):
        return {"data": await DeletionService(service,request.app.state.photo_lock).remove(user,'contract',id)}

    # Outer CORS wrapper also attaches headers to unhandled 500 responses.
    app.add_middleware(UploadLimitMiddleware)
    return CORSMiddleware(app, allow_origins=settings.cors_origins,
                          allow_methods=["GET", "PUT", "POST", "DELETE", "OPTIONS"],
                          allow_headers=["Authorization", "Content-Type"], allow_credentials=False)
