"""
OpenDoc — Unified AI Service Layer

Handles communication with multiple LLM providers (Groq, OpenAI, Anthropic, Google)
for generating opinionated, senior-engineer-level project intelligence reports.
"""

import json
import logging
import re
from typing import Optional

from config import settings
from models.schemas import ReportData, ProductDirection
from prompts.report_prompt import SYSTEM_PROMPT, build_user_prompt

logger = logging.getLogger(__name__)


def _clean_json_response(text: str) -> str:
    """Strip markdown code fences if the model wraps the JSON in them."""
    text = text.strip()
    if text.startswith("```json"):
        text = text[7:]
    elif text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    
    # Try to extract just the JSON block if there's surrounding text (common with Anthropic)
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if match:
        text = match.group(0)
        
    return text.strip()


def _parse_product_direction(data: dict) -> Optional[ProductDirection]:
    """Parse the nested product_direction object."""
    pd = data.get("product_direction")
    if not pd:
        return None
    if isinstance(pd, dict):
        return ProductDirection(
            strongest_direction=pd.get("strongest_direction", ""),
            highest_impact_next_step=pd.get("highest_impact_next_step", ""),
            biggest_technical_risk=pd.get("biggest_technical_risk", ""),
            most_impressive_aspect=pd.get("most_impressive_aspect", ""),
            most_underrated_feature=pd.get("most_underrated_feature", ""),
        )
    return None


async def _call_groq(client, model, system_prompt, user_prompt):
    chat_completion = client.chat.completions.create(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        model=model or settings.MODEL,
        max_tokens=settings.MAX_TOKENS,
        temperature=0.5,
        top_p=0.9,
    )
    return chat_completion.choices[0].message.content


async def _call_openai(client, model, system_prompt, user_prompt):
    response = client.chat.completions.create(
        model=model or "gpt-4o",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        temperature=0.5,
        max_tokens=settings.MAX_TOKENS,
    )
    return response.choices[0].message.content


async def _call_anthropic(client, model, system_prompt, user_prompt):
    response = client.messages.create(
        model=model or "claude-3-5-sonnet-latest",
        system=system_prompt,
        messages=[
            {"role": "user", "content": user_prompt}
        ],
        max_tokens=settings.MAX_TOKENS,
        temperature=0.5,
    )
    return response.content[0].text


async def _call_google(client, model, system_prompt, user_prompt):
    from google import genai
    from google.genai import types
    
    response = client.models.generate_content(
        model=model or 'gemini-2.5-pro',
        contents=user_prompt,
        config=types.GenerateContentConfig(
            system_instruction=system_prompt,
            response_mime_type="application/json",
            temperature=0.5,
        )
    )
    return response.text


async def generate_report(
    context_string: str,
    provider: str = "groq",
    model: Optional[str] = None,
    api_key: Optional[str] = None,
    repo_name: str = "",
    repo_url: str = "",
    report_mode: str = "client",
    custom_sections: Optional[list[str]] = None,
) -> ReportData:
    """
    Send repository context to the chosen AI provider and parse the structured JSON response
    into a ReportData object.
    """
    user_prompt = build_user_prompt(context_string)
    raw_response = ""

    # Always use the single strong system prompt
    system_prompt = SYSTEM_PROMPT

    try:
        if provider == "groq":
            key = api_key or settings.GROQ_API_KEY
            if not key: raise ValueError("No Groq API key provided.")
            from groq import Groq
            client = Groq(api_key=key)
            raw_response = await _call_groq(client, model, system_prompt, user_prompt)
            
        elif provider == "openai":
            key = api_key or settings.OPENAI_API_KEY
            if not key: raise ValueError("No OpenAI API key provided.")
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=key)
            raw_response = await _call_openai(client, model, system_prompt, user_prompt)
            
        elif provider == "anthropic":
            key = api_key or settings.ANCHROPIC_API_KEY
            if not key: raise ValueError("No Anthropic API key provided.")
            from anthropic import AsyncAnthropic
            client = AsyncAnthropic(api_key=key)
            raw_response = await _call_anthropic(client, model, system_prompt, user_prompt)
            
        elif provider == "google":
            key = api_key or settings.GEMINI_API_KEY
            if not key: raise ValueError("No Google Gemini API key provided.")
            from google import genai
            client = genai.Client(api_key=key)
            raw_response = await _call_google(client, model, system_prompt, user_prompt)
            
        else:
            raise ValueError(f"Unsupported provider: {provider}")


        logger.info(f"{provider.capitalize()} response length: {len(raw_response)} chars")

        # Parse JSON response
        cleaned = _clean_json_response(raw_response)
        report_dict = json.loads(cleaned)

        # Build the report with all new fields
        report = ReportData(
            repo_name=repo_name,
            repo_url=repo_url,
            report_mode=report_mode,
            executive_summary=report_dict.get("executive_summary", ""),
            what_it_actually_is=report_dict.get("what_it_actually_is", ""),
            core_strengths=report_dict.get("core_strengths", []),
            engineering_assessment=report_dict.get("engineering_assessment", ""),
            scope_vs_execution=report_dict.get("scope_vs_execution", ""),
            product_direction=_parse_product_direction(report_dict),
            biggest_risks=report_dict.get("biggest_risks", []),
            most_impressive_aspect=report_dict.get("most_impressive_aspect", ""),
            recommended_next_step=report_dict.get("recommended_next_step", ""),
            portfolio_assessment=report_dict.get("portfolio_assessment", ""),
            developer_intelligence=report_dict.get("developer_intelligence", ""),
            final_verdict=report_dict.get("final_verdict", ""),
            # Step 3 review & learning fields
            project_maturity=report_dict.get("project_maturity", ""),
            engineering_patterns=report_dict.get("engineering_patterns", []),
            architecture_observations=report_dict.get("architecture_observations", []),
            repeated_concepts=report_dict.get("repeated_concepts", []),
            learning_areas=report_dict.get("learning_areas", []),
        )

        return report

    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse {provider} response as JSON: {e}")
        logger.error(f"Raw response: {raw_response[:500]}")

        # Fallback: put the raw text in executive_summary
        return ReportData(
            repo_name=repo_name,
            repo_url=repo_url,
            report_mode=report_mode,
            executive_summary=raw_response[:2000],
            what_it_actually_is="AI response could not be parsed into structured format. See executive summary for raw analysis.",
        )

    except Exception as e:
        logger.error(f"{provider} API error: {e}")
        raise RuntimeError(f"AI generation failed: {str(e)}")
