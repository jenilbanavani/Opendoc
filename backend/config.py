"""
OpenDoc — Configuration & Environment Settings
"""

import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    """Application settings loaded from environment variables."""

    # Optional server-side API keys (fallback if client doesn't provide one)
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    GEMINI_API_KEY: str = os.getenv("GEMINI_API_KEY", "")

    # Optional GitHub personal access token (raises rate limit from 60 → 5000/hr)
    GITHUB_TOKEN: str = os.getenv("GITHUB_TOKEN", "")

    # CORS origins allowed to call this API
    ALLOWED_ORIGINS: list[str] = os.getenv(
        "ALLOWED_ORIGINS", "*"
    ).split(",")

    # Backend host/port
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))

    # Groq model
    MODEL: str = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")

    # Max tokens for AI response
    MAX_TOKENS: int = int(os.getenv("MAX_TOKENS", "4096"))


settings = Settings()
