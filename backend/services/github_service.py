"""
OpenDoc — GitHub Repository Fetcher

Fetches repository metadata, file tree, key files, and recent commits
from the GitHub REST API to build a context string for AI analysis.
"""

import re
import base64
import logging
from typing import Optional

import httpx

from config import settings

logger = logging.getLogger(__name__)

# Files we look for to understand a project
KEY_FILES = [
    "README.md",
    "readme.md",
    "README.rst",
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    "pom.xml",
    "build.gradle",
    "CMakeLists.txt",
    "Makefile",
    "docker-compose.yml",
    "Dockerfile",
    ".env.example",
    "tsconfig.json",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
]

# Max characters per file to keep token usage reasonable
MAX_FILE_CHARS = 3000
MAX_TOTAL_CONTEXT_CHARS = 12000


def parse_github_url(url: str) -> tuple[str, str]:
    """
    Extract owner and repo name from various GitHub URL formats.

    Supports:
        https://github.com/owner/repo
        https://github.com/owner/repo.git
        https://github.com/owner/repo/tree/main
        github.com/owner/repo
    """
    url = url.strip().rstrip("/")

    patterns = [
        r"(?:https?://)?github\.com/([^/]+)/([^/\.]+?)(?:\.git)?(?:/.*)?$",
    ]

    for pattern in patterns:
        match = re.match(pattern, url)
        if match:
            return match.group(1), match.group(2)

    raise ValueError(
        f"Invalid GitHub URL: {url}. "
        "Expected format: https://github.com/owner/repo"
    )


def _build_headers(github_token: Optional[str] = None) -> dict:
    """Build request headers for GitHub API calls."""
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "OpenDoc-Bot/1.0",
    }
    token = github_token or settings.GITHUB_TOKEN
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def fetch_repo_metadata(
    owner: str,
    repo: str,
    github_token: Optional[str] = None,
) -> dict:
    """Fetch basic repository metadata."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}",
            headers=_build_headers(github_token),
        )
        resp.raise_for_status()
        data = resp.json()

    return {
        "name": data.get("name", ""),
        "full_name": data.get("full_name", ""),
        "description": data.get("description", ""),
        "language": data.get("language", ""),
        "stars": data.get("stargazers_count", 0),
        "forks": data.get("forks_count", 0),
        "topics": data.get("topics", []),
        "default_branch": data.get("default_branch", "main"),
        "created_at": data.get("created_at", ""),
        "updated_at": data.get("updated_at", ""),
        "open_issues": data.get("open_issues_count", 0),
        "license": (data.get("license") or {}).get("spdx_id", "None"),
        "url": data.get("html_url", ""),
    }


async def fetch_repo_tree(
    owner: str,
    repo: str,
    branch: str = "main",
    github_token: Optional[str] = None,
) -> list[str]:
    """Fetch the full recursive file tree of the repository."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        # Get branch SHA
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}/branches/{branch}",
            headers=_build_headers(github_token),
        )
        resp.raise_for_status()
        tree_sha = resp.json()["commit"]["commit"]["tree"]["sha"]

        # Get recursive tree
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}/git/trees/{tree_sha}",
            params={"recursive": "1"},
            headers=_build_headers(github_token),
        )
        resp.raise_for_status()
        tree_data = resp.json()

    paths = []
    for item in tree_data.get("tree", []):
        if item.get("type") == "blob":
            paths.append(item["path"])
        elif item.get("type") == "tree":
            paths.append(item["path"] + "/")

    return paths


