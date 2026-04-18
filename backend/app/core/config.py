from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    LLM_MODEL_NAME: str = "qwen2.5-coder:1.5b"
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

settings = Settings()
