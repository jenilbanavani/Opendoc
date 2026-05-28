/**
 * OpenDoc — Workspace Scanner Utilities
 *
 * Reads the local workspace folder tree and key project files
 * to build context for the AI analysis backend.
 */

import * as vscode from "vscode";
import * as path from "path";

/** Directories to always skip when scanning */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".vscode",
  ".idea",
  "venv",
  ".venv",
  "env",
  ".env",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  "bin",
  "obj",
  ".gradle",
]);

/** Key files we look for to understand a project */
const KEY_FILES = [
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
  "setup.py",
  "setup.cfg",
];

/** Max characters per file to keep token usage reasonable */
const MAX_FILE_CHARS = 3000;

/**
 * Recursively walk a workspace folder and return a newline-separated
 * file tree string (capped at ~300 entries for token economy).
 */
export async function getWorkspaceTree(
  rootUri: vscode.Uri,
  maxEntries: number = 300
): Promise<string> {
  const lines: string[] = [];

  async function walk(dir: vscode.Uri, prefix: string): Promise<void> {
    if (lines.length >= maxEntries) {
      return;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }

    // Sort: directories first, then files, alphabetically
    entries.sort((a, b) => {
      const aIsDir = a[1] === vscode.FileType.Directory ? 0 : 1;
      const bIsDir = b[1] === vscode.FileType.Directory ? 0 : 1;
      if (aIsDir !== bIsDir) {
        return aIsDir - bIsDir;
      }
      return a[0].localeCompare(b[0]);
    });

    for (const [name, type] of entries) {
      if (lines.length >= maxEntries) {
        break;
      }

      if (type === vscode.FileType.Directory) {
        if (IGNORED_DIRS.has(name) || name.startsWith(".")) {
          continue;
        }
        lines.push(`${prefix}${name}/`);
        const childUri = vscode.Uri.joinPath(dir, name);
        await walk(childUri, prefix + "  ");
      } else {
        lines.push(`${prefix}${name}`);
      }
    }
  }

  await walk(rootUri, "");

  if (lines.length >= maxEntries) {
    lines.push(`... and more files (tree capped at ${maxEntries} entries)`);
  }

  return lines.join("\n");
}

/**
 * Read the contents of key project files (README, package.json, etc.)
 * Returns a map of filename → content.
 */
