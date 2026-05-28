import * as vscode from "vscode";
import * as path from "path";
import { scanWorkspaceLightweight, parseFileMetadata } from "./lightweightScanner";

export interface FileRelationship {
  file: string;
  talks_to: string[];
  importance_score: number;
}

/**
 * Resolves an import string to a local workspace file path, if possible.
 */
function resolveImportPath(
  sourceFile: string,
  importPath: string,
  allFiles: string[]
): string | null {
  // 1. Relative path imports (e.g., ./OpenDocViewProvider)
  if (importPath.startsWith(".") || importPath.startsWith("..")) {
    const sourceDir = path.dirname(sourceFile);
    // Resolve relative path and normalize backslashes to standard forward slashes
    const targetPath = path.join(sourceDir, importPath).replace(/\\/g, "/");

    const extensions = [
      "",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".go",
      ".rs",
      ".cs",
      ".java",
      ".rb",
      ".php",
      ".cpp",
      ".h",
      ".c",
    ];
    for (const ext of extensions) {
      const candidate = targetPath + ext;
      if (allFiles.includes(candidate)) {
        return candidate;
      }
    }
  }

  // 2. Python/Module-style dotted imports (e.g. services.db_service)
  const dottedPath = importPath.replace(/\./g, "/");
  const extensions = ["", ".py", ".ts", ".tsx", ".js", ".jsx"];
  for (const ext of extensions) {
    const candidateSuffix = dottedPath + ext;
    for (const f of allFiles) {
      if (f.endsWith(candidateSuffix)) {
        return f;
      }
    }
  }

  // 3. Basename imports (e.g. import "config")
  for (const f of allFiles) {
    const base = path.basename(f, path.extname(f));
    if (base === importPath) {
      return f;
    }
  }

  return null;
}

/**
 * Maps relationships between files, tracks exports/imports, and computes importance scores.
 */
export async function mapFileRelationships(
  rootUri: vscode.Uri
): Promise<FileRelationship[]> {
  // Step 1: Scan workspace to get lightweight file metadata
  const fileMetadataList = await scanWorkspaceLightweight(rootUri);
  const allFilePaths = fileMetadataList.map((meta) => meta.filename);

  // Step 2: Initialize maps for tracking links and inbound count (importance)
  const talksToMap = new Map<string, Set<string>>();
  const importanceScores = new Map<string, number>();

  for (const f of allFilePaths) {
    talksToMap.set(f, new Set<string>());
    importanceScores.set(f, 1); // Base score of 1 for every file
  }

  // Step 3: Resolve imports for each file and populate relationships
  for (const meta of fileMetadataList) {
    const sourceFile = meta.filename;
    const talksToSet = talksToMap.get(sourceFile)!;

    for (const imp of meta.imports) {
      const resolved = resolveImportPath(sourceFile, imp, allFilePaths);
      // Ensure we don't map a file to itself and that it exists in the workspace
      if (resolved && resolved !== sourceFile) {
        talksToSet.add(resolved);
      }
    }
  }

  // Step 4: Calculate importance scores based on inbound reference density
  // score = 1 (base) + (inbound_references * 10)
  for (const [sourceFile, targets] of talksToMap.entries()) {
    for (const target of targets) {
      const currentScore = importanceScores.get(target) || 1;
      importanceScores.set(target, currentScore + 10);
    }
  }

  // Step 5: Format the final sorted result array
  const result: FileRelationship[] = fileMetadataList.map((meta) => {
    const sourceFile = meta.filename;
    return {
      file: sourceFile,
      talks_to: Array.from(talksToMap.get(sourceFile)!).sort(),
      importance_score: importanceScores.get(sourceFile) || 1,
    };
  });

  // Sort by importance score descending, then by filename
  return result.sort((a, b) => b.importance_score - a.importance_score || a.file.localeCompare(b.file));
}
