from urllib.parse import urlsplit

from pydantic import SecretStr, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    supabase_url: str
    supabase_publishable_key: SecretStr
    supabase_secret_key: SecretStr
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    app_env: str = "development"
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = "gpt-5.4-mini"
    ai_daily_request_limit: int = Field(default=30, ge=1, le=30)
    openai_request_timeout_seconds: int = Field(default=60, ge=1, le=60)

    @field_validator("supabase_url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.rstrip("/")
        parsed = urlsplit(value)
        local = parsed.hostname in {"localhost", "127.0.0.1"}
        if (parsed.scheme != "https" and not (local and parsed.scheme == "http")) or not parsed.hostname:
            raise ValueError("Supabase URL must use HTTPS (localhost HTTP allowed)")
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
            raise ValueError("Supabase URL must be an origin")
        return value

    @field_validator("supabase_publishable_key", "supabase_secret_key")
    @classmethod
    def validate_key(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().strip():
            raise ValueError("Supabase API key is required")
        return value

    @field_validator("cors_origins")
    @classmethod
    def validate_origins(cls, values: list[str]) -> list[str]:
        if not values:
            raise ValueError("at least one frontend origin is required")
        for value in values:
            parsed = urlsplit(value)
            if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                    or parsed.path or parsed.query or parsed.fragment or parsed.username):
                raise ValueError("CORS origins must be exact origins without paths")
            if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1"}:
                raise ValueError("non-local frontend origins require HTTPS")
        return values
