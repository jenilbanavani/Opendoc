"""
OpenDoc — Technical Signals Extractor

Analyzes folder structure and key file contents to extract technical signals
such as dependencies, route definitions, function/class signatures, folder responsibilities,
and programming patterns. This is done BEFORE sending the context to AI to ensure
highly repo-specific, precise, and mature engineering analyses.
"""

import json
import logging
import re
from typing import Dict, List, Any, Set

logger = logging.getLogger(__name__)

# Constants for file extensions and patterns
SOURCE_EXTENSIONS = {'.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.cs', '.java', '.rb', '.php', '.cpp', '.h', '.c'}

def extract_dependencies(files: Dict[str, str]) -> List[str]:
    """Extract top dependencies and libraries from package/config files."""
    dependencies = []
    
    # 1. Node.js (package.json)
    package_json_key = next((k for k in files if k.endswith("package.json")), None)
    if package_json_key and files[package_json_key]:
        try:
            data = json.loads(files[package_json_key])
            deps = data.get("dependencies", {})
            dev_deps = data.get("devDependencies", {})
            dependencies.extend(deps.keys())
            dependencies.extend(dev_deps.keys())
        except Exception as e:
            logger.warning(f"Failed to parse package.json dependencies: {e}")

    # 2. Python (requirements.txt)
    reqs_key = next((k for k in files if k.endswith("requirements.txt")), None)
    if reqs_key and files[reqs_key]:
        for line in files[reqs_key].splitlines():
            line = line.strip()
            if line and not line.startswith('#'):
                # Extract package name before any version specifiers (==, >=, @, etc.)
                match = re.match(r'^([a-zA-Z0-9_\-\[\]]+)', line)
                if match:
                    dependencies.append(match.group(1))

    # 3. Python (pyproject.toml)
    pyproject_key = next((k for k in files if k.endswith("pyproject.toml")), None)
    if pyproject_key and files[pyproject_key]:
        content = files[pyproject_key]
        # Look for dependency declarations
        dep_section = re.search(r'(?:dependencies|requires)\s*=\s*\[(.*?)\]', content, re.DOTALL)
        if dep_section:
            for dep in re.findall(r'["\']([a-zA-Z0-9_\-\[\]]+)', dep_section.group(1)):
                dependencies.append(dep)

    # 4. Go (go.mod)
    go_mod_key = next((k for k in files if k.endswith("go.mod")), None)
    if go_mod_key and files[go_mod_key]:
        content = files[go_mod_key]
        # Match individual require lines and require blocks
        single_reqs = re.findall(r'^\s*require\s+([a-zA-Z0-9_\-\./]+)', content, re.MULTILINE)
        dependencies.extend(single_reqs)
        block_reqs = re.search(r'require\s*\((.*?)\)', content, re.DOTALL)
        if block_reqs:
            for line in block_reqs.group(1).splitlines():
                line = line.strip()
                if line and not line.startswith('//'):
                    parts = line.split()
                    if parts:
                        dependencies.append(parts[0])

    # 5. Rust (Cargo.toml)
    cargo_key = next((k for k in files if k.endswith("Cargo.toml")), None)
    if cargo_key and files[cargo_key]:
        content = files[cargo_key]
        # Find sections like [dependencies] or [dev-dependencies]
        dep_sections = re.findall(r'\[(?:dev-)?dependencies\](.*?)(?=\n\[|$)', content, re.DOTALL)
        for section in dep_sections:
            for line in section.splitlines():
                line = line.strip()
                if line and not line.startswith('#'):
                    parts = line.split('=')
                    if parts:
                        dependencies.append(parts[0].strip())

    # Return unique dependencies, capped at 25 for token economy
    return sorted(list(set(dependencies)))[:25]


