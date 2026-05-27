"""
OpenDoc — Prompt Templates for AI Session State Differences (Evolution Notes)
"""

SYSTEM_PROMPT = """You are OpenDoc — an AI technical assistant.
Your job is to analyze the differences between two development session states and write a rich, developer-friendly evolutionary report of what changed between the two timestamps.

You MUST respond with a valid JSON object (no markdown fences, no extra text) using exactly these keys:
{
  "intent_summary": "A concise 1-2 sentence explanation of WHY these changes matter, focusing on developer intent, implementation direction, and architectural significance. Avoid generic descriptions like 'Added middleware'. (e.g., 'You began introducing a structured authentication flow by separating middleware from route logic.')",
  "architecture_evolution": "A brief explanation of structural or architectural changes/advancements (e.g. 'Separation of routes and middleware, moving toward a layered service architecture')",
  "development_progression": "A summary of how the implementation is advancing (e.g. 'Auth middleware created, router routes updated, schemas defined')",
  "major_focus": "The main technical focus area of this change (e.g. 'authentication')",
  "detected_patterns": [
    "Design or programming patterns detected in these changes (e.g., 'middleware', 'layered-architecture', 'service-pattern')"
  ]
}

Be realistic, professional, and concise. Avoid generic AI praise.
"""

def build_user_prompt(
    timestamp_a: str,
    goal_a: str,
    files_a: list[dict],
    timestamp_b: str,
    goal_b: str,
    files_b: list[dict]
) -> str:
    """Build the prompt for the AI to compare session state A and B."""
    def format_files(files):
        if not files:
            return "No files tracked."
        parts = []
        for f in files:
            filename = f.get("filename", "")
            functions = ", ".join(f.get("functions", []))
            imports = ", ".join(f.get("imports", []))
            part = f"- {filename}"
            subparts = []
            if imports:
                subparts.append(f"Imports: {imports}")
            if functions:
                subparts.append(f"Functions/Classes: {functions}")
            if subparts:
                part += " (" + "; ".join(subparts) + ")"
            parts.append(part)
        return "\n".join(parts)

    return f"""Compare the two session states of the workspace and generate the structured evolution note JSON.

Session State A (earlier):
Timestamp: {timestamp_a}
Goal: {goal_a or "Not specified"}
Files & Signatures:
{format_files(files_a)}

Session State B (later):
Timestamp: {timestamp_b}
Goal: {goal_b or "Not specified"}
Files & Signatures:
{format_files(files_b)}

Remember: respond with ONLY the JSON object, no markdown fences or extra text."""
