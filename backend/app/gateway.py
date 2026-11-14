"""Supabase Auth / PostgREST adapter. No tokens or upstream response bodies are logged."""
from uuid import UUID

import httpx
import jwt

from .config import Settings
from .errors import ApiError


class SupabaseGateway:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.settings = settings
        self.client = client

    async def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        try:
            return await self.client.request(method, self.settings.supabase_url + path, **kwargs)
        except httpx.TimeoutException:
            raise ApiError(504, "UPSTREAM_TIMEOUT", "인증·데이터 서비스 응답이 지연되고 있습니다.", True) from None
        except httpx.RequestError:
            raise ApiError(503, "UPSTREAM_UNAVAILABLE", "인증·데이터 서비스에 연결할 수 없습니다.", True) from None

    async def authenticate(self, token: str) -> str:
        # This decode only checks claims; signature verification MUST succeed at
        # this project's Auth /user endpoint below before any identity is trusted.
        try:
            claims = jwt.decode(
                token, options={"verify_signature": False, "verify_exp": True,
                                "verify_nbf": True, "verify_iat": True,
                                "verify_aud": True, "verify_iss": True,
                                "require": ["exp", "sub", "iss", "aud"]},
                issuer=self.settings.supabase_url + "/auth/v1", audience="authenticated",
            )
            subject = str(UUID(claims["sub"]))
            if claims.get("role") != "authenticated" or claims.get("is_anonymous") is True:
                raise ValueError("not an email user")
        except (jwt.PyJWTError, ValueError, TypeError, KeyError):
            raise ApiError(401, "INVALID_TOKEN", "로그인이 필요하거나 세션이 만료되었습니다.") from None
        response = await self.request(
            "GET", "/auth/v1/user", headers={
                "apikey": self.settings.supabase_publishable_key.get_secret_value(),
                "Authorization": f"Bearer {token}",
            },
        )
        if response.status_code in {401, 403}:
            raise ApiError(401, "INVALID_TOKEN", "로그인이 필요하거나 세션이 만료되었습니다.")
        if response.status_code == 429:
            raise ApiError(503, "AUTH_RATE_LIMITED", "인증 요청이 많습니다. 잠시 후 다시 시도하세요.", True)
        if response.status_code != 200:
            raise ApiError(502, "AUTH_SERVICE_ERROR", "인증 서비스 오류가 발생했습니다.", response.status_code >= 500)
        try:
            user = response.json()
            if str(UUID(user["id"])) != subject:
                raise ValueError("subject mismatch")
            if not user.get("email_confirmed_at") or user.get("is_anonymous") is True:
                raise ApiError(401, "EMAIL_NOT_CONFIRMED", "이메일 확인 후 로그인해 주세요.")
        except (ValueError, TypeError, KeyError):
            raise ApiError(502, "AUTH_INVALID_RESPONSE", "인증 서비스 응답을 확인할 수 없습니다.") from None
        return subject

    async def record(self, table: str, user_id: str, token: str, values: dict | None = None):
        if table not in {"profiles", "houses"}:
            raise ValueError("unsupported table")
        # Publishable API key + verified user JWT keeps database requests subject to RLS.
        headers = {"apikey": self.settings.supabase_publishable_key.get_secret_value(),
                   "Authorization": f"Bearer {token}"}
        params = {"user_id": f"eq.{user_id}", "select": "*"}
        if values is None:
            response = await self.request("GET", f"/rest/v1/{table}", headers=headers, params=params)
        else:
            params["on_conflict"] = "user_id"
            headers["Prefer"] = "resolution=merge-duplicates,return=representation"
            response = await self.request(
                "POST", f"/rest/v1/{table}", headers=headers, params=params,
                json={**values, "user_id": user_id},
            )
        if response.status_code >= 400:
            self.raise_database_error(response)
        try:
            rows = response.json()
            if not isinstance(rows, list) or len(rows) > 1 or (values is not None and len(rows) != 1):
                raise ValueError("unexpected rows")
            if rows and rows[0]["user_id"] != user_id:
                raise ValueError("ownership mismatch")
            return rows[0] if rows else None
        except (ValueError, KeyError, TypeError):
            raise ApiError(502, "DATABASE_INVALID_RESPONSE", "저장 결과를 확인할 수 없습니다.") from None

    @staticmethod
    def raise_database_error(response: httpx.Response):
        status = response.status_code
        if status == 401:
            raise ApiError(401, "INVALID_TOKEN", "세션이 만료되었습니다. 다시 로그인해 주세요.")
        if status == 403:
            raise ApiError(403, "FORBIDDEN", "이 데이터에 접근할 권한이 없습니다.")
        if status == 409:
            raise ApiError(409, "DATA_CONFLICT", "데이터 상태가 변경되었습니다. 다시 조회해 주세요.")
        if status == 429:
            raise ApiError(503, "DATABASE_BUSY", "데이터 서비스가 혼잡합니다. 잠시 후 다시 시도하세요.", True)
        raise ApiError(502, "DATABASE_ERROR", "데이터 서비스 오류가 발생했습니다.", status >= 500)