def infer_folder_responsibilities(folder_structure: str) -> Dict[str, str]:
    """Map directory paths to engineering/architectural layers based on keywords."""
    responsibilities = {}
    
    # Extract unique directories from the structure text
    dirs = set()
    for line in folder_structure.splitlines():
        line = line.strip()
        if not line:
            continue
        
        # Strip tree guides and keep just directory path
        clean_line = re.sub(r'^[\s│├└─├─└─]+', '', line)
        if clean_line.endswith('/'):
            dirs.add(clean_line.rstrip('/'))
            
    # Substring match folder names to assign architectural responsibilities
    mapping_rules = {
        "router": "API endpoints, request routing, and web service controllers",
        "route": "API endpoints, request routing, and web service controllers",
        "controller": "Request validation, route handlers, and orchestration",
        "service": "Core business logic, orchestration, and helper services",
        "model": "Database schemas, models, and data representation layers",
        "db": "Database connection setups, migrations, and database seed scripts",
        "schema": "Data validation schemas, serialization/deserialization layers",
        "prompt": "AI prompt templates and prompt engineering configurations",
        "utils": "Reusable helper utilities and generic helper functions",
        "helper": "Reusable helper utilities and generic helper functions",
        "test": "Automated test suites (unit tests, integration tests)",
        "spec": "Automated specification tests and mock environments",
        "view": "Frontend presentation layouts, pages, and components",
        "component": "Reusable user interface widgets and components",
        "extension": "Browser or IDE extensions/integrations code",
        "vscode": "VS Code extension logic or workspace configurations",
        "public": "Static assets, images, and public web resources",
        "asset": "Static media resources, CSS style files, or asset files",
        "middleware": "Request/Response interceptors, auth/cors middlewares",
        "config": "Application configuration files and environment settings"
    }

    for d in sorted(list(dirs)):
        # Only look at the folder basename (deepest folder)
        folder_name = d.split('/')[-1].lower()
        for keyword, desc in mapping_rules.items():
            if keyword in folder_name:
                responsibilities[d] = desc
                break

    # Cap to top 10 unique directory responsibilities
    return {k: responsibilities[k] for k in list(responsibilities.keys())[:10]}


def extract_routes(files: Dict[str, str]) -> List[str]:
    """Parse source code files to identify defined API endpoints / routes."""
    routes = []
    
    # Regex patterns for various routing systems
    patterns = [
        # Python: FastAPI/Flask decorators: @app.get("/"), @router.post("/items")
        (r'@(?:app|router|blueprint)\.(?:get|post|put|delete|patch|route)\s*\(\s*["\']([^"\']+)["\']', "Python Router"),
        # Python: Django paths: path('admin/', admin.site.urls)
        (r'path\s*\(\s*["\']([^"\']+)["\']', "Django Path"),
        # JS/TS: Express: router.get('/api', ...), app.post("/login", ...)
        (r'(?:app|router|route)\.(?:get|post|put|delete|patch|use)\s*\(\s*["\']([^"\']+)["\']', "Express/JS Route"),
        # JS/TS: NestJS: @Get('items'), @Post('/login')
        (r'@(?:Get|Post|Put|Delete|Patch)\s*\(\s*["\']([^"\']+)["\']', "NestJS Route"),
        # Go: Router setups: r.HandleFunc("/path", ...), r.GET("/path", ...)
        (r'\.(?:GET|POST|PUT|DELETE|HandleFunc|Handle|PATCH)\s*\(\s*["\']([^"\']+)["\']', "Go Route"),
        # Rust: Actix/Rocket decorators: #[get("/path")], #[post("/path")]
        (r'#\[(?:get|post|put|delete)\s*\(\s*["\']([^"\']+)["\']', "Rust Route")
    ]

    for fname, content in files.items():
        # Only parse source files
        if not any(fname.endswith(ext) for ext in SOURCE_EXTENSIONS):
            continue
            
        for pattern, route_type in patterns:
            matches = re.finditer(pattern, content)
            for m in matches:
                route_path = m.group(1)
                # Keep routes simple and format nicely
                if route_path and not route_path.startswith('<') and len(route_path) < 100:
                    # Deduplicate path and label it
                    routes.append(f"{route_path} ({route_type})")

    # Clean up and deduplicate
    unique_routes = sorted(list(set(routes)))
    return unique_routes[:20]  # Cap at 20 routes


