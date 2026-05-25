"""
OpenDoc — Prompt Templates for AI Diffing of Snapshots
"""

SYSTEM_PROMPT = """You are OpenDoc — an AI technical assistant.
Your job is to analyze the differences between two workspace snapshots from a coding session and write a brief, developer-friendly diff summary (1-2 sentences) of what changed between the two timestamps.

For example:
"Between 2:14 PM and 3:40 PM, you added the auth middleware, changed the schema, and started on the payment route."
"Between 3:40 PM and 4:15 PM, you fixed a CORS bug, added validation to the login route, and updated tests."

Keep it highly concise, natural, and directly address the changes in files, imports, and functions.
If the goals are provided, use them as context for the developer's intent. Do not output anything other than the 1-2 sentence summary. Do not include markdown code fences or extra words.
"""

def build_user_prompt(
    timestamp_a: str,
    goal_a: str,
    files_a: list[dict],
    timestamp_b: str,
    goal_b: str,
    files_b: list[dict]
) -> str:
    """Build the prompt for the AI to compare snapshot A and B."""
    def format_files(files):
        if not files:
            return "No files tracked."
        parts = []
        for f in files:
            filename = f.get("filename", "")
            functions = ", ".join(f.get("functions", []))
            part = f"- {filename}"
            if functions:
                part += f" (Functions: {functions})"
            parts.append(part)
        return "\n".join(parts)

    return f"""Compare the two snapshots of the workspace and write a concise 1-2 sentence diff summary of what changed.

Snapshot A (earlier):
Timestamp: {timestamp_a}
Goal: {goal_a or "Not specified"}
Files & Functions:
{format_files(files_a)}

Snapshot B (later):
Timestamp: {timestamp_b}
Goal: {goal_b or "Not specified"}
Files & Functions:
{format_files(files_b)}
"""
