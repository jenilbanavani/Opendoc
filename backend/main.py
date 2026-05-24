"""
OpenDoc — FastAPI Application Entrypoint
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from routers.analyze import router as analyze_router

app = FastAPI(
    title="OpenDoc API",
    description="AI-powered developer documentation and project intelligence.",
    version="1.0.0",
)

# CORS — allow the Chrome extension (and dev tools) to call us
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(analyze_router, prefix="/api", tags=["Analysis"])


@app.get("/", tags=["Health"])
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "OpenDoc API",
        "version": "1.0.0",
    }
