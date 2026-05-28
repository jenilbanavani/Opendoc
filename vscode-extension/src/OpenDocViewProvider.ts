/**
 * OpenDoc — Sidebar Webview Provider
 *
 * Implements the sidebar panel that detects the workspace,
 * sends project context to the backend, and renders the AI report.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";
import { getWorkspaceTree, readKeyFiles, analyzeFileContent, detectWorkspaceMetadata } from "./utils/workspaceScanner";

export class OpenDocViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opendoc-sidebar";

  private _view?: vscode.WebviewView;
  private _sessionFiles = new Map<string, { uri: vscode.Uri; action: "opened" | "edited" }>();
  private _sessionId = "";
  private _currentGoal = "";
  private _snapshotTimeout?: NodeJS.Timeout;
  private _lastSnapshotJson = "";
  private _lastCapturedFiles = new Map<string, { imports: string[]; functions: string[] }>();

  constructor(private readonly _extensionUri: vscode.Uri) {
    // Generate unique session ID for version store
    this._sessionId = this._generateUUID();

    // Track files opened during the session
    vscode.workspace.onDidOpenTextDocument((doc) => {
      this._trackFile(doc.uri, "opened");
    });

    // Track files modified during the session
    vscode.workspace.onDidChangeTextDocument((e) => {
      this._trackFile(e.document.uri, "edited");
    });

    // Track when files are saved and check for major changes
    vscode.workspace.onDidSaveTextDocument((doc) => {
      this._onFileSave(doc);
    });
  }

  private _generateUUID(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private async _onFileSave(doc: vscode.TextDocument) {
    // Only track workspace files
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder || doc.uri.scheme !== "file") {
      return;
    }
    const relativePath = vscode.workspace.asRelativePath(doc.uri, false);
    
    // Ignore ignored files
    const parts = relativePath.split(/[\\/]/);
    const ignoredFolders = [
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
    ];

    if (parts.some((p) => ignoredFolders.includes(p))) {
      return;
    }

    try {
      const content = doc.getText();
      const currentSig = analyzeFileContent(content, relativePath);
      
      const lastSig = this._lastCapturedFiles.get(relativePath);
      let isMajorChange = false;
      if (!lastSig) {
        isMajorChange = true;
      } else {
        const importsChanged = JSON.stringify(currentSig.imports) !== JSON.stringify(lastSig.imports);
        const functionsChanged = JSON.stringify(currentSig.functions) !== JSON.stringify(lastSig.functions);
        if (importsChanged || functionsChanged) {
          isMajorChange = true;
        }
      }

      if (isMajorChange) {
        // Update signature cache and tracking state
        this._lastCapturedFiles.set(relativePath, currentSig);
        this._sessionFiles.set(relativePath, { uri: doc.uri, action: "edited" });

        if (this._snapshotTimeout) {
          clearTimeout(this._snapshotTimeout);
        }
        this._snapshotTimeout = setTimeout(() => {
          this._sendSessionState();
        }, 3000); // 3 seconds debounce
      }
    } catch (err) {
      console.error("Error evaluating file save triggers:", err);
    }
  }

  private async _sendSessionState(force = false): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    const editedFiles: { filename: string; functions: string[]; imports: string[]; hash?: string }[] = [];

    for (const [relativePath, entry] of this._sessionFiles.entries()) {
      if (entry.action !== "edited" && !force) {
        continue;
      }
      try {
        const raw = await vscode.workspace.fs.readFile(entry.uri);
        const content = Buffer.from(raw).toString("utf-8");
        const { functions, imports } = analyzeFileContent(content, relativePath);
        const hash = crypto.createHash("sha1").update(content).digest("hex");
        editedFiles.push({
          filename: relativePath,
          functions: functions,
          imports: imports,
          hash: hash,
        });

        // Seed signature cache
        this._lastCapturedFiles.set(relativePath, { functions, imports });
      } catch {
        // If file is deleted or unreadable
        editedFiles.push({
          filename: relativePath,
          functions: [],
          imports: [],
        });
      }
    }

    if (editedFiles.length === 0 && !force) {
      return; // Nothing edited yet and not forced
    }

    const config = vscode.workspace.getConfiguration("opendoc");
    const apiKey = config.get<string>("apiKey", "");
    const backendUrl = config.get<string>("backendUrl", "http://localhost:8000");
    const provider = config.get<string>("provider", "groq");
    const model = config.get<string>("model", "");

    const sessionStatePayload = {
      session_id: this._sessionId,
      timestamp: new Date().toISOString(),
      goal: this._currentGoal,
      files: editedFiles,
      provider: provider,
      model: model || undefined,
      api_key: apiKey || undefined,
    };

    // Deduplicate sends
    const currentJson = JSON.stringify({
      goal: sessionStatePayload.goal,
      files: sessionStatePayload.files,
    });

    if (currentJson === this._lastSnapshotJson && !force) {
      return;
    }

    this._lastSnapshotJson = currentJson;

    try {
      const url = `${backendUrl.replace(/\/+$/, "")}/api/session/state`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sessionStatePayload),
      });

      if (response.ok) {
        const data = (await response.json()) as {
          success?: boolean;
          new_note?: string;
          error?: string;
        };
        if (data.success) {
          // Fetch notes history to refresh the UI
          await this._fetchNotesHistory();
        }
      }
    } catch (err) {
      console.error("Failed to send session state to backend:", err);
    }
  }

  private async _fetchNotesHistory(): Promise<void> {
    const config = vscode.workspace.getConfiguration("opendoc");
    const backendUrl = config.get<string>("backendUrl", "http://localhost:8000");

    try {
      const url = `${backendUrl.replace(/\/+$/, "")}/api/session/notes?session_id=${this._sessionId}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = (await response.json()) as {
          success?: boolean;
          notes?: any[];
        };
        if (data.success && data.notes) {
          this._postMessage({ command: "notesHistory", notes: data.notes });
        }
      }
    } catch (err) {
      console.error("Failed to fetch notes history:", err);
    }
  }

  private async _sendWorkspaceMetadata(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }
    const rootFolder = workspaceFolders[0];
    
    // 1. Get workspace metadata
    const metadata = await detectWorkspaceMetadata();
    
    // 2. Get top 3-4 files in the workspace
    const filesList: { name: string; role: string }[] = [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(rootFolder.uri);
      const ignored = new Set(["node_modules", "dist", "build", ".git", "venv", ".venv"]);
      const sourceExts = new Set([".py", ".ts", ".tsx", ".js", ".jsx"]);
      
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File) {
          const ext = path.extname(name).toLowerCase();
          if (sourceExts.has(ext) || name === "package.json" || name === "requirements.txt") {
            let role = "config";
            if (name === "main.py" || name === "index.ts" || name === "app.py") role = "entrypoint";
            else if (name.includes("service")) role = "service";
            else if (name.includes("route") || name.includes("controller")) role = "router";
            filesList.push({ name, role });
          }
        } else if (type === vscode.FileType.Directory && !ignored.has(name) && !name.startsWith(".")) {
          const subUri = vscode.Uri.joinPath(rootFolder.uri, name);
          const subEntries = await vscode.workspace.fs.readDirectory(subUri);
          for (const [sName, sType] of subEntries) {
            if (sType === vscode.FileType.File) {
              const ext = path.extname(sName).toLowerCase();
              if (sourceExts.has(ext)) {
                let role = "source";
                if (sName.includes("service")) role = "service";
                else if (sName.includes("route") || sName.includes("controller")) role = "router";
                else if (sName.includes("schema") || sName.includes("model")) role = "model";
                filesList.push({ name: `${name}/${sName}`, role });
              }
            }
          }
        }
      }
    } catch {
      // Ignore
    }

    // Sort files list so that entrypoints/routers are first
    const rolePriority: Record<string, number> = { entrypoint: 1, router: 2, service: 3, model: 4, source: 5, config: 6 };
    filesList.sort((a, b) => (rolePriority[a.role] || 10) - (rolePriority[b.role] || 10));

    const totalFilesCount = filesList.length;
    const displayFiles = filesList.slice(0, 3);
    const extraCount = totalFilesCount - displayFiles.length;

    const focusAreas: string[] = [];
    if (metadata?.languages.includes("Python")) {
      focusAreas.push("FastAPI", "Python 3");
    }
    if (metadata?.languages.includes("TypeScript") || metadata?.languages.includes("JavaScript")) {
      focusAreas.push("TypeScript", "Node.js");
    }
    focusAreas.push("LLM routing", "PDF export", "Pydantic schemas");
    if (metadata?.git.isRepository) {
      focusAreas.push("Git versioning");
    }

    this._postMessage({
      command: "workspaceMetadata",
      projectName: metadata?.projectName || rootFolder.name,
      workspaceRoot: metadata?.workspaceRoot || rootFolder.uri.fsPath,
      languages: metadata?.languages || [],
      gitAvailable: metadata?.git.isRepository || false,
      files: displayFiles,
      extraCount: extraCount,
      focusAreas: focusAreas
    });
  }

  private _trackFile(uri: vscode.Uri, action: "opened" | "edited") {
    // Only track workspace files
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return;
    }

    // Ignore non-file schemes (e.g. git, output, status)
    if (uri.scheme !== "file") {
      return;
    }

    const relativePath = vscode.workspace.asRelativePath(uri, false);

    // Ignore build/metadata/git/dependencies folders
    const parts = relativePath.split(/[\\/]/);
    const ignoredFolders = [
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
    ];

    if (parts.some((p) => ignoredFolders.includes(p))) {
      return;
    }

    // Retain "edited" status if already tracked as edited
    const existing = this._sessionFiles.get(relativePath);
    if (existing && existing.action === "edited") {
      return;
    }

    this._sessionFiles.set(relativePath, { uri, action });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "analyze":
          await this._handleAnalyze(message.reportMode, message.customSections);
          break;
        case "generateDevNotes":
          await this._handleGenerateDevNotes();
          break;
        case "openSettings":
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "opendoc"
          );
          break;
        case "savePdf":
          await this._handleSavePdf(message.report);
          break;
        case "saveMarkdown":
          await this._handleSaveMarkdown(message.report);
          break;
        case "updateGoal":
          this._currentGoal = message.goal;
          break;
        case "refreshNotes":
          await this._fetchNotesHistory();
          break;
        case "getWorkspaceMetadata":
          await this._sendWorkspaceMetadata();
          break;
        case "recordSessionState":
          await this._sendSessionState(true);
          vscode.window.showInformationMessage("Session evolution state captured.");
          break;
        case "newSession":
          this._sessionId = this._generateUUID();
          this._sessionFiles.clear();
          this._lastCapturedFiles.clear();
          this._lastSnapshotJson = "";
          this._currentGoal = "";
          this._postMessage({ command: "clearGoal" });
          await this._fetchNotesHistory();
          vscode.window.showInformationMessage("Started a new OpenDoc evolution tracking session.");
          break;
      }
    });
  }

  /**
   * Main analysis flow:
   * 1. Read workspace files
   * 2. Send to backend /api/analyze-local
   * 3. Post report back to webview
   */
  private async _handleAnalyze(
    reportMode: string = "client",
    customSections?: string[]
  ): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this._postMessage({ command: "error", text: "No workspace folder open." });
      return;
    }

    const config = vscode.workspace.getConfiguration("opendoc");
    const apiKey = config.get<string>("apiKey", "");
    const backendUrl = config.get<string>("backendUrl", "http://localhost:8000");
    const provider = config.get<string>("provider", "groq");

    if (!apiKey) {
      this._postMessage({
        command: "error",
        text: 'No API key configured. Click the ⚙️ icon to set your API key in Settings.',
      });
      return;
    }

    const rootFolder = workspaceFolders[0];
    const projectName = rootFolder.name;

    this._postMessage({ command: "loading", text: "Scanning workspace..." });

    try {
      // Step 1: Scan workspace
      const folderStructure = await getWorkspaceTree(rootFolder.uri);
      const files = await readKeyFiles(rootFolder.uri);

      this._postMessage({ command: "loading", text: "Analyzing with AI..." });

      // Step 2: Send to backend
      const url = `${backendUrl.replace(/\/+$/, "")}/api/analyze-local`;
      const body = JSON.stringify({
        project_name: projectName,
        folder_structure: folderStructure,
        files: files,
        provider: provider,
        api_key: apiKey,
        report_mode: reportMode,
        custom_sections: customSections || null,
      });

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => null)) as {
          detail?: string;
        } | null;
        const detail =
          errorData?.detail || `Backend returned ${response.status}`;
        this._postMessage({ command: "error", text: detail });
        return;
      }

      const data = (await response.json()) as {
        success?: boolean;
        report?: Record<string, unknown>;
        error?: string;
      };

      if (!data.success || !data.report) {
        this._postMessage({
          command: "error",
          text: data.error || "Analysis failed — no report returned.",
        });
        return;
      }

      // Step 3: Send report to webview
      this._postMessage({ command: "report", report: data.report });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error occurred";
      this._postMessage({
        command: "error",
        text: `Connection failed: ${message}. Is the backend running?`,
      });
    }
  }

  private async _handleGenerateDevNotes(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      this._postMessage({ command: "error", text: "No workspace folder open." });
      return;
    }

    const config = vscode.workspace.getConfiguration("opendoc");
    const apiKey = config.get<string>("apiKey", "");
    const backendUrl = config.get<string>("backendUrl", "http://localhost:8000");
    const provider = config.get<string>("provider", "groq");

    if (!apiKey) {
      this._postMessage({
        command: "error",
        text: 'No API key configured. Click the ⚙️ icon to set your API key in Settings.',
      });
      return;
    }

    // Force send any outstanding state changes to the database first
    await this._sendSessionState(true);

    if (this._sessionFiles.size === 0) {
      this._postMessage({
        command: "error",
        text: "No session activity tracked yet. Open or edit some files to generate dev notes.",
      });
      return;
    }

    const rootFolder = workspaceFolders[0];
    const projectName = rootFolder.name;

    this._postMessage({ command: "loading", text: "Analyzing session changes..." });

    try {
      const trackedFilesPayload = [];

      for (const [relativePath, entry] of this._sessionFiles.entries()) {
        try {
          const raw = await vscode.workspace.fs.readFile(entry.uri);
          const content = Buffer.from(raw).toString("utf-8");
          const { imports, functions } = analyzeFileContent(content, relativePath);
          trackedFilesPayload.push({
            filename: relativePath,
            imports: imports,
            functions: functions,
            action: entry.action,
          });
        } catch {
          // If file is deleted or unreadable, still track basic path
          trackedFilesPayload.push({
            filename: relativePath,
            imports: [],
            functions: [],
            action: entry.action,
          });
        }
      }

      this._postMessage({ command: "loading", text: "Generating development notes..." });

      const url = `${backendUrl.replace(/\/+$/, "")}/api/generate-dev-notes`;
      const body = JSON.stringify({
        project_name: projectName,
        tracked_files: trackedFilesPayload,
        provider: provider,
        api_key: apiKey,
      });

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => null)) as {
          detail?: string;
        } | null;
        const detail =
          errorData?.detail || `Backend returned ${response.status}`;
        this._postMessage({ command: "error", text: detail });
        return;
      }

      const data = (await response.json()) as {
        success?: boolean;
        dev_notes?: Record<string, unknown>;
        error?: string;
      };

      if (!data.success || !data.dev_notes) {
        this._postMessage({
          command: "error",
          text: data.error || "Failed to generate development notes.",
        });
        return;
      }

      this._postMessage({ command: "devNotes", devNotes: data.dev_notes });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error occurred";
      this._postMessage({
        command: "error",
        text: `Connection failed: ${message}. Is the backend running?`,
      });
    }
  }

  private async _handleSaveMarkdown(report: any): Promise<void> {
    const markdown = this._jsonToMarkdown(report);
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${(report.repo_name || "opendoc").replace(/[\\/]/g, "_")}_report.md`),
      filters: { Markdown: ["md"] },
    });

    if (uri) {
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(markdown, "utf-8"));
        vscode.window.showInformationMessage(`Markdown report saved to ${uri.fsPath}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to save Markdown: ${err.message}`);
      }
    }
  }

  private async _handleSavePdf(report: any): Promise<void> {
    const config = vscode.workspace.getConfiguration("opendoc");
    const backendUrl = config.get<string>("backendUrl", "http://localhost:8000");
    const url = `${backendUrl.replace(/\/+$/, "")}/api/generate-pdf`;

    this._postMessage({ command: "loading", text: "Exporting PDF..." });

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report: report }),
      });

      this._postMessage({ command: "loading", text: "" }); // Clear loading

      if (!response.ok) {
        throw new Error(`Backend returned ${response.status}`);
      }

      const buffer = await response.arrayBuffer();
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${(report.repo_name || "opendoc").replace(/[\\/]/g, "_")}_report.pdf`),
        filters: { PDF: ["pdf"] },
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, new Uint8Array(buffer));
        vscode.window.showInformationMessage(`PDF report saved to ${uri.fsPath}`);
      }
    } catch (err: any) {
      this._postMessage({ command: "loading", text: "" }); // Clear loading
      vscode.window.showErrorMessage(`Failed to export PDF: ${err.message}`);
    }
  }

  private _jsonToMarkdown(r: any): string {
    let md = `# OpenDoc Analysis Report: ${r.repo_name || "Project"}\n\n`;
    if (r.executive_summary) md += `## Executive Summary\n${r.executive_summary}\n\n`;
    if (r.what_it_actually_is) md += `## What It Actually Is\n${r.what_it_actually_is}\n\n`;

    if (r.project_maturity) md += `**Project Maturity**: ${r.project_maturity}\n\n`;
    if (r.scope_vs_execution) md += `**Scope vs Execution**: ${r.scope_vs_execution}\n\n`;

    if (r.core_strengths && r.core_strengths.length) {
      md += `## Core Strengths\n`;
      r.core_strengths.forEach((s: string) => md += `- ${s}\n`);
      md += `\n`;
    }

    if (r.biggest_risks && r.biggest_risks.length) {
      md += `## Weaknesses & Risks\n`;
      r.biggest_risks.forEach((s: string) => md += `- ${s}\n`);
      md += `\n`;
    }

    if (r.engineering_assessment) md += `## Engineering Assessment\n${r.engineering_assessment}\n\n`;

    if (r.architecture_observations && r.architecture_observations.length) {
      md += `## Architecture Observations\n`;
      r.architecture_observations.forEach((s: string) => md += `- ${s}\n`);
      md += `\n`;
    }

    if (r.engineering_patterns && r.engineering_patterns.length) {
      md += `## Detected Engineering Patterns\n`;
      r.engineering_patterns.forEach((s: string) => md += `- ${s}\n`);
      md += `\n`;
    }

    if (r.repeated_concepts && r.repeated_concepts.length) {
      md += `## Concept Repetition / Duplication\n`;
      r.repeated_concepts.forEach((s: string) => md += `- ${s}\n`);
      md += `\n`;
    }

    if (r.learning_areas && r.learning_areas.length) {
      md += `## Learning Focus Areas\n`;
      r.learning_areas.forEach((s: string) => md += `- ${s}\n`);
      md += `\n`;
    }

    if (r.product_direction) {
      md += `## Technical Direction & Product Strategy\n`;
      const pd = r.product_direction;
      if (pd.strongest_direction) md += `* **Strongest Direction**: ${pd.strongest_direction}\n`;
      if (pd.highest_impact_next_step) md += `* **Highest Impact Next Step**: ${pd.highest_impact_next_step}\n`;
      if (pd.biggest_technical_risk) md += `* **Biggest Technical Risk**: ${pd.biggest_technical_risk}\n`;
      if (pd.most_impressive_aspect) md += `* **Most Impressive Aspect**: ${pd.most_impressive_aspect}\n`;
      if (pd.most_underrated_feature) md += `* **Most Underrated Feature**: ${pd.most_underrated_feature}\n`;
      md += `\n`;
    }

    if (r.recommended_next_step) md += `## Recommended Next Step\n${r.recommended_next_step}\n\n`;
    if (r.portfolio_assessment) md += `## Portfolio & Resume Assessment\n${r.portfolio_assessment}\n\n`;
    if (r.developer_intelligence) md += `## Developer Intelligence Insights\n${r.developer_intelligence}\n\n`;
    if (r.final_verdict) md += `## Final Verdict\n${r.final_verdict}\n\n`;

    return md;
  }

  private _postMessage(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  private _getHtmlForWebview(): string {
    const workspaceName =
      vscode.workspace.workspaceFolders?.[0]?.name || "No workspace";

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>OpenDoc</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css">
<style>
  /* ── Sidebar Theme ── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    color: #ccc;
    background: #1e1e1e;
    overflow-x: hidden;
  }

  .sidebar {
    background: #1e1e1e;
    color: #ccc;
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  .sidebar-header {
    background: #252526;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid #333;
    flex-shrink: 0;
  }

  .sidebar-header span {
    font-size: 11px;
    font-weight: 600;
    color: #ccc;
    letter-spacing: .04em;
    text-transform: uppercase;
  }

  .sidebar-body {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow-y: auto;
    flex: 1;
  }

  .section-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: .06em;
    color: #858585;
    margin-bottom: 6px;
    font-weight: 700;
  }

  .report-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .report-card {
    background: #2d2d2d;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    padding: 10px;
    cursor: pointer;
    transition: all .2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .report-card:hover {
    border-color: #555;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }

  .report-card.selected {
    border-color: #7c5cbf;
    background: #2a2040;
    box-shadow: 0 4px 12px rgba(124, 92, 191, 0.15);
  }

  .report-card .rc-icon {
    font-size: 18px;
    margin-bottom: 6px;
    color: #888;
  }

  .report-card.selected .rc-icon {
    color: #a78bfa;
  }

  .report-card .rc-title {
    font-size: 12px;
    font-weight: 600;
    color: #ddd;
  }

  .report-card.selected .rc-title {
    color: #c4b5fd;
  }

  .report-card .rc-desc {
    font-size: 10px;
    color: #777;
    margin-top: 4px;
    line-height: 1.4;
  }

  .report-card.selected .rc-desc {
    color: #9d91db;
  }

  .file-list {
    background: #252526;
    border-radius: 8px;
    border: 1px solid #333;
    overflow: hidden;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid #2a2a2a;
    transition: background-color 0.2s;
  }
  
  .file-row:hover {
    background: rgba(255,255,255,0.02);
  }

  .file-row:last-child {
    border-bottom: none;
  }

  .file-row .file-icon {
    font-size: 14px;
    color: #569cd6;
  }

  .file-row .file-name {
    font-size: 12px;
    color: #9cdcfe;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-row .file-role {
    font-size: 9px;
    color: #4ec9b0;
    background: #1e3330;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
  }

  .badge-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .badge {
    font-size: 10px;
    padding: 3px 8px;
    border-radius: 12px;
    font-weight: 500;
  }

  .badge-purple { background: #2a2040; color: #a78bfa; border: 1px solid #4c3880; }
  .badge-teal { background: #1a2e2a; color: #4ec9b0; border: 1px solid #2a4a44; }
  .badge-amber { background: #2a2010; color: #ce9178; border: 1px solid #4a3820; }
  .badge-lang { background: #1a2e2a; color: #4ec9b0; border: 1px solid #2a4a44; }
  .badge-files { background: #2a2010; color: #ce9178; border: 1px solid #4a3820; }
  .badge-duration { background: #1c2536; color: #569cd6; border: 1px solid #2b3c5a; }
  .badge-focus { background: #2a2040; color: #a78bfa; border: 1px solid #4c3880; }
  .badge-pattern { background: #2d2d2d; color: #bbb; border: 1px solid #3d3d3d; }

  /* ── Action Buttons ── */
  .gen-btn {
    background: #7c5cbf;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 12px;
    font-weight: 600;
    width: 100%;
    cursor: pointer;
    letter-spacing: .02em;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    box-shadow: 0 4px 10px rgba(124, 92, 191, 0.2);
  }

  .gen-btn:hover {
    background: #6a4daa;
    transform: translateY(-1px);
    box-shadow: 0 6px 14px rgba(124, 92, 191, 0.3);
  }
  
  .gen-btn:active {
    transform: translateY(0);
  }

  .gen-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none !important;
    box-shadow: none !important;
  }

  .secondary-btn {
    background: #2d2d2d;
    color: #ccc;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .secondary-btn:hover {
    background: #353535;
    border-color: #4a4a4a;
    color: #fff;
  }

  .secondary-btn:active {
    transform: scale(0.98);
  }

  .secondary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Depth Selector ── */
  .depth-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .depth-row label {
    font-size: 11px;
    color: #888;
    flex: 1;
    font-weight: 600;
  }

  .toggle {
    display: flex;
    background: #2d2d2d;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    overflow: hidden;
  }

  .toggle span {
    font-size: 10px;
    padding: 5px 12px;
    cursor: pointer;
    color: #777;
    transition: all 0.2s;
    font-weight: 600;
    user-select: none;
  }

  .toggle span:hover {
    color: #ccc;
  }

  .toggle span.on {
    background: #3a2d5c;
    color: #a78bfa;
  }

  .divider {
    border: none;
    border-top: 1px solid #2d2d2d;
    margin: 4px 0;
  }

  /* ── Input ── */
  .goal-input {
    width: 100%;
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid #3a3a3a;
    background: #252526;
    color: #ccc;
    font-family: inherit;
    font-size: 12px;
    outline: none;
    transition: all 0.2s;
  }

  .goal-input:focus {
    border-color: #7c5cbf;
    box-shadow: 0 0 0 1px rgba(124, 92, 191, 0.4);
  }

  /* ── Header Badge ── */
  .workspace-badge {
    font-size: 10px;
    font-weight: 600;
    color: #858585;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #1e1e1e;
    border: 1px solid #333;
    padding: 3px 8px;
    border-radius: 20px;
  }

  .workspace-badge .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 6px #10b981;
  }

  /* ── Settings icon ── */
  .settings-btn {
    background: none;
    border: none;
    color: #858585;
    cursor: pointer;
    font-size: 14px;
    padding: 4px;
    border-radius: 4px;
    transition: all 0.2s;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .settings-btn:hover {
    color: #fff;
    background: #2d2d2d;
  }

  /* ── Status Area ── */
  .status {
    padding: 4px 0;
  }

  .status-msg {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 500;
    padding: 8px 12px;
    border-radius: 6px;
  }

  .status-msg.loading {
    color: #3b82f6;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
  }

  .status-msg.error {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Report Card output ── */
  .report {
    background: #252526;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 12px;
    margin-top: 10px;
    animation: fadeIn 0.3s ease;
  }

  .report-header {
    font-size: 13px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 12px;
    padding-bottom: 6px;
    border-bottom: 1px solid #2d2d2d;
  }

  .report-section {
    margin-bottom: 8px;
    border-radius: 6px;
    border: 1px solid #3a3a3a;
    background: #2d2d2d;
    overflow: hidden;
  }

  .section-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border: none;
    cursor: pointer;
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    background: transparent;
    color: #ddd;
    transition: background 0.2s;
  }

  .section-toggle:hover {
    background: rgba(255,255,255,0.02);
  }

  .section-toggle .chevron {
    font-size: 8px;
    transition: transform 0.2s ease;
    opacity: 0.5;
  }

  .section-toggle.open .chevron {
    transform: rotate(90deg);
  }

  .section-content {
    display: none;
    padding: 10px 12px;
    font-size: 11px;
    line-height: 1.5;
    color: #b5b5b5;
    border-top: 1px solid #252526;
  }

  .section-content.open {
    display: block;
  }

  .section-content ul {
    padding-left: 16px;
    margin: 4px 0;
  }

  .section-content li {
    margin-bottom: 4px;
  }
  
  .sub-field {
    margin-bottom: 10px;
  }
  
  .sub-field-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #858585;
    margin-bottom: 2px;
  }

  /* ── Export actions ── */
  .export-panel {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .export-btn {
    flex: 1;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid #3a3a3a;
    background: #2d2d2d;
    color: #ccc;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .export-btn:hover {
    background: #353535;
    color: #fff;
  }

  /* ── Evolution History ── */
  .history-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 250px;
    overflow-y: auto;
  }

  .history-item {
    background: #252526;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 10px;
    transition: all 0.2s;
  }

  .history-item:hover {
    border-color: #444;
  }

  .history-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  .history-item-time {
    font-size: 9px;
    font-weight: 700;
    color: #a78bfa;
    background: rgba(167, 139, 250, 0.1);
    padding: 2px 6px;
    border-radius: 10px;
  }

  .history-item-goal {
    font-size: 9px;
    font-weight: 600;
    color: #858585;
    background: #1e1e1e;
    padding: 2px 6px;
    border-radius: 10px;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .history-item-summary {
    font-size: 11px;
    color: #ccc;
    line-height: 1.4;
  }

  .history-empty {
    font-size: 11px;
    color: #666;
    text-align: center;
    padding: 16px;
    border: 1px dashed #333;
    border-radius: 8px;
  }

  .history-item-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }

  .history-item-details {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed #2d2d2d;
    font-size: 9px;
    color: #858585;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .hidden { display: none !important; }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: #333;
    border-radius: 3px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: #444;
  }
