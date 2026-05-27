"""
OpenDoc — Session State Service Layer

Handles session state persistence, checks for changes, and calls the AI provider to generate
evolutionary notes.
"""

import json
import logging
from typing import Optional
from config import settings
from services.db_service import save_session_state, get_previous_session_state, save_evolution_note
from prompts.session_state_prompt import SYSTEM_PROMPT, build_user_prompt
from services.ai_service import (
    _clean_json_response,
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

async def process_session_state(
    session_id: str,
    timestamp: str,
    goal: str,
    files: list[dict],
    provider: str = "groq",
    model: Optional[str] = None,
    api_key: Optional[str] = None,
) -> Optional[dict]:
    """
    Save the incoming session state. If a previous session state exists, check for changes and
    generate an AI-powered evolutionary report, then persist it in the evolution_notes table.
    """
    # 1. Save session state to database (automatically computes metadata)
    saved_state = save_session_state(session_id, timestamp, goal, files)
    
    # 2. Look up the previous session state
    prev_state = get_previous_session_state(session_id, timestamp)
    if not prev_state:
        logger.info(f"First session state for session {session_id} recorded. No evolution generated.")
        return None
        
    # 3. Check for actual changes to optimize tokens
    # If files list and goal are identical, skip LLM call
    if prev_state["goal"] == goal and prev_state["files"] == files:
        logger.info("Session state content identical to previous. Skipping AI diff generation.")
        return None
        
    # 4. Generate AI evolution summary
    time_a = format_timestamp(prev_state["timestamp"])
    time_b = format_timestamp(timestamp)
    
    user_prompt = build_user_prompt(
        timestamp_a=time_a,
        goal_a=prev_state["goal"],
        files_a=prev_state["files"],
        timestamp_b=time_b,
        goal_b=goal,
        files_b=files
    )
    
    raw_response = ""
    try:
        if provider == "groq":
            key = api_key or settings.GROQ_API_KEY
            if not key:
                raise ValueError("No Groq API key provided.")
            from groq import Groq
            client = Groq(api_key=key)
            raw_response = await _call_groq(client, model, SYSTEM_PROMPT, user_prompt)
            
        elif provider == "openai":
            key = api_key or settings.OPENAI_API_KEY
            if not key:
                raise ValueError("No OpenAI API key provided.")
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=key)
            raw_response = await _call_openai(client, model, SYSTEM_PROMPT, user_prompt)
            
        elif provider == "anthropic":
            key = api_key or settings.ANTHROPIC_API_KEY
            if not key:
                raise ValueError("No Anthropic API key provided.")
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=key)
            raw_response = await _call_anthropic(client, model, SYSTEM_PROMPT, user_prompt)
            
        elif provider == "google":
            key = api_key or settings.GEMINI_API_KEY
            if not key:
                raise ValueError("No Google Gemini API key provided.")
            from google import genai
            client = genai.Client(api_key=key)
            raw_response = await _call_google(client, model, SYSTEM_PROMPT, user_prompt)
            
        else:
            raise ValueError(f"Unsupported provider: {provider}")
            
        cleaned = _clean_json_response(raw_response)
        notes_dict = json.loads(cleaned)
        
        intent_summary = notes_dict.get("intent_summary", "").strip()
        architecture_evolution = notes_dict.get("architecture_evolution", "").strip()
        development_progression = notes_dict.get("development_progression", "").strip()
        major_focus = notes_dict.get("major_focus", "").strip()
        detected_patterns = notes_dict.get("detected_patterns", [])
        primary_language = saved_state["primary_language"]
        
        logger.info(f"Generated evolution note: {intent_summary}")
        
        # 5. Save the evolution note to database
        save_evolution_note(
            session_id=session_id,
            timestamp=timestamp,
            goal=goal,
            intent_summary=intent_summary,
            architecture_evolution=architecture_evolution,
            development_progression=development_progression,
            files_changed_count=saved_state["files_changed_count"],
            session_duration=saved_state["session_duration"],
            major_focus=major_focus,
            detected_patterns=detected_patterns,
            primary_language=primary_language
        )
        
        return {
            "intent_summary": intent_summary,
            "architecture_evolution": architecture_evolution,
            "development_progression": development_progression,
            "files_changed_count": saved_state["files_changed_count"],
            "session_duration": saved_state["session_duration"],
            "major_focus": major_focus,
            "detected_patterns": detected_patterns,
            "primary_language": primary_language
        }
        
    except Exception as e:
        logger.error(f"Error generating session state evolution: {e}")
        return None
