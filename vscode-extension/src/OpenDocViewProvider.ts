/**
 * OpenDoc — Sidebar Webview Provider
 *
 * Implements the sidebar panel that detects the workspace,
 * sends project context to the backend, and renders the AI report.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import { getWorkspaceTree, readKeyFiles, analyzeFileContent } from "./utils/workspaceScanner";

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
<style>
  /* ── Reset & Typography ── */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: 'Outfit', var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: #1f2937;
    background: radial-gradient(circle at 10% 20%, #f9fafb 0%, #f3f4f6 40%, #e5e7eb 70%, #d1d5db 100%);
    background-attachment: fixed;
    line-height: 1.5;
    padding: 0;
    overflow-x: hidden;
  }

  /* ── Header (Glassmorphism) ── */
  .header {
    padding: 20px 16px 16px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
    background: rgba(255, 255, 255, 0.5);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .header-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .logo-icon {
    width: 24px;
    height: 24px;
    border-radius: 8px;
    background: #18181b;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    color: #ffffff;
    font-weight: 800;
    flex-shrink: 0;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  }

  .logo-text {
    font-size: 16px;
    font-weight: 800;
    color: #18181b;
    letter-spacing: -0.5px;
  }

  .settings-btn {
    background: none;
    border: none;
    color: #4b5563;
    cursor: pointer;
    font-size: 16px;
    padding: 6px;
    border-radius: 8px;
    transition: all 0.2s;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .settings-btn:hover {
    color: #18181b;
    background: rgba(0, 0, 0, 0.05);
    transform: rotate(30deg);
  }

  .workspace-badge {
    font-size: 11px;
    font-weight: 500;
    color: #4b5563;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(0, 0, 0, 0.05);
    border: 1px solid rgba(0, 0, 0, 0.04);
    padding: 4px 10px;
    border-radius: 20px;
  }
  .workspace-badge .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 8px #10b981;
    flex-shrink: 0;
  }

  /* ── Action Buttons ── */
  .action-area {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .analyze-btn, .devnotes-btn {
    width: 100%;
    padding: 12px 16px;
    border: none;
    border-radius: 14px;
    font-size: 13px;
    font-weight: 600;
    font-family: 'Outfit', sans-serif;
    cursor: pointer;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);
  }

  /* Dark Button style */
  .analyze-btn {
    background: #18181b;
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }
  .analyze-btn:hover {
    background: #27272a;
    transform: translateY(-1px);
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1);
  }

  /* Light Button style */
  .devnotes-btn {
    background: #ffffff;
    color: #18181b;
    border: 1px solid rgba(0, 0, 0, 0.08);
  }
  .devnotes-btn:hover {
    background: #f9fafb;
    transform: translateY(-1px);
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -4px rgba(0, 0, 0, 0.05);
  }

  .analyze-btn:active, .devnotes-btn:active {
    transform: translateY(0) scale(0.98);
  }

  .analyze-btn:disabled, .devnotes-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none !important;
    box-shadow: none !important;
  }

  /* ── Status ── */
  .status {
    padding: 0 16px;
    margin-bottom: 16px;
  }

  .status-msg {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 500;
    padding: 10px 14px;
    border-radius: 12px;
    animation: fadeIn 0.2s ease;
  }

  .status-msg.loading {
    color: #1d4ed8;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
  }

  .status-msg.error {
    color: #dc2626;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

  /* ── Report Cards / Widgets ── */
  .report {
    padding: 0 16px 32px;
    animation: fadeIn 0.3s ease;
  }

  .report-header {
    font-size: 14px;
    font-weight: 700;
    color: #18181b;
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.06);
    letter-spacing: -0.2px;
  }

  /* Alternating Dark / Light Widget styles mimicking the Dribbble design */
  .report-section {
    margin-bottom: 12px;
    border-radius: 20px;
    overflow: hidden;
    transition: all 0.25s ease;
  }

  /* Dark Card (charcoal theme) */
  .report-section.dark-card {
    background: #18181b;
    color: #f4f4f5;
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1);
  }
  .report-section.dark-card:hover {
    border-color: rgba(255, 255, 255, 0.15);
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.15);
  }

  /* Light Card (clean white theme) */
  .report-section.light-card {
    background: #ffffff;
    color: #18181b;
    border: 1px solid rgba(0, 0, 0, 0.06);
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.04), 0 4px 6px -4px rgba(0, 0, 0, 0.04);
  }
  .report-section.light-card:hover {
    border-color: rgba(0, 0, 0, 0.12);
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.08), 0 8px 10px -6px rgba(0, 0, 0, 0.08);
  }

  .section-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 16px;
    border: none;
    cursor: pointer;
    text-align: left;
    font-size: 13px;
    font-weight: 600;
    font-family: 'Outfit', sans-serif;
    transition: background-color 0.2s;
    background: transparent;
    color: inherit;
  }

  .report-section.dark-card .section-toggle:hover {
    background: rgba(255, 255, 255, 0.04);
  }
  .report-section.light-card .section-toggle:hover {
    background: rgba(0, 0, 0, 0.02);
  }

  .section-toggle .chevron {
    font-size: 9px;
    transition: transform 0.2s ease;
    flex-shrink: 0;
    opacity: 0.6;
  }
  .section-toggle.open .chevron {
    transform: rotate(90deg);
  }

  .section-content {
    display: none;
    padding: 0 16px 16px;
    font-size: 12px;
    line-height: 1.6;
  }
  .section-content.open {
    display: block;
  }

  .report-section.dark-card .section-content {
    color: #a1a1aa;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    padding-top: 12px;
  }
  .report-section.light-card .section-content {
    color: #4b5563;
    border-top: 1px solid rgba(0, 0, 0, 0.05);
    padding-top: 12px;
  }

  /* List Bullet styles matching card themes */
  .section-content ul {
    padding-left: 18px;
    margin: 6px 0;
  }
  .section-content li {
    margin-bottom: 6px;
  }
  .report-section.dark-card li::marker {
    color: #ffffff;
  }
  .report-section.light-card li::marker {
    color: #18181b;
  }

  .sub-field {
    margin-bottom: 12px;
  }
  .sub-field-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 3px;
  }
  .report-section.dark-card .sub-field-label {
    color: #a1a1aa;
  }
  .report-section.light-card .sub-field-label {
    color: #6b7280;
  }

  /* ── Scrollbar ── */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.15);
    border-radius: 3px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: rgba(0, 0, 0, 0.25);
  }

  /* ── Report Mode Selection System ── */
  .mode-select-container {
    padding: 0 16px;
    margin-bottom: 12px;
  }
  .mode-select {
    width: 100%;
    padding: 10px 14px;
    border-radius: 14px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    background: #ffffff;
    font-family: 'Outfit', sans-serif;
    font-size: 12px;
    font-weight: 500;
    color: #18181b;
    outline: none;
    cursor: pointer;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.02);
    transition: all 0.2s;
  }
  .mode-select:focus {
    border-color: #18181b;
    box-shadow: 0 0 0 2px rgba(24, 24, 27, 0.08);
  }

  .custom-sections {
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.4);
    border-radius: 18px;
    border: 1px solid rgba(0, 0, 0, 0.05);
    margin: 0 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    animation: fadeIn 0.25s ease;
  }

  .checkbox-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    font-weight: 600;
    color: #4b5563;
    cursor: pointer;
  }
  .checkbox-item input {
    cursor: pointer;
    accent-color: #18181b;
    width: 13px;
    height: 13px;
  }

  /* ── Export panel style ── */
  .export-panel {
    padding: 16px;
    display: flex;
    gap: 10px;
    background: rgba(255, 255, 255, 0.4);
    border-top: 1px solid rgba(0, 0, 0, 0.06);
    margin-top: 24px;
    animation: fadeIn 0.3s ease;
  }
  .export-btn {
    flex: 1;
    padding: 10px 14px;
    border-radius: 12px;
    border: 1px solid rgba(0, 0, 0, 0.08);
    background: #ffffff;
    color: #18181b;
    font-family: 'Outfit', sans-serif;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.02);
  }
  .export-btn:hover {
    background: #f9fafb;
    transform: translateY(-1px);
    box-shadow: 0 6px 12px rgba(0,0,0,0.05);
  }
  .export-btn:active {
    transform: translateY(0);
  }

  .hidden { display: none !important; }

  /* ── Note Version History ── */
  .history-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 4px;
    max-height: 250px;
    overflow-y: auto;
    padding-right: 4px;
  }
  .history-item {
    background: #ffffff;
    border: 1px solid rgba(0, 0, 0, 0.06);
    border-radius: 12px;
    padding: 10px 12px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.01);
    transition: all 0.2s ease;
    animation: fadeIn 0.2s ease;
  }
  .history-item:hover {
    border-color: rgba(0, 0, 0, 0.1);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.03);
  }
  .history-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
    gap: 6px;
  }
  .history-item-time {
    font-size: 9px;
    font-weight: 700;
    color: #2563eb;
    background: rgba(37, 99, 235, 0.08);
    padding: 2px 6px;
    border-radius: 20px;
    white-space: nowrap;
  }
  .history-item-goal {
    font-size: 9px;
    font-weight: 600;
    color: #4b5563;
    background: rgba(0, 0, 0, 0.04);
    padding: 2px 6px;
    border-radius: 20px;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .history-item-summary {
    font-size: 11px;
    line-height: 1.4;
    color: #1f2937;
  }
  .history-empty {
    font-size: 11px;
    color: #6b7280;
    text-align: center;
    padding: 16px;
    border: 1px dashed rgba(0, 0, 0, 0.08);
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.005);
  }
  .history-item-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .badge {
    font-size: 9px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .badge-lang {
    background: rgba(16, 185, 129, 0.1);
    color: #047857;
    border: 1px solid rgba(16, 185, 129, 0.15);
  }
  .badge-files {
    background: rgba(245, 158, 11, 0.1);
    color: #b45309;
    border: 1px solid rgba(245, 158, 11, 0.15);
  }
  .badge-duration {
    background: rgba(99, 102, 241, 0.1);
    color: #4f46e5;
    border: 1px solid rgba(99, 102, 241, 0.15);
  }
  .badge-focus {
    background: rgba(239, 68, 68, 0.1);
    color: #b91c1c;
    border: 1px solid rgba(239, 68, 68, 0.15);
  }
  .badge-pattern {
    background: rgba(107, 114, 128, 0.1);
    color: #374151;
    border: 1px solid rgba(107, 114, 128, 0.15);
  }
  .history-item-details {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px dashed rgba(0, 0, 0, 0.05);
    font-size: 10px;
    color: #4b5563;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .detail-section {
    line-height: 1.3;
  }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-top">
    <div class="logo">
      <div class="logo-icon">O</div>
      <span class="logo-text">OpenDoc</span>
    </div>
    <div style="display: flex; gap: 4px;">
      <button class="settings-btn" id="newSessionBtn" title="Start New Session">🆕</button>
      <button class="settings-btn" id="settingsBtn" title="Settings">⚙️</button>
    </div>
  </div>
  <div class="workspace-badge">
    <span class="dot"></span>
    <span id="workspaceName">${this._escapeHtml(workspaceName)}</span>
  </div>
</div>


<!-- Action Area -->
<div class="action-area">
  <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px;">
    <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: #4b5563; letter-spacing: 0.5px; padding-left: 2px;">Current Goal</span>
    <input type="text" id="currentGoal" class="mode-select" placeholder="Optional: e.g. Add authentication middleware" style="width: 100%;">
  </div>

  <button class="analyze-btn" id="analyzeBtn">⚡ Analyze Project</button>
  <button class="devnotes-btn" id="devNotesBtn">📝 Generate Dev Notes</button>
  <button class="devnotes-btn" id="recordStateBtn" style="margin-top: 4px;">💾 Capture Evolution State</button>
</div>

<!-- Status Area -->
<div class="status hidden" id="statusArea">
  <div class="status-msg" id="statusMsg"></div>
</div>

<!-- Report/Notes Area -->
<div class="report hidden" id="reportArea"></div>

<!-- Export Actions Panel -->
<div class="export-panel hidden" id="exportPanel">
  <button class="export-btn" id="savePdfBtn">📄 Save PDF</button>
  <button class="export-btn" id="saveMDBtn">📝 Save Markdown</button>
</div>

<!-- Session Evolution History -->
<div class="version-history-section" style="padding: 16px; border-top: 1px solid rgba(0, 0, 0, 0.06); margin-top: 10px; display: flex; flex-direction: column; gap: 10px;">
  <div style="display: flex; align-items: center; justify-content: space-between;">
    <span style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: #4b5563; letter-spacing: 0.5px; padding-left: 2px;">Session Evolution History</span>
    <button class="settings-btn" id="refreshNotesBtn" title="Refresh Notes" style="font-size: 12px; padding: 2px;">🔄</button>
  </div>
  <div id="notesHistoryList" class="history-list">
    <div class="history-empty">No evolution states recorded yet. Save changes to trigger an update.</div>
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

  let currentReport = null;

  analyzeBtn.addEventListener('click', () => {
    vscode.postMessage({
      command: 'analyze',
      reportMode: 'client',
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
        statusMsg.innerHTML = '⚠ ' + escapeHtml(msg.text);
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
    }
  });

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
        maturityHtml += '<div class="sub-field"><div class="sub-field-label">Project Maturity</div><div style="font-weight: 700; font-size: 13px; color: #10b981;">' + escapeHtml(r.project_maturity) + '</div></div>';
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
      learningSections.push({ title: '🧠 Developer Intelligence Insights', content: p(r.developer_intelligence), dark: true });

    if (r.final_verdict)
      learningSections.push({ title: '⚡ Final Review Verdict', content: p(r.final_verdict), open: true, dark: true });

    // Render grouped dashboard widgets with sub-headings
    let html = '<div class="report-header">Intelligence Dashboard — ' + escapeHtml(r.repo_name || 'Project') + '</div>';

    // Helper to generate section html
    function renderGroup(title, list) {
      if (!list.length) return '';
      let gHtml = '<div style="font-size: 11px; font-weight: 700; color: #6b7280; text-transform: uppercase; letter-spacing: 0.8px; margin: 16px 0 8px; padding-left: 2px;">' + title + '</div>';
      list.forEach((s) => {
        const openClass = s.open ? ' open' : '';
        const cardTheme = s.dark ? ' dark-card' : ' light-card';
        gHtml += '<div class="report-section' + cardTheme + '">'
              + '<button class="section-toggle' + openClass + '">'
              + '<span class="chevron">▶</span>'
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

    sections.forEach((s, i) => {
      const openClass = s.open ? ' open' : '';
      const cardTheme = s.dark ? ' dark-card' : ' light-card';
      html += '<div class="report-section' + cardTheme + '">'
            + '<button class="section-toggle' + openClass + '" data-idx="' + i + '">'
            + '<span class="chevron">▶</span>'
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
      
      // Badges
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
      hours = hours ? hours : 12; // the hour '0' should be '12'
      const minStr = minutes < 10 ? '0' + minutes : minutes;
      return hours + ':' + minStr + ' ' + ampm;
    } catch (e) {
      return isoStr;
    }
  }

  // Load initial notes history
  vscode.postMessage({ command: 'refreshNotes' });
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

