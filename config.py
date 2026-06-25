from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import List

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")

    supabase_url: str
    supabase_anon_key: str
    supabase_service_key: str
    jwt_secret: str
    allowed_origins: List[str] = ["https://surf0912.github.io", "http://localhost:3000"]

settings = Settings()