</style>
</head>
<body>

<div class="sidebar">
  <!-- Header -->
  <div class="sidebar-header">
    <i class="ti ti-brain" style="font-size:15px; color:#a78bfa"></i>
    <span>OpenDoc</span>
    <div class="workspace-badge" style="margin-left: 8px;">
      <span class="dot"></span>
      <span id="workspaceName">${this._escapeHtml(workspaceName)}</span>
    </div>
    <div style="display: flex; gap: 4px; margin-left: auto;">
      <button class="settings-btn" id="newSessionBtn" title="Start New Session"><i class="ti ti-rotate"></i></button>
      <button class="settings-btn" id="settingsBtn" title="Settings"><i class="ti ti-settings"></i></button>
    </div>
  </div>

  <!-- Body -->
  <div class="sidebar-body">
    <!-- Select report type -->
    <div>
      <div class="section-label">Select report type</div>
      <div class="report-grid">
        <div class="report-card selected" id="rc-learn" data-mode="learning">
          <div class="rc-icon"><i class="ti ti-school"></i></div>
          <div class="rc-title">Learning</div>
          <div class="rc-desc">Understand what each file does &amp; why</div>
        </div>
        <div class="report-card" id="rc-client" data-mode="client">
          <div class="rc-icon"><i class="ti ti-briefcase"></i></div>
          <div class="rc-title">Client</div>
          <div class="rc-desc">Non-technical overview for stakeholders</div>
        </div>
        <div class="report-card" id="rc-overview" data-mode="overview">
          <div class="rc-icon"><i class="ti ti-layout-grid"></i></div>
          <div class="rc-title">Overview</div>
          <div class="rc-desc">Quick snapshot of structure &amp; stack</div>
        </div>
        <div class="report-card" id="rc-arch" data-mode="architecture">
          <div class="rc-icon"><i class="ti ti-sitemap"></i></div>
          <div class="rc-title">Architecture</div>
          <div class="rc-desc">Patterns, decisions, trade-offs</div>
        </div>
      </div>
    </div>

    <!-- Current Goal -->
    <div>
      <div class="section-label">Current Goal</div>
      <input type="text" id="currentGoal" class="goal-input" placeholder="e.g. Add authentication middleware">
    </div>

    <hr class="divider">

    <!-- Files in scope -->
    <div>
      <div class="section-label">Files in scope</div>
      <div class="file-list" id="filesScopeList">
        <div class="file-row" style="opacity: 0.5; padding: 12px; justify-content: center;">
          <span style="font-size: 11px;">Scanning workspace...</span>
        </div>
      </div>
    </div>

    <!-- Explanation Depth -->
    <div class="depth-row">
      <label>Explanation depth</label>
      <div class="toggle" id="depthToggle">
        <span data-depth="Brief">Brief</span>
        <span class="on" data-depth="Detailed">Detailed</span>
        <span data-depth="Expert">Expert</span>
      </div>
    </div>

    <!-- Detected focus areas -->
    <div>
      <div class="section-label">Detected focus areas</div>
      <div class="badge-row" id="focusAreasList">
        <span class="badge badge-purple">Detecting...</span>
      </div>
    </div>

    <!-- Main actions -->
    <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px;">
      <button class="gen-btn" id="analyzeBtn">⚡ Generate learning report</button>
      <div style="display: flex; gap: 6px;">
        <button class="secondary-btn" id="devNotesBtn" style="flex: 1;"><i class="ti ti-notes"></i> Dev Notes</button>
        <button class="secondary-btn" id="recordStateBtn" style="flex: 1;"><i class="ti ti-device-floppy"></i> Capture State</button>
      </div>
    </div>

    <!-- Status loading/error -->
    <div class="status hidden" id="statusArea">
      <div class="status-msg" id="statusMsg"></div>
    </div>

    <!-- Report Output Area -->
    <div class="report hidden" id="reportArea"></div>

    <!-- Export Actions Panel -->
    <div class="export-panel hidden" id="exportPanel">
      <button class="export-btn" id="savePdfBtn"><i class="ti ti-file-type-pdf"></i> Save PDF</button>
      <button class="export-btn" id="saveMDBtn"><i class="ti ti-markdown"></i> Save Markdown</button>
    </div>

    <!-- Session Evolution History -->
    <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px; border-top: 1px solid #2d2d2d; padding-top: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span class="section-label" style="margin-bottom: 0;">Session Evolution History</span>
        <button class="settings-btn" id="refreshNotesBtn" title="Refresh Notes" style="font-size: 12px; padding: 2px;"><i class="ti ti-refresh"></i></button>
      </div>
      <div id="notesHistoryList" class="history-list">
        <div class="history-empty">No evolution states recorded yet. Save changes to trigger an update.</div>
      </div>
    </div>

  </div>
