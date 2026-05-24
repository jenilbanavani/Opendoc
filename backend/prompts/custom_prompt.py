"""
OpenDoc — Custom Report Prompt Builder

Modular prompt assembly: only sections the user explicitly selects
are included in the LLM prompt and JSON schema.
"""

# ---------------------------------------------------------------------------
# Section Registry
#
# Maps each frontend checkbox key → the ReportData fields it controls
# and a focused instruction telling the LLM what to analyze for that section.
# ---------------------------------------------------------------------------

SECTION_REGISTRY = {
    "architecture_notes": {
        "fields": ["engineering_assessment", "engineering_patterns", "architecture_observations"],
        "instruction": (
            "Analyze architecture quality, code organization, scalability, "
            "and maintainability. List detected design patterns (e.g. MVC, "
            "Repository, DI). Provide concrete, file-specific structural observations."
        ),
        "schema": {
            "engineering_assessment": "Analysis of architecture quality, scalability, and maintainability. 4-8 sentences.",
            "engineering_patterns": ["Detected design/architectural patterns in the codebase."],
            "architecture_observations": ["Concrete, file-specific structural observations about how components interact."],
        },
    },
    "risks": {
        "fields": ["biggest_risks"],
        "instruction": (
            "Identify realistic technical and maintenance risks. Each risk "
            "should be specific and explain its consequence."
        ),
        "schema": {
            "biggest_risks": ["Realistic risks: overengineering, complexity, adoption issues, unfinished abstractions. Be specific."],
        },
    },
    "strengths_weaknesses": {
        "fields": ["core_strengths", "biggest_risks"],
        "instruction": (
            "List meaningful project strengths (explain WHY each matters) "
            "and realistic risks or weaknesses with specific consequences."
        ),
        "schema": {
            "core_strengths": ["Meaningful strengths. Explain WHY each matters, not just name it."],
            "biggest_risks": ["Realistic risks with specific consequences."],
        },
    },
    "learning_insights": {
        "fields": ["learning_areas", "repeated_concepts"],
        "instruction": (
            "Identify specific topics, technologies, or libraries the developer "
            "should study next. Point out code duplication or repeated patterns "
            "that present refactoring opportunities."
        ),
        "schema": {
            "learning_areas": ["Specific topics/technologies the developer should study to level up."],
            "repeated_concepts": ["Duplicated patterns or concepts across files that could be refactored."],
        },
    },
    "startup_analysis": {
        "fields": ["product_direction"],
        "instruction": (
            "Assess product direction and startup viability. Evaluate the "
            "strongest direction, highest-impact next step, biggest technical "
            "risk, most impressive aspect, and most underrated feature."
        ),
        "schema": {
            "product_direction": {
                "strongest_direction": "Most valuable direction to prioritize.",
                "highest_impact_next_step": "Single most impactful thing to do next.",
                "biggest_technical_risk": "Most significant technical risk.",
                "most_impressive_aspect": "Genuinely strongest idea or implementation.",
                "most_underrated_feature": "Feature that deserves more attention.",
            },
        },
    },
    "developer_notes": {
        "fields": ["developer_intelligence", "portfolio_assessment"],
        "instruction": (
            "Infer developer skill level, experimentation patterns, and "
            "architectural maturity. Assess how this project fits on a "
            "resume or portfolio."
        ),
        "schema": {
            "developer_intelligence": "Inferred developer skill level, iteration speed, and architectural decisions. 3-5 sentences.",
            "portfolio_assessment": "How this project stands out on a resume. Be honest. 3-5 sentences.",
        },
    },
    "roadmap_suggestions": {
        "fields": ["recommended_next_step"],
        "instruction": (
            "Provide the single highest-impact recommendation for the "
            "project's next step and explain why it matters most."
        ),
        "schema": {
            "recommended_next_step": "The single highest-impact next move. Explain why. 2-4 sentences.",
        },
    },
}

# Baseline fields — always included regardless of checkbox selection
BASELINE_FIELDS = ["executive_summary", "what_it_actually_is", "final_verdict"]

BASELINE_SCHEMA = {
    "executive_summary": "A concise but insightful overview. 3-5 sentences capturing the essence.",
    "what_it_actually_is": "Explain the real identity of the project — purpose, positioning, vision. 4-8 sentences.",
    "final_verdict": "Concluding opinion summarizing the review. Thoughtful and grounded. 2-4 sentences.",
}


def get_fields_for_sections(sections: list[str]) -> set[str]:
    """Return the set of ReportData field names that should be populated
    for the given custom section selections."""
    allowed = set(BASELINE_FIELDS)
    for section_key in sections:
        entry = SECTION_REGISTRY.get(section_key)
        if entry:
            allowed.update(entry["fields"])
    return allowed


def _format_schema_value(value) -> str:
    """Format a schema value into a JSON-like string for the prompt."""
    if isinstance(value, list):
        return '["' + value[0] + '"]'
    elif isinstance(value, dict):
        sub_lines = [f'    "{sk}": "{sv}"' for sk, sv in value.items()]
        return "{\n" + ",\n".join(sub_lines) + "\n  }"
    else:
        return f'"{value}"'


def build_custom_prompt(sections: list[str]) -> str:
    """Build a system prompt containing ONLY the sections the user selected.

    The JSON schema will contain only baseline fields + fields from the
    selected sections.  The LLM is explicitly told not to add extra keys.
    """
    # Collect schema entries and analysis instructions for selected sections
    merged_schema: dict = {}
    instructions: list[str] = []

    # Always start with baseline
    merged_schema.update(BASELINE_SCHEMA)

    for section_key in sections:
        entry = SECTION_REGISTRY.get(section_key)
        if not entry:
            continue
        instructions.append(f"- {entry['instruction']}")
        # Merge schema (later entries win on duplicate keys like biggest_risks)
        for field_key, field_desc in entry["schema"].items():
            merged_schema[field_key] = field_desc

    # Build the JSON template string with deterministic ordering
    schema_lines = []
    for key, value in merged_schema.items():
        schema_lines.append(f'  "{key}": {_format_schema_value(value)}')
    schema_str = ",\n".join(schema_lines)

    # Build the analysis focus section
    if instructions:
        focus_block = "Focus your analysis on ONLY these areas:\n" + "\n".join(instructions)
    else:
        focus_block = (
            "Provide only a high-level overview. Do NOT include detailed "
            "engineering, risk, learning, or product-direction analysis."
        )

    return f"""You are OpenDoc — an AI technical reviewer.
Analyze the repository context and generate a custom report.

{focus_block}

CRITICAL RULES:
- Respond with a valid JSON object (no markdown fences, no extra text).
- The JSON MUST contain EXACTLY these keys and NO others:
{{
{schema_str}
}}
- Do NOT add any keys beyond those listed above.
- Prioritize specific codebase insights over generic descriptions.
- Avoid generic AI praise. Be specific and reference actual code.
"""