export async function readKeyFiles(
  rootUri: vscode.Uri
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  // 1. Get the list of files at root level (configs, README, etc.)
  let rootEntries: [string, vscode.FileType][];
  try {
    rootEntries = await vscode.workspace.fs.readDirectory(rootUri);
  } catch {
    return result;
  }

  const rootFileNames = new Set(
    rootEntries
      .filter(([, type]) => type === vscode.FileType.File)
      .map(([name]) => name)
  );

  for (const keyFile of KEY_FILES) {
    // Check case-insensitive match
    const match = [...rootFileNames].find(
      (f) => f.toLowerCase() === keyFile.toLowerCase()
    );
    if (!match) {
      continue;
    }

    try {
      const fileUri = vscode.Uri.joinPath(rootUri, match);
      const raw = await vscode.workspace.fs.readFile(fileUri);
      const content = Buffer.from(raw).toString("utf-8");
      result[match] = content.slice(0, MAX_FILE_CHARS);
    } catch {
      // Skip unreadable files
    }
  }

  // 2. Recursively find important source code files to extract technical signals
  const sourceExtensions = new Set([
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".go",
    ".rs",
    ".cs",
    ".java",
    ".rb",
    ".php",
    ".cpp",
    ".h",
    ".c",
  ]);
  const allSourceFiles: { relPath: string; uri: vscode.Uri }[] = [];

  async function walk(dirUri: vscode.Uri, relPathPrefix: string): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      if (type === vscode.FileType.Directory) {
        if (IGNORED_DIRS.has(name) || name.startsWith(".")) {
          continue;
        }
        const childUri = vscode.Uri.joinPath(dirUri, name);
        await walk(childUri, relPathPrefix ? `${relPathPrefix}/${name}` : name);
      } else {
        if (name.startsWith(".")) {
          continue;
        }
        const cleanExt = path.extname(name).toLowerCase();
        if (sourceExtensions.has(cleanExt)) {
          const fileRelPath = relPathPrefix ? `${relPathPrefix}/${name}` : name;
          allSourceFiles.push({
            relPath: fileRelPath,
            uri: vscode.Uri.joinPath(dirUri, name),
          });
        }
      }
    }
  }

  await walk(rootUri, "");

  // Score files to select top 12
  const scoredFiles: { score: number; relPath: string; uri: vscode.Uri }[] = [];
  for (const file of allSourceFiles) {
    const basename = path.basename(file.relPath).toLowerCase();
    const relPathLower = file.relPath.toLowerCase();
    let score = 0;

    // High priority: Entry points
    if (
      [
        "main.py",
        "app.py",
        "index.js",
        "index.ts",
        "server.js",
        "server.ts",
        "main.go",
        "main.rs",
        "app.js",
        "app.ts",
      ].includes(basename)
    ) {
      score += 100;
    } else if (
      ["main", "app", "server", "index"].some((k) => basename.includes(k))
    ) {
      score += 50;
    }

    // High priority: routes, controllers, services, models
    if (
      ["router", "route", "controller", "service", "model", "api", "handler"].some(
        (k) => relPathLower.includes(k)
      )
    ) {
      score += 30;
    }

    // High priority: src, app, backend, lib folders
    if (
      ["src/", "app/", "backend/", "lib/"].some((k) => relPathLower.includes(k))
    ) {
      score += 10;
    }

    // Ignore test/spec/mock files
    if (
      ["test", "spec", "mock"].some(
        (k) => basename.includes(k) || relPathLower.includes(k)
      )
    ) {
      score = -100;
    }

    scoredFiles.push({ score, relPath: file.relPath, uri: file.uri });
  }

  // Sort descending by score, filter out files with negative scores, and limit to 12
  scoredFiles.sort((a, b) => b.score - a.score);
  const selectedSources = scoredFiles.filter((f) => f.score >= -50).slice(0, 12);

  // Read content of selected source files
  for (const file of selectedSources) {
    if (result[file.relPath]) {
      continue; // Skip if already read (e.g. root files)
    }
    try {
      const raw = await vscode.workspace.fs.readFile(file.uri);
      const content = Buffer.from(raw).toString("utf-8");
      result[file.relPath] = content.slice(0, MAX_FILE_CHARS);
    } catch {
      // Skip unreadable files
    }
  }

  return result;
}

/**
 * Extract imports and functions/classes from file content using regex.
 */
