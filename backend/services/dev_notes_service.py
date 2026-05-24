"""
OpenDoc — Dev Notes AI Service Layer
"""

import json
import logging
from typing import Optional

from config import settings
from models.schemas import DevNotesData, TrackedFile
from prompts.dev_notes_prompt import SYSTEM_PROMPT, build_user_prompt
from services.ai_service import (
    _clean_json_response,
    _call_groq,
    _call_openai,
    _call_anthropic,
    _call_google,
)

logger = logging.getLogger(__name__)

async def generate_dev_notes(
    project_name: str,
    tracked_files: list[TrackedFile],
    provider: str = "groq",
    model: Optional[str] = None,
    api_key: Optional[str] = None,
) -> DevNotesData:
    """
    Send session activity context to the chosen AI provider and parse the structured JSON response
    into a DevNotesData object.
    """
    # Convert TrackedFile objects to dicts for prompt builder
    files_list = []
    for tf in tracked_files:
        files_list.append({
            "filename": tf.filename,
            "imports": tf.imports,
            "functions": tf.functions,
            "action": tf.action,
        })

    user_prompt = build_user_prompt(project_name, files_list)
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

        logger.info(f"{provider.capitalize()} response length for dev notes: {len(raw_response)} chars")

        # Parse JSON response
        cleaned = _clean_json_response(raw_response)
        notes_dict = json.loads(cleaned)

        # Build the structured dev notes object
        dev_notes = DevNotesData(
            what_was_worked_on=notes_dict.get("what_was_worked_on", []),
            concepts_used=notes_dict.get("concepts_used", []),
            possible_goals=notes_dict.get("possible_goals", []),
            architecture_changes=notes_dict.get("architecture_changes", []),
            learning_topics=notes_dict.get("learning_topics", []),
        )

        return dev_notes

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse {provider} response as JSON: {e}")
        logger.error(f"Raw response: {raw_response[:500]}")

        # Fallback empty structures
        return DevNotesData(
            what_was_worked_on=["Failed to parse AI response. See logs for details."],
        )

    except Exception as e:
        logger.error(f"{provider} API error during dev notes: {e}")
        raise RuntimeError(f"AI generation failed: {str(e)}")
