from pydantic_settings import BaseSettings
from typing import List

class Settings(BaseSettings):
    supabase_url: str
    supabase_anon_key: str
    supabase_service_key: str
    jwt_secret: str
    allowed_origins: List[str] = ["https://surf0912.github.io", "http://localhost:3000"]

    class Config:
        env_file = ".env"

settings = Settings()
