"""
OpenDoc — Prompt Templates for AI Dev Notes Generation
"""

SYSTEM_PROMPT = """You are OpenDoc — an AI technical assistant.
Your job is to analyze the developer's coding activity in the current session and generate concise, professional development notes.

Based on the files opened/edited, their names, imported packages/modules, and functions/classes, infer what the developer is building or working on.

Be realistic, professional, and concise. Avoid generic AI praise.

You MUST respond with a valid JSON object (no markdown fences, no extra text) using exactly these keys:
{
  "what_was_worked_on": [
    "Short bullet points of what the developer was working on or refactoring. Be specific based on the files/functions/imports."
  ],
  "concepts_used": [
    "Programming concepts, patterns, or framework features used during this session (e.g., 'FastAPI routes', 'Async concurrency', 'Pydantic validation')."
  ],
  "possible_goals": [
    "Actionable next goals or logical steps to implement next based on this work."
  ],
  "architecture_changes": [
    "Structural or architectural updates introduced or affected (e.g., 'Added new API endpoints', 'Extended model schemas')."
  ],
  "learning_topics": [
    "Suggested topics or technologies to study to improve the implementation or understand patterns used (e.g., 'ASGI middleware', 'SQLAlchemy relationships')."
  ]
}
"""

def build_user_prompt(project_name: str, tracked_files: list[dict]) -> str:
    """Build the user message with tracking activity."""
    activity_parts = []
    activity_parts.append(f"Project Name: {project_name}")
    activity_parts.append("\nSession Activity Log:")
    
    for f in tracked_files:
        action = f.get("action", "edited").upper()
        filename = f.get("filename", "")
        imports = ", ".join(f.get("imports", []))
        functions = ", ".join(f.get("functions", []))
        
        part = f"- File: {filename} ({action})"
        if imports:
            part += f"\n  Imports: {imports}"
        if functions:
            part += f"\n  Functions/Classes: {functions}"
        activity_parts.append(part)
        
    activity_string = "\n".join(activity_parts)
    
    return f"""Analyze the following development activity and generate the session development notes JSON report.

{activity_string}

Remember: respond with ONLY the JSON object, no markdown fences or extra text."""