</div>

<script>
(function() {
  const vscode = acquireVsCodeApi();
  const analyzeBtn = document.getElementById('analyzeBtn');
  const devNotesBtn = document.getElementById('devNotesBtn');
  const recordStateBtn = document.getElementById('recordStateBtn');
  const newSessionBtn = document.getElementById('newSessionBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const statusArea = document.getElementById('statusArea');
  const statusMsg = document.getElementById('statusMsg');
  const reportArea = document.getElementById('reportArea');
  const exportPanel = document.getElementById('exportPanel');
  const savePdfBtn = document.getElementById('savePdfBtn');
  const saveMDBtn = document.getElementById('saveMDBtn');
  const currentGoalInput = document.getElementById('currentGoal');
  const refreshNotesBtn = document.getElementById('refreshNotesBtn');
  const notesHistoryList = document.getElementById('notesHistoryList');
  const filesScopeList = document.getElementById('filesScopeList');
  const focusAreasList = document.getElementById('focusAreasList');
  const depthToggle = document.getElementById('depthToggle');

  let currentReport = null;
  let selectedReportMode = 'learning';
  let selectedDepth = 'Detailed';

  // Toggle report type selection
  ['rc-learn', 'rc-client', 'rc-overview', 'rc-arch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', () => {
        document.querySelectorAll('.report-card').forEach(c => c.classList.remove('selected'));
        el.classList.add('selected');
        
        selectedReportMode = el.getAttribute('data-mode');
        const titles = {
          'rc-learn': 'learning',
          'rc-client': 'client',
          'rc-overview': 'overview',
          'rc-arch': 'architecture'
        };
        analyzeBtn.innerHTML = '⚡ Generate ' + titles[id] + ' report';
      });
    }
  });

  // Toggle explanation depth
  depthToggle.querySelectorAll('span').forEach(span => {
    span.addEventListener('click', () => {
      depthToggle.querySelectorAll('span').forEach(s => s.classList.remove('on'));
      span.classList.add('on');
      selectedDepth = span.getAttribute('data-depth');
    });
  });

  analyzeBtn.addEventListener('click', () => {
    vscode.postMessage({
      command: 'analyze',
      reportMode: selectedReportMode,
      explanationDepth: selectedDepth,
      customSections: []
    });

    analyzeBtn.disabled = true;
    devNotesBtn.disabled = true;
    recordStateBtn.disabled = true;
    reportArea.classList.add('hidden');
    exportPanel.classList.add('hidden');
  });

  devNotesBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'generateDevNotes' });
    analyzeBtn.disabled = true;
    devNotesBtn.disabled = true;
    recordStateBtn.disabled = true;
    reportArea.classList.add('hidden');
    exportPanel.classList.add('hidden');
  });

  recordStateBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'recordSessionState' });
    analyzeBtn.disabled = true;
    devNotesBtn.disabled = true;
    recordStateBtn.disabled = true;
  });

  newSessionBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'newSession' });
  });

  settingsBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'openSettings' });
  });

  savePdfBtn.addEventListener('click', () => {
    if (currentReport) {
      vscode.postMessage({ command: 'savePdf', report: currentReport });
    }
  });

  saveMDBtn.addEventListener('click', () => {
    if (currentReport) {
      vscode.postMessage({ command: 'saveMarkdown', report: currentReport });
    }
  });

  currentGoalInput.addEventListener('input', () => {
    vscode.postMessage({
      command: 'updateGoal',
      goal: currentGoalInput.value
    });
  });

  refreshNotesBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'refreshNotes' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.command) {
      case 'loading':
        statusArea.classList.remove('hidden');
        if (msg.text) {
          statusMsg.className = 'status-msg loading';
          statusMsg.innerHTML = '<div class="spinner"></div><span>' + escapeHtml(msg.text) + '</span>';
        } else {
          statusArea.classList.add('hidden');
        }
        break;

      case 'error':
        statusArea.classList.remove('hidden');
        statusMsg.className = 'status-msg error';
        statusMsg.innerHTML = '⚠️ ' + escapeHtml(msg.text);
        analyzeBtn.disabled = false;
        devNotesBtn.disabled = false;
        recordStateBtn.disabled = false;
        break;

      case 'report':
        statusArea.classList.add('hidden');
        analyzeBtn.disabled = false;
        devNotesBtn.disabled = false;
        recordStateBtn.disabled = false;
        currentReport = msg.report;
        renderReport(msg.report);
        exportPanel.classList.remove('hidden');
        break;

      case 'devNotes':
        statusArea.classList.add('hidden');
        analyzeBtn.disabled = false;
        devNotesBtn.disabled = false;
        recordStateBtn.disabled = false;
        renderDevNotes(msg.devNotes);
        break;

      case 'notesHistory':
        analyzeBtn.disabled = false;
        devNotesBtn.disabled = false;
        recordStateBtn.disabled = false;
        renderNotesHistory(msg.notes);
        break;

      case 'clearGoal':
        currentGoalInput.value = '';
        break;

      case 'workspaceMetadata':
        updateWorkspaceMetadata(msg);
        break;
    }
  });

  function updateWorkspaceMetadata(data) {
    if (data.projectName) {
      document.getElementById('workspaceName').textContent = data.projectName;
    }
    
    // Render Files in Scope
    if (data.files && data.files.length > 0) {
      let filesHtml = data.files.map(f => {
        return '<div class="file-row">'
          + '<i class="ti ti-file-code file-icon"></i>'
          + '<span class="file-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>'
          + '<span class="file-role">' + escapeHtml(f.role) + '</span>'
          + '</div>';
      }).join('');

      if (data.extraCount > 0) {
        filesHtml += '<div class="file-row" style="opacity: 0.5;">'
          + '<i class="ti ti-dots file-icon" style="color: #555;"></i>'
          + '<span class="file-name" style="color: #666;">+' + data.extraCount + ' more files</span>'
          + '</div>';
      }
      filesScopeList.innerHTML = filesHtml;
    } else {
      filesScopeList.innerHTML = '<div class="file-row" style="padding: 12px; justify-content: center;"><span style="font-size: 11px; color: #666;">No files detected</span></div>';
    }

    // Render Focus Areas
    if (data.focusAreas && data.focusAreas.length > 0) {
      const badgeClasses = ['badge-purple', 'badge-teal', 'badge-amber'];
      focusAreasList.innerHTML = data.focusAreas.map((area, index) => {
        const cls = badgeClasses[index % badgeClasses.length];
        return '<span class="badge ' + cls + '">' + escapeHtml(area) + '</span>';
      }).join('');
    } else {
      focusAreasList.innerHTML = '<span class="badge badge-pattern">None detected</span>';
    }
  }

  function renderReport(r) {
    // 1. Group: Project Review
    const reviewSections = [];
    if (r.executive_summary)
      reviewSections.push({ title: '📋 Executive Summary', content: p(r.executive_summary), open: true, dark: true });

    if (r.what_it_actually_is)
      reviewSections.push({ title: '🔍 What It Actually Is', content: p(r.what_it_actually_is), dark: false });

    if (r.project_maturity || r.scope_vs_execution) {
      let maturityHtml = '';
      if (r.project_maturity) {
        maturityHtml += '<div class="sub-field"><div class="sub-field-label">Project Maturity</div><div style="font-weight: 700; font-size: 12px; color: #10b981;">' + escapeHtml(r.project_maturity) + '</div></div>';
      }
      if (r.scope_vs_execution) {
        maturityHtml += '<div class="sub-field"><div class="sub-field-label">Scope vs Execution</div><p>' + escapeHtml(r.scope_vs_execution) + '</p></div>';
      }
      reviewSections.push({ title: '⚖️ Scope & Maturity Review', content: maturityHtml, dark: false });
    }

    if (r.core_strengths && r.core_strengths.length)
      reviewSections.push({ title: '💪 Core Strengths', content: ul(r.core_strengths), dark: false });

    if (r.biggest_risks && r.biggest_risks.length)
      reviewSections.push({ title: '⚠️ Weaknesses & Risks', content: ul(r.biggest_risks), dark: false });

    if (r.recommended_next_step)
      reviewSections.push({ title: '🚀 Recommended Next Step', content: p(r.recommended_next_step), dark: false });

    // 2. Group: Architecture Notes
    const architectureSections = [];
    if (r.architecture_observations && r.architecture_observations.length)
      architectureSections.push({ title: '🏗️ Architecture Observations', content: ul(r.architecture_observations), open: true, dark: true });

    if (r.engineering_patterns && r.engineering_patterns.length)
      architectureSections.push({ title: '📐 Detected Engineering Patterns', content: ul(r.engineering_patterns), dark: false });

    if (r.engineering_assessment)
      architectureSections.push({ title: '🛠️ General Engineering Assessment', content: p(r.engineering_assessment), dark: false });

    if (r.most_impressive_aspect)
      architectureSections.push({ title: '🌟 Most Impressive Aspect', content: p(r.most_impressive_aspect), dark: false });

    if (r.product_direction) {
      const pd = r.product_direction;
      const fields = [
        ['Strongest Direction', pd.strongest_direction],
        ['Highest Impact Next Step', pd.highest_impact_next_step],
        ['Biggest Technical Risk', pd.biggest_technical_risk],
        ['Most Impressive Aspect', pd.most_impressive_aspect],
        ['Most Underrated Feature', pd.most_underrated_feature],
      ].filter(f => f[1]);

      const html = fields.map(f =>
        '<div class="sub-field"><div class="sub-field-label">' + escapeHtml(f[0]) + '</div><div>' + escapeHtml(f[1]) + '</div></div>'
      ).join('');
      architectureSections.push({ title: '🧭 Tech Direction & Risks', content: html, dark: false });
    }

    // 3. Group: Learning Insights
    const learningSections = [];
    if (r.learning_areas && r.learning_areas.length)
      learningSections.push({ title: '📚 Learning Focus Areas', content: ul(r.learning_areas), open: true, dark: false });

    if (r.repeated_concepts && r.repeated_concepts.length)
      learningSections.push({ title: '🔄 Concept Duplication / Repetition', content: ul(r.repeated_concepts), dark: false });

    if (r.portfolio_assessment)
      learningSections.push({ title: '📁 Portfolio & Resume Assessment', content: p(r.portfolio_assessment), dark: false });

    if (r.developer_intelligence)
      reviewSections.push({ title: '🧠 Developer Intelligence Insights', content: p(r.developer_intelligence), dark: true });

    if (r.final_verdict)
      reviewSections.push({ title: '⚡ Final Review Verdict', content: p(r.final_verdict), open: true, dark: true });

    // Render grouped dashboard widgets with sub-headings
    let html = '<div class="report-header">Intelligence Dashboard — ' + escapeHtml(r.repo_name || 'Project') + '</div>';

    // Helper to generate section html
    function renderGroup(title, list) {
      if (!list.length) return '';
      let gHtml = '<div style="font-size: 10px; font-weight: 700; color: #858585; text-transform: uppercase; letter-spacing: 0.8px; margin: 12px 0 6px; padding-left: 2px;">' + title + '</div>';
      list.forEach((s) => {
        const openClass = s.open ? ' open' : '';
        gHtml += '<div class="report-section">'
              + '<button class="section-toggle' + openClass + '">'
              + '<span class="chevron">▶</span> '
              + '<span>' + s.title + '</span>'
              + '</button>'
              + '<div class="section-content' + openClass + '">' + s.content + '</div>'
              + '</div>';
      });
      return gHtml;
    }

    html += renderGroup('📋 Project Review', reviewSections);
    html += renderGroup('🏗️ Architecture Notes', architectureSections);
    html += renderGroup('💡 Learning Insights', learningSections);

    reportArea.innerHTML = html;
    reportArea.classList.remove('hidden');

    // Toggle listeners
    reportArea.querySelectorAll('.section-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('open');
        btn.nextElementSibling.classList.toggle('open');
      });
    });
  }

  function renderDevNotes(dn) {
    const sections = [];

    if (dn.what_was_worked_on && dn.what_was_worked_on.length)
      sections.push({ title: '📝 What Was Worked On', content: ul(dn.what_was_worked_on), open: true, dark: true });

    if (dn.concepts_used && dn.concepts_used.length)
      sections.push({ title: '🧠 Concepts Used', content: ul(dn.concepts_used), open: true, dark: false });

    if (dn.possible_goals && dn.possible_goals.length)
      sections.push({ title: '🚀 Possible Goals', content: ul(dn.possible_goals), open: true, dark: false });

    if (dn.architecture_changes && dn.architecture_changes.length)
      sections.push({ title: '🏗️ Architecture Changes', content: ul(dn.architecture_changes), dark: true });

    if (dn.learning_topics && dn.learning_topics.length)
      sections.push({ title: '📚 Learning Topics', content: ul(dn.learning_topics), dark: false });

    let html = '<div class="report-header">Session Development Notes</div>';

    sections.forEach((s) => {
      const openClass = s.open ? ' open' : '';
      html += '<div class="report-section">'
            + '<button class="section-toggle' + openClass + '">'
            + '<span class="chevron">▶</span> '
            + '<span>' + s.title + '</span>'
            + '</button>'
            + '<div class="section-content' + openClass + '">' + s.content + '</div>'
            + '</div>';
    });

    reportArea.innerHTML = html;
    reportArea.classList.remove('hidden');

    // Toggle listeners
    reportArea.querySelectorAll('.section-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('open');
        btn.nextElementSibling.classList.toggle('open');
      });
    });
  }

  function p(text) { return '<p>' + escapeHtml(text) + '</p>'; }

  function ul(items) {
    return '<ul>' + items.map(i => '<li>' + escapeHtml(i) + '</li>').join('') + '</ul>';
  }

  function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatDuration(sec) {
    if (!sec || sec < 1) return '0s';
    if (sec < 60) return Math.round(sec) + 's';
    const min = Math.floor(sec / 60);
    const remainingSec = Math.round(sec % 60);
    return min + 'm ' + remainingSec + 's';
  }

  function renderNotesHistory(notes) {
    if (!notes || notes.length === 0) {
      notesHistoryList.innerHTML = '<div class="history-empty">No evolution states recorded yet. Save changes to trigger an update.</div>';
      return;
    }

    notesHistoryList.innerHTML = notes.map(note => {
      const timeStr = formatTime(note.timestamp);
      const goalHtml = note.goal ? '<span class="history-item-goal" title="' + escapeHtml(note.goal) + '">🎯 ' + escapeHtml(note.goal) + '</span>' : '';
      
      let badgesHtml = '';
      if (note.primary_language) {
        badgesHtml += '<span class="badge badge-lang">' + escapeHtml(note.primary_language) + '</span>';
      }
      if (note.files_changed_count) {
        badgesHtml += '<span class="badge badge-files">📁 ' + note.files_changed_count + ' file' + (note.files_changed_count > 1 ? 's' : '') + '</span>';
      }
      if (note.session_duration) {
        badgesHtml += '<span class="badge badge-duration">⏱️ ' + formatDuration(note.session_duration) + '</span>';
      }
      if (note.major_focus) {
        badgesHtml += '<span class="badge badge-focus">🔍 ' + escapeHtml(note.major_focus) + '</span>';
      }
      if (note.detected_patterns && note.detected_patterns.length > 0) {
        note.detected_patterns.forEach(pat => {
          badgesHtml += '<span class="badge badge-pattern">' + escapeHtml(pat) + '</span>';
        });
      }

      let extraDetailsHtml = '';
      if (note.architecture_evolution || note.development_progression) {
        extraDetailsHtml = '<div class="history-item-details">'
          + (note.architecture_evolution ? '<div class="detail-section"><strong>Architecture:</strong> ' + escapeHtml(note.architecture_evolution) + '</div>' : '')
          + (note.development_progression ? '<div class="detail-section"><strong>Progression:</strong> ' + escapeHtml(note.development_progression) + '</div>' : '')
          + '</div>';
      }

      return '<div class="history-item">'
        + '<div class="history-item-header">'
        + '<span class="history-item-time">' + timeStr + '</span>'
        + goalHtml
        + '</div>'
        + '<div class="history-item-summary">' + escapeHtml(note.intent_summary || note.summary) + '</div>'
        + (badgesHtml ? '<div class="history-item-badges">' + badgesHtml + '</div>' : '')
        + extraDetailsHtml
        + '</div>';
    }).join('');
  }

  function formatTime(isoStr) {
    try {
      const date = new Date(isoStr);
      let hours = date.getHours();
      const minutes = date.getMinutes();
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      const minStr = minutes < 10 ? '0' + minutes : minutes;
      return hours + ':' + minStr + ' ' + ampm;
    } catch (e) {
      return isoStr;
    }
  }

  // Load initial notes history & workspace metadata
  vscode.postMessage({ command: 'refreshNotes' });
  vscode.postMessage({ command: 'getWorkspaceMetadata' });
})();
</script>
</body>
</html>`;
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
}