def extract_functions_and_classes(files: Dict[str, str]) -> Dict[str, List[str]]:
    """Extract class and function signatures grouped by file."""
    signatures = {}

    patterns = [
        # Python: def my_func(...), class MyClass(...)
        r'^\s*(?:async\s+)?(def|class)\s+([a-zA-Z0-9_]+)\b',
        # JS/TS: function myFunc(...), class MyClass(...)
        r'^\s*(?:export\s+)?(?:async\s+)?(function|class)\s+([a-zA-Z0-9_]+)\b',
        # JS/TS arrow functions: const myFunc = async (...) =>
        r'^\s*(?:export\s+)?const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(.*?\)\s*=>',
        # Rust: fn my_func(...), struct MyStruct(...)
        r'^\s*(?:pub\s+)?(?:async\s+)?(fn|struct|enum)\s+([a-zA-Z0-9_]+)\b',
        # Go: func myFunc(...), type MyStruct struct
        r'^\s*func\s+([a-zA-Z0-9_]+)\b',
        # Go struct definitions
        r'^\s*type\s+([a-zA-Z0-9_]+)\s+struct\b',
        # Java/C#: class MyClass, interface MyInterface
        r'^\s*(?:public|private|protected|internal|static|\s)*(class|interface)\s+([a-zA-Z0-9_]+)\b'
    ]

    for fname, content in files.items():
        # Only parse source files, ignore config files or markdown
        if not any(fname.endswith(ext) for ext in SOURCE_EXTENSIONS):
            continue

        file_sigs = []
        lines = content.splitlines()
        for line in lines:
            line = line.strip()
            # Ignore comments
            if line.startswith('#') or line.startswith('//') or line.startswith('*'):
                continue
                
            for pattern in patterns:
                match = re.match(pattern, line)
                if match:
                    # Extract the match groups
                    groups = match.groups()
                    if len(groups) == 2:
                        keyword, name = groups
                        file_sigs.append(f"{keyword} {name}")
                    elif len(groups) == 1:
                        name = groups[0]
                        # Avoid matching control flow structures
                        if name not in {"if", "for", "while", "switch", "catch", "return", "const", "let", "var"}:
                            file_sigs.append(f"function {name}")
                    break

        if file_sigs:
            # Deduplicate and cap signatures per file
            signatures[fname] = sorted(list(set(file_sigs)))[:10]

    # Return signatures for files containing definitions, cap files list
    return {k: signatures[k] for k in list(signatures.keys())[:10]}


def detect_implementation_patterns(files: Dict[str, str]) -> List[str]:
    """Detect software design/implementation patterns used in the codebase."""
    patterns = []
    
    # Combined content for scanning patterns
    full_content = "\n".join(files.values()).lower()
    
    # 1. Asynchrony
    if "async" in full_content or "await" in full_content or "promise" in full_content:
        patterns.append("Async/Await Asynchrony Pattern")
        
    # 2. Decorators / Annotations
    decorator_matches = [re.search(r'^\s*@[a-zA-Z0-9_]+', c, re.MULTILINE) for c in files.values()]
    if any(decorator_matches):
        patterns.append("Decorator / Annotation Pattern (meta-programming)")
        
    # 3. Model-View-Controller (MVC) structure
    has_models = any("model" in k.lower() for k in files)
    has_views = any("view" in k.lower() or "component" in k.lower() for k in files)
    has_controllers = any("controller" in k.lower() or "router" in k.lower() for k in files)
    if has_models and has_views and has_controllers:
        patterns.append("Model-View-Controller (MVC) Pattern")
    elif has_models and has_controllers:
        patterns.append("Backend Router-Model Architecture")

    # 4. Dependency Injection
    if "inject" in full_content or "dependency_injector" in full_content or "container" in full_content:
        patterns.append("Dependency Injection / Container Pattern")

    # 5. Database Integration / ORM
    db_keywords = ["prisma", "sqlalchemy", "sqlite", "sequelize", "mongoose", "psycopg2", "pymongo", "database_url", "alembic", "schema.create"]
    if any(kw in full_content for kw in db_keywords):
        patterns.append("ORM / Database Persistence Layer")

    # 6. Type Safety
    ts_files = any(k.endswith(".ts") or k.endswith(".tsx") for k in files)
    go_files = any(k.endswith(".go") for k in files)
    rs_files = any(k.endswith(".rs") for k in files)
    if ts_files or go_files or rs_files:
        patterns.append("Strongly Typed Implementation")

    # 7. Router-Service separation
    has_routers = any("router" in k.lower() or "route" in k.lower() for k in files)
    has_services = any("service" in k.lower() for k in files)
    if has_routers and has_services:
        patterns.append("Router-Service Separation Pattern")

    # 8. WebSockets / Event-driven
    websocket_keywords = ["websocket", "socket.io", "pubsub", "eventemitter", "subscribe", "emit"]
    if any(kw in full_content for kw in websocket_keywords):
        patterns.append("Event-Driven / WebSocket Communication")

    return patterns


