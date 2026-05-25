"""
OpenDoc — Snapshot Service Layer

Handles snapshot persistence, checks for duplicates, formats timestamps, and calls the AI provider.
"""

import logging
from typing import Optional
from config import settings
from services.db_service import save_snapshot, get_previous_snapshot, save_note_version
from prompts.snapshot_prompt import SYSTEM_PROMPT, build_user_prompt
from services.ai_service import (
    _call_groq,
    _call_openai,
    _call_anthropic,
    _call_google,
)
from datetime import datetime

logger = logging.getLogger(__name__)

def format_timestamp(ts_str: str) -> str:
    """Format ISO timestamp string into a human-readable local time (e.g. '2:14 PM')."""
    try:
        # ISO string parsing. E.g., '2026-05-25T14:32:00.000Z'
        clean_ts = ts_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(clean_ts)
        return dt.strftime("%I:%M %p")
    except Exception:
        return ts_str

async def process_snapshot(
    session_id: str,
    timestamp: str,
    goal: str,
    files: list[dict],
    provider: str = "groq",
    model: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Optional[str]:
    """
    Save the incoming snapshot. If a previous snapshot exists, check for changes and
    generate an AI-powered diff summary, then persist it in the note_versions table.
    """
    # 1. Save snapshot to database
    save_snapshot(session_id, timestamp, goal, files)
    
    # 2. Look up the previous snapshot
    prev_snapshot = get_previous_snapshot(session_id, timestamp)
    if not prev_snapshot:
        logger.info(f"First snapshot for session {session_id} recorded. No diff generated.")
        return None
        
    # 3. Check for actual changes to optimize tokens
    # If files list and goal are identical, skip LLM call
    if prev_snapshot["goal"] == goal and prev_snapshot["files"] == files:
        logger.info("Snapshot content identical to previous. Skipping AI diff generation.")
        return None
        
    # 4. Generate AI diff summary
    time_a = format_timestamp(prev_snapshot["timestamp"])
    time_b = format_timestamp(timestamp)
    
    user_prompt = build_user_prompt(
        timestamp_a=time_a,
        goal_a=prev_snapshot["goal"],
        files_a=prev_snapshot["files"],
        timestamp_b=time_b,
        goal_b=goal,
        files_b=files
    )
    
    summary = ""
    try:
        if provider == "groq":
            key = api_key or settings.GROQ_API_KEY
            if not key:
                raise ValueError("No Groq API key provided.")
            from groq import Groq
            client = Groq(api_key=key)
            summary = await _call_groq(client, model, SYSTEM_PROMPT, user_prompt)
            
        elif provider == "openai":
            key = api_key or settings.OPENAI_API_KEY
            if not key:
                raise ValueError("No OpenAI API key provided.")
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=key)
            summary = await _call_openai(client, model, SYSTEM_PROMPT, user_prompt)
            
        elif provider == "anthropic":
            key = api_key or settings.ANTHROPIC_API_KEY
            if not key:
                raise ValueError("No Anthropic API key provided.")
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=key)
            summary = await _call_anthropic(client, model, SYSTEM_PROMPT, user_prompt)
            
        elif provider == "google":
            key = api_key or settings.GEMINI_API_KEY
            if not key:
                raise ValueError("No Google Gemini API key provided.")
            from google import genai
            client = genai.Client(api_key=key)
            summary = await _call_google(client, model, SYSTEM_PROMPT, user_prompt)
            
        else:
            raise ValueError(f"Unsupported provider: {provider}")
            
        summary = summary.strip()
        # Clean up possible wrapping quotes
        if summary.startswith('"') and summary.endswith('"'):
            summary = summary[1:-1].strip()
            
        logger.info(f"Generated diff summary: {summary}")
        
        # 5. Save the note version to database
        save_note_version(session_id, timestamp, summary, goal)
        return summary
        
    except Exception as e:
        logger.error(f"Error generating snapshot diff: {e}")
        return None