export function analyzeFileContent(
  content: string,
  filename: string
): { imports: string[]; functions: string[] } {
  const imports: string[] = [];
  const functions: string[] = [];

  const lines = content.split(/\r?\n/);

  // Regex patterns
  const importRegexes = [
    /^\s*(?:import|from)\s+([a-zA-Z0-9_\-\.]+)/, // Python / JS / TS
    /^\s*(?:const|let|var)\s+.*\s*=\s*require\(['"]([^'"]+)['"]\)/, // JS CommonJS
    /^\s*import\s+.*\s+from\s+['"]([^'"]+)['"]/, // JS ESM
    /^\s*using\s+([a-zA-Z0-9_\.]+);/, // C#
    /^\s*package\s+([a-zA-Z0-9_\.]+)/, // Java / Go
  ];

  const functionRegexes = [
    /def\s+([a-zA-Z0-9_]+)\s*\(/, // Python function
    /class\s+([a-zA-Z0-9_]+)/, // Python/JS/TS class
    /function\s+([a-zA-Z0-9_]+)\s*\(/, // JS/TS function
    /const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(.*\)\s*=>/, // JS/TS arrow function
    /fn\s+([a-zA-Z0-9_]+)\s*\(/, // Rust fn
    /func\s+([a-zA-Z0-9_]+)\s*\(/, // Go func
    /(?:public|private|protected|internal)\s+(?:async\s+)?(?:static\s+)?[a-zA-Z0-9_<>]+\s+([a-zA-Z0-9_]+)\s*\(/, // C# / Java / C++
  ];

  for (const line of lines) {
    // Look for imports
    for (const rx of importRegexes) {
      const match = line.match(rx);
      if (match && match[1]) {
        imports.push(match[1].trim());
        break;
      }
    }
    // Look for functions/classes
    for (const rx of functionRegexes) {
      const match = line.match(rx);
      if (match && match[1]) {
        functions.push(match[1].trim());
        break;
      }
    }
  }

  // Deduplicate and cap to top 15 each
  return {
    imports: Array.from(new Set(imports)).slice(0, 15),
    functions: Array.from(new Set(functions)).slice(0, 15),
  };
}

export interface WorkspaceMetadata {
  workspaceRoot: string;
  projectName: string;
  languages: string[];
  git: {
    isRepository: boolean;
    isInstalled: boolean;
  };
}

/**
 * Automatically detects the current VS Code workspace metadata, including
 * workspace root path, project name, detected programming languages, and Git status.
 */
export async function detectWorkspaceMetadata(): Promise<WorkspaceMetadata | null> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return null;
  }

  const rootFolder = workspaceFolders[0];
  const workspaceRoot = rootFolder.uri.fsPath;
  const projectName = rootFolder.name;

  // 1. Language Detection
  const languages: string[] = [];
  const langChecks = [
    { name: "Python", pattern: "**/*.py" },
    { name: "TypeScript", pattern: "**/*.{ts,tsx}" },
    { name: "JavaScript", pattern: "**/*.{js,jsx}" },
    { name: "Go", pattern: "**/*.go" },
    { name: "Rust", pattern: "**/*.rs" },
    { name: "Java", pattern: "**/*.java" },
    { name: "C#", pattern: "**/*.cs" },
    { name: "C/C++", pattern: "**/*.{c,cpp,h}" },
    { name: "Ruby", pattern: "**/*.rb" },
    { name: "PHP", pattern: "**/*.php" },
    { name: "HTML", pattern: "**/*.html" },
    { name: "CSS", pattern: "**/*.css" },
  ];

  try {
    const checkPromises = langChecks.map(async (check) => {
      const files = await vscode.workspace.findFiles(
        check.pattern,
        "**/{node_modules,venv,.venv,dist,build,out,.git}/**",
        1
      );
      if (files.length > 0) {
        languages.push(check.name);
      }
    });
    await Promise.all(checkPromises);
  } catch (err) {
    console.error("Language detection error:", err);
  }

  // Sort languages alphabetically
  languages.sort();

  // 2. Git Availability Detection
  let isRepository = false;
  let isInstalled = false;

  // Check .git directory presence
  try {
    const gitUri = vscode.Uri.joinPath(rootFolder.uri, ".git");
    await vscode.workspace.fs.stat(gitUri);
    isRepository = true;
  } catch {
    // If not found directly, check via vscode.git extension API below
  }

  // Check VS Code Git Extension status
  try {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (gitExtension) {
      if (!gitExtension.isActive) {
        await gitExtension.activate();
      }
      const gitAPI = gitExtension.exports.getAPI(1);
      if (gitAPI) {
        isInstalled = true;
        const repos = gitAPI.repositories;
        const rootUriStr = rootFolder.uri.toString();
        const hasRepo = repos.some((r: any) => r.rootUri.toString() === rootUriStr);
        if (hasRepo) {
          isRepository = true;
        }
      }
    }
  } catch (err) {
    console.error("Git detection error:", err);
  }

  return {
    workspaceRoot,
    projectName,
    languages,
    git: {
      isRepository,
      isInstalled,
    },
  };
}

