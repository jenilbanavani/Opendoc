import * as vscode from "vscode";
import * as path from "path";

export interface LightweightFileMetadata {
  filename: string;
  imports: string[];
  exports: string[];
  functions: string[];
}

// Folders to ignore
const IGNORED_DIRS = new Set(["node_modules", "dist", "build", ".git", "venv", ".venv"]);

// File extensions to scan
const SOURCE_EXTENSIONS = new Set([
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

// Regex patterns
const importRegexes = [
  /^\s*(?:import|from)\s+([a-zA-Z0-9_\-\.]+)/, // Python / JS / TS
  /^\s*(?:const|let|var)\s+.*\s*=\s*require\(['"]([^'"]+)['"]\)/, // JS CommonJS
  /^\s*import\s+.*\s+from\s+['"]([^'"]+)['"]/, // JS ESM
  /^\s*using\s+([a-zA-Z0-9_\.]+);/, // C#
  /^\s*package\s+([a-zA-Z0-9_\.]+)/, // Java / Go
];

const exportRegexes = [
  /^\s*export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type)\s+([a-zA-Z0-9_]+)/, // JS/TS export
  /^\s*export\s+default\s+([a-zA-Z0-9_]+)/, // JS/TS export default
  /^\s*module\.exports\s*=\s*([a-zA-Z0-9_]+)/, // CommonJS module.exports
  /^\s*exports\.([a-zA-Z0-9_]+)\s*=/, // CommonJS exports.foo
  /def\s+([a-zA-Z0-9_]+)\s*\(/, // Python implicitly exported functions
  /class\s+([a-zA-Z0-9_]+)/, // Python implicitly exported classes
];

const functionRegexes = [
  /def\s+([a-zA-Z0-9_]+)\s*\(/, // Python function
  /function\s+([a-zA-Z0-9_]+)\s*\(/, // JS/TS function
  /const\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?\(.*\)\s*=>/, // JS/TS arrow function
  /fn\s+([a-zA-Z0-9_]+)\s*\(/, // Rust fn
  /func\s+([a-zA-Z0-9_]+)\s*\(/, // Go func
];

/**
 * Returns a priority score for a given file path.
 * Paths containing 'src', 'services', or 'routes' get higher priority.
 */
function getPriority(relPath: string): number {
  const normalized = relPath.toLowerCase().replace(/\\/g, "/");
  const parts = normalized.split("/");
  const isPrioritized = parts.some(
    (p) => p === "src" || p === "services" || p === "routes"
  );
  return isPrioritized ? 2 : 1;
}

/**
 * Parses file contents line-by-line to extract imports, exports, and functions.
 */
export function parseFileMetadata(content: string, filename: string): LightweightFileMetadata {
  const lines = content.split(/\r?\n/);
  const imports = new Set<string>();
  const exportsList = new Set<string>();
  const functions = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("*")
    ) {
      continue;
    }

    // Extract imports
    for (const rx of importRegexes) {
      const match = trimmed.match(rx);
      if (match && match[1]) {
        imports.add(match[1].trim());
        break;
      }
    }

    // Extract exports
    for (const rx of exportRegexes) {
      const match = trimmed.match(rx);
      if (match && match[1]) {
        if (filename.endsWith(".py") && match[1].startsWith("_")) {
          // Skip Python private/internal functions/classes starting with underscore
        } else {
          exportsList.add(match[1].trim());
        }
        break;
      }
    }

    // Extract functions
    for (const rx of functionRegexes) {
      const match = trimmed.match(rx);
      if (match && match[1]) {
        functions.add(match[1].trim());
        break;
      }
    }
  }

  return {
    filename: filename.replace(/\\/g, "/"),
    imports: Array.from(imports),
    exports: Array.from(exportsList),
    functions: Array.from(functions),
  };
}

/**
 * Scans the current workspace folder, filtering out ignored folders,
 * prioritizing src/services/routes, and extracting lightweight code metadata.
 */
export async function scanWorkspaceLightweight(
  rootUri: vscode.Uri
): Promise<LightweightFileMetadata[]> {
  const result: LightweightFileMetadata[] = [];
  const filesToScan: { uri: vscode.Uri; relPath: string; priority: number }[] = [];

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
        if (SOURCE_EXTENSIONS.has(cleanExt)) {
          const relPath = relPathPrefix ? `${relPathPrefix}/${name}` : name;
          filesToScan.push({
            uri: vscode.Uri.joinPath(dirUri, name),
            relPath,
            priority: getPriority(relPath),
          });
        }
      }
    }
  }

  await walk(rootUri, "");

  // Prioritize files: sort by priority score descending, then alphabetically by relative path
  filesToScan.sort((a, b) => b.priority - a.priority || a.relPath.localeCompare(b.relPath));

  // Process and extract metadata
  for (const file of filesToScan) {
    try {
      const raw = await vscode.workspace.fs.readFile(file.uri);
      const content = Buffer.from(raw).toString("utf-8");
      const metadata = parseFileMetadata(content, file.relPath);
      result.push(metadata);
    } catch {
      // Ignore unreadable files
    }
  }

  return result;
}