def build_unified_context(
    project_name: str,
    folder_structure: str,
    files: Dict[str, str],
    recent_commits: List[Dict[str, Any]] = None,
    metadata: Dict[str, Any] = None
) -> str:
    """
    Extracts all technical signals and formats a single, comprehensive
    context string to feed to the LLM.
    """
    logger.info(f"Extracting technical signals for project: {project_name}")
    
    # Perform extraction
    dependencies = extract_dependencies(files)
    folder_resps = infer_folder_responsibilities(folder_structure)
    routes = extract_routes(files)
    funcs_and_classes = extract_functions_and_classes(files)
    patterns = detect_implementation_patterns(files)

    # Compile the formatted output
    context_parts = []
    
    context_parts.append("=== REPOSITORY METADATA ===")
    context_parts.append(f"Name: {project_name}")
    if metadata:
        context_parts.append(f"Description: {metadata.get('description', '')}")
        context_parts.append(f"Primary Language: {metadata.get('language', '')}")
        context_parts.append(f"Stars: {metadata.get('stars', 0)} | Forks: {metadata.get('forks', 0)}")
        context_parts.append(f"License: {metadata.get('license', 'None')}")
        context_parts.append(f"URL: {metadata.get('url', '')}")
    else:
        context_parts.append("Source: Local Workspace (VS Code)")
    context_parts.append("")

    context_parts.append("=== FILE STRUCTURE ===")
    # Limit tree summary line count
    lines = folder_structure.splitlines()
    if len(lines) > 200:
        context_parts.append("\n".join(lines[:200]))
        context_parts.append(f"... and {len(lines) - 200} more files")
    else:
        context_parts.append(folder_structure)
    context_parts.append("")

    context_parts.append("=== EXTRACTED TECHNICAL SIGNALS ===")
    
    # 1. Folder responsibilities
    if folder_resps:
        context_parts.append("--- Folder Responsibilities ---")
        for folder, desc in folder_resps.items():
            context_parts.append(f"- {folder}/: {desc}")
        context_parts.append("")
        
    # 2. Dependencies
    if dependencies:
        context_parts.append("--- Top Dependencies ---")
        context_parts.append(", ".join(dependencies))
        context_parts.append("")

    # 3. API Routes
    if routes:
        context_parts.append("--- API Routes & Endpoints ---")
        for r in routes:
            context_parts.append(f"- {r}")
        context_parts.append("")

    # 4. Classes & Functions
    if funcs_and_classes:
        context_parts.append("--- Declared Classes & Functions ---")
        for filepath, sigs in funcs_and_classes.items():
            context_parts.append(f"File: {filepath}")
            for sig in sigs:
                context_parts.append(f"  * {sig}")
        context_parts.append("")

    # 5. Patterns
    if patterns:
        context_parts.append("--- Implementation Patterns & Architecture ---")
        for p in patterns:
            context_parts.append(f"- {p}")
        context_parts.append("")

    # Recent Commits (if available)
    if recent_commits:
        context_parts.append("=== RECENT COMMITS ===")
        for c in recent_commits:
            context_parts.append(f"[{c['sha']}] {c['message']} — {c['author']} ({c['date']})")
        context_parts.append("")

    # Key files contents (README, etc.) - only append README or configs specifically, do not dump raw code files
    context_parts.append("=== CONFIGURATION & README CONTENTS ===")
    readme_keys = [k for k in files if "readme" in k.lower()]
    for k in readme_keys:
        context_parts.append(f"=== FILE: {k} ===")
        context_parts.append(files[k][:2500]) # Cap to avoid token bloat
        context_parts.append("")
        
    # Include configuration files
    config_keys = [k for k in files if any(cfg in k for cfg in ["package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "Dockerfile", "docker-compose.yml", "tsconfig.json"])]
    for k in config_keys:
        if k not in readme_keys:
            context_parts.append(f"=== FILE: {k} ===")
            context_parts.append(files[k][:2000])
            context_parts.append("")

    return "\n".join(context_parts)