async def fetch_file_content(
    owner: str,
    repo: str,
    path: str,
    github_token: Optional[str] = None,
) -> Optional[str]:
    """Fetch the content of a single file from the repository."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"https://api.github.com/repos/{owner}/{repo}/contents/{path}",
                headers=_build_headers(github_token),
            )
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            data = resp.json()

        if data.get("encoding") == "base64" and data.get("content"):
            content = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
            return content[:MAX_FILE_CHARS]

        return None
    except Exception as e:
        logger.warning(f"Failed to fetch {path}: {e}")
        return None


async def fetch_recent_commits(
    owner: str,
    repo: str,
    count: int = 5,
    github_token: Optional[str] = None,
) -> list[dict]:
    """Fetch the most recent commits."""
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}/commits",
            params={"per_page": count},
            headers=_build_headers(github_token),
        )
        if resp.status_code != 200:
            return []
        data = resp.json()

    commits = []
    for c in data:
        commit_info = c.get("commit", {})
        commits.append({
            "sha": c.get("sha", "")[:7],
            "message": commit_info.get("message", "").split("\n")[0][:120],
            "author": (commit_info.get("author") or {}).get("name", "Unknown"),
            "date": (commit_info.get("author") or {}).get("date", ""),
        })

    return commits


async def build_repo_context(repo_url: str) -> dict:
    """
    Main entry point — fetches everything and assembles a context dict
    suitable for sending to the AI model.

    Returns:
        {
            "metadata": {...},
            "tree_summary": "...",
            "key_files": {"filename": "content", ...},
            "recent_commits": [...],
            "context_string": "..."   # The assembled text to send to AI
        }
    """
    owner, repo = parse_github_url(repo_url)

    # Fetch metadata first to get the default branch
    metadata = await fetch_repo_metadata(owner, repo)
    branch = metadata.get("default_branch", "main")

    # Fetch tree and commits in parallel-ish
    tree_paths = await fetch_repo_tree(owner, repo, branch)
    commits = await fetch_recent_commits(owner, repo)

    # Determine which key files exist in this repo
    tree_set = set(tree_paths)
    files_to_fetch = [f for f in KEY_FILES if f in tree_set]

    # Also check for case-insensitive README variants
    for path in tree_paths:
        basename = path.split("/")[-1].lower()
        if basename.startswith("readme") and path not in files_to_fetch:
            files_to_fetch.append(path)
            break

    # Fetch key file contents
    key_files = {}
    for fpath in files_to_fetch:
        content = await fetch_file_content(owner, repo, fpath)
        if content:
            key_files[fpath] = content

    # Build the tree summary (limit to ~200 entries for token economy)
    tree_summary_lines = tree_paths[:200]
    if len(tree_paths) > 200:
        tree_summary_lines.append(f"... and {len(tree_paths) - 200} more files")
    tree_summary = "\n".join(tree_summary_lines)

    # Assemble the full context string
    context_parts = []

    context_parts.append("=== REPOSITORY METADATA ===")
    context_parts.append(f"Name: {metadata['full_name']}")
    context_parts.append(f"Description: {metadata['description']}")
    context_parts.append(f"Primary Language: {metadata['language']}")
    context_parts.append(f"Stars: {metadata['stars']} | Forks: {metadata['forks']}")
    context_parts.append(f"Topics: {', '.join(metadata['topics'])}")
    context_parts.append(f"License: {metadata['license']}")
    context_parts.append(f"Created: {metadata['created_at']}")
    context_parts.append(f"Last Updated: {metadata['updated_at']}")
    context_parts.append("")

    context_parts.append("=== FILE STRUCTURE (top entries) ===")
    context_parts.append(tree_summary)
    context_parts.append("")

    for fname, content in key_files.items():
        context_parts.append(f"=== FILE: {fname} ===")
        context_parts.append(content)
        context_parts.append("")

    if commits:
        context_parts.append("=== RECENT COMMITS ===")
        for c in commits:
            context_parts.append(f"[{c['sha']}] {c['message']} — {c['author']} ({c['date']})")
        context_parts.append("")

    context_string = "\n".join(context_parts)

    # Trim if too long
    if len(context_string) > MAX_TOTAL_CONTEXT_CHARS:
        context_string = context_string[:MAX_TOTAL_CONTEXT_CHARS] + "\n\n[... context trimmed for token economy ...]"

    return {
        "metadata": metadata,
        "tree_summary": tree_summary,
        "key_files": key_files,
        "recent_commits": commits,
        "context_string": context_string,
    }
