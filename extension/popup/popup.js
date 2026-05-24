/**
 * OpenDoc — Extension Popup Logic
 *
 * Handles user interactions, API communication, report rendering,
 * and export functionality.
 */

// ── DOM References ────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const elements = {
  // Input
  repoUrl: $("repo-url"),
  analyzeBtn: $("analyze-btn"),
  inputHint: $("input-hint"),
  inputSection: $("input-section"),

  // Loading
  loadingSection: $("loading-section"),
  loadingText: $("loading-text"),
  stepFetch: $("step-fetch"),
  stepAnalyze: $("step-analyze"),
  stepReport: $("step-report"),

  // Error
  errorSection: $("error-section"),
  errorText: $("error-text"),
  retryBtn: $("retry-btn"),

  // Report
  reportSection: $("report-section"),
  reportContent: $("report-content"),
  exportPdfBtn: $("export-pdf-btn"),
  exportMdBtn: $("export-md-btn"),
  copyBtn: $("copy-btn"),
  newAnalysisBtn: $("new-analysis-btn"),

  // Settings
  settingsBtn: $("settings-btn"),
  settingsPanel: $("settings-panel"),
  settingsCloseBtn: $("settings-close-btn"),
  llmProvider: $("llm-provider"),
  llmModel: $("llm-model"),
  apiKey: $("api-key"),
  apiKeyHint: $("api-key-hint"),
  backendUrl: $("backend-url"),
  saveSettingsBtn: $("save-settings-btn"),
  saveToast: $("save-toast"),
};

// ── State ─────────────────────────────────────────────────────────
let currentReport = null;
let isAnalyzing = false;

const DEFAULT_BACKEND_URL = "http://localhost:8000";

// ── Settings Management ───────────────────────────────────────────
async function loadSettings() {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.local.get(["provider", "model", "apiKey", "backendUrl"], (result) => {
        resolve({
          provider: result.provider || "groq",
          model: result.model || "",
          apiKey: result.apiKey || "",
          backendUrl: result.backendUrl || DEFAULT_BACKEND_URL,
        });
      });
    } else {
      resolve({
        provider: localStorage.getItem("provider") || "groq",
        model: localStorage.getItem("model") || "",
        apiKey: localStorage.getItem("apiKey") || "",
        backendUrl: localStorage.getItem("backendUrl") || DEFAULT_BACKEND_URL,
      });
    }
  });
}

async function saveSettings(provider, model, apiKey, backendUrl) {
  return new Promise((resolve) => {
    const data = {
      provider: provider || "groq",
      model: model || "",
      apiKey: apiKey,
      backendUrl: backendUrl || DEFAULT_BACKEND_URL,
    };

    if (typeof chrome !== "undefined" && chrome.storage) {
      chrome.storage.local.set(data, resolve);
    } else {
      localStorage.setItem("provider", data.provider);
      localStorage.setItem("model", data.model);
      localStorage.setItem("apiKey", data.apiKey);
      localStorage.setItem("backendUrl", data.backendUrl);
      resolve();
    }
  });
}

// ── URL Validation ────────────────────────────────────────────────
function isValidGitHubUrl(url) {
  return /^https?:\/\/github\.com\/[^/]+\/[^/]+/i.test(url.trim());
}

// ── UI State Management ───────────────────────────────────────────
function showSection(sectionName) {
  elements.inputSection.classList.toggle("hidden", sectionName === "loading");
  elements.loadingSection.classList.toggle("hidden", sectionName !== "loading");
  elements.errorSection.classList.toggle("hidden", sectionName !== "error");
  elements.reportSection.classList.toggle("hidden", sectionName !== "report");
}

function resetToInput() {
  showSection("input");
  elements.inputHint.textContent =
    "Paste a public GitHub repository URL to generate an intelligence report";
  elements.inputHint.classList.remove("error");
  elements.analyzeBtn.disabled = false;
  isAnalyzing = false;
}

function setLoadingStep(step) {
  const steps = ["fetch", "analyze", "report"];
  const stepElements = [
    elements.stepFetch,
    elements.stepAnalyze,
    elements.stepReport,
  ];
  const messages = [
    "Fetching repository data...",
    "Senior engineer analyzing...",
    "Building intelligence report...",
  ];

  const idx = steps.indexOf(step);
  stepElements.forEach((el, i) => {
    el.classList.remove("active", "done");
    if (i < idx) el.classList.add("done");
    else if (i === idx) el.classList.add("active");
  });

  elements.loadingText.textContent = messages[idx] || messages[0];
}

function showError(message) {
  showSection("error");
  elements.errorText.textContent = message;
  isAnalyzing = false;
}

// ── Section Icon SVGs ─────────────────────────────────────────────
const SECTION_ICONS = {
  executive_summary: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  what_it_actually_is: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  core_strengths: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  engineering_assessment: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  scope_vs_execution: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  product_direction: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>`,
  biggest_risks: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  most_impressive_aspect: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
  recommended_next_step: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
  portfolio_assessment: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>`,
  developer_intelligence: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  final_verdict: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>`,
};

const SECTION_TITLES = {
  executive_summary: "Executive Summary",
  what_it_actually_is: "What The Project Actually Is",
  core_strengths: "Core Strengths",
  engineering_assessment: "Engineering Assessment",
  scope_vs_execution: "Scope vs Execution",
  product_direction: "Product Direction",
  biggest_risks: "Biggest Risks",
  most_impressive_aspect: "Most Impressive Aspect",
  recommended_next_step: "Recommended Next Step",
  portfolio_assessment: "Portfolio Assessment",
  developer_intelligence: "Developer Intelligence",
  final_verdict: "Final Verdict",
};

// ── Report Rendering ──────────────────────────────────────────────
function renderReport(report) {
  currentReport = report;
  const container = elements.reportContent;
  container.innerHTML = "";

  // Repo header
  if (report.repo_name || report.repo_url) {
    const header = document.createElement("div");
    header.className = "report-repo-header";
    header.innerHTML = `
      <div class="report-repo-name">${escapeHtml(report.repo_name || "Repository")}</div>
      ${
        report.repo_url
          ? `<a class="report-repo-url" href="${escapeHtml(report.repo_url)}" target="_blank" rel="noopener">${escapeHtml(report.repo_url)}</a>`
          : ""
      }
    `;
    container.appendChild(header);
  }

  // Standard sections (text and list types)
  const sectionOrder = [
    "executive_summary",
    "what_it_actually_is",
    "core_strengths",
    "engineering_assessment",
    "scope_vs_execution",
    "product_direction",
    "biggest_risks",
    "most_impressive_aspect",
    "recommended_next_step",
    "portfolio_assessment",
    "developer_intelligence",
    "final_verdict",
  ];

  sectionOrder.forEach((key) => {
    const value = report[key];
    if (!value || (Array.isArray(value) && value.length === 0)) return;

    // Handle product_direction as a special nested section
    if (key === "product_direction" && typeof value === "object" && !Array.isArray(value)) {
      renderProductDirection(container, value);
      return;
    }

    const card = document.createElement("div");
    let extraClass = "";
    if (key === "core_strengths") extraClass = " strengths";
    if (key === "biggest_risks") extraClass = " weaknesses";
    if (key === "recommended_next_step") extraClass = " improvements";
    if (key === "final_verdict") extraClass = " verdict";
    card.className = `report-card${extraClass}`;

    const icon = SECTION_ICONS[key] || "";
    const title = SECTION_TITLES[key] || key;

    let bodyHtml = "";
    if (Array.isArray(value)) {
      bodyHtml = `<ul>${value.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
    } else {
      bodyHtml = `<p>${escapeHtml(value)}</p>`;
    }

    card.innerHTML = `
      <div class="report-card-header">
        <div class="report-card-icon">${icon}</div>
        <div class="report-card-title">${escapeHtml(title)}</div>
      </div>
      <div class="report-card-body">${bodyHtml}</div>
    `;

    container.appendChild(card);
  });

  showSection("report");
}

function renderProductDirection(container, pd) {
  const card = document.createElement("div");
  card.className = "report-card product-direction";

  const icon = SECTION_ICONS.product_direction || "";
  const title = SECTION_TITLES.product_direction;

  const subSections = [
    { key: "strongest_direction", label: "Strongest Direction", accent: "#6c5ce7" },
    { key: "highest_impact_next_step", label: "Highest Impact Next Step", accent: "#2ed573" },
    { key: "biggest_technical_risk", label: "Biggest Technical Risk", accent: "#ff6b6b" },
    { key: "most_impressive_aspect", label: "Most Impressive Aspect", accent: "#ffa502" },
    { key: "most_underrated_feature", label: "Most Underrated Feature", accent: "#a29bfe" },
  ];

  let bodyHtml = "";
  subSections.forEach(({ key, label, accent }) => {
    const val = pd[key];
    if (!val) return;
    bodyHtml += `
      <div class="pd-item">
        <div class="pd-label" style="color: ${accent}">${escapeHtml(label)}</div>
        <p class="pd-text">${escapeHtml(val)}</p>
      </div>
    `;
  });

  card.innerHTML = `
    <div class="report-card-header">
      <div class="report-card-icon">${icon}</div>
      <div class="report-card-title">${escapeHtml(title)}</div>
    </div>
    <div class="report-card-body">${bodyHtml}</div>
  `;

  container.appendChild(card);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = String(text);
  return div.innerHTML;
}

// ── API Communication ─────────────────────────────────────────────
async function analyzeRepo(repoUrl) {
  if (isAnalyzing) return;
  isAnalyzing = true;

  const settings = await loadSettings();

  if (!settings.apiKey) {
    showError("Please set your API key in Settings (gear icon).");
    return;
  }

  showSection("loading");
  setLoadingStep("fetch");

  try {
    setTimeout(() => {
      if (isAnalyzing) setLoadingStep("analyze");
    }, 1500);

    setTimeout(() => {
      if (isAnalyzing) setLoadingStep("report");
    }, 8000);

    const backendUrl = settings.backendUrl.replace(/\/+$/, "");
    const response = await fetch(`${backendUrl}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_url: repoUrl,
        provider: settings.provider,
        model: settings.model || null,
        api_key: settings.apiKey,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.detail || `Server error: ${response.status}`);
    }

    const data = await response.json();

    if (!data.success || !data.report) {
      throw new Error(data.error || "Failed to generate report");
    }

    isAnalyzing = false;
    renderReport(data.report);
  } catch (err) {
    console.error("Analysis failed:", err);
    let message = err.message;
    if (err.message.includes("Failed to fetch") || err.message.includes("NetworkError")) {
      message = `Cannot connect to backend at ${settings.backendUrl}. Is the server running?`;
    }
    showError(message);
  }
}

// ── Export: PDF ────────────────────────────────────────────────────
async function exportPdf() {
  if (!currentReport) return;

  const settings = await loadSettings();
  const backendUrl = settings.backendUrl.replace(/\/+$/, "");

  try {
    elements.exportPdfBtn.disabled = true;
    elements.exportPdfBtn.querySelector("span").textContent = "Generating...";

    const response = await fetch(`${backendUrl}/api/generate-pdf`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report: currentReport }),
    });

    if (!response.ok) throw new Error("PDF generation failed");

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(currentReport.repo_name || "opendoc").replace(/\//g, "_")}_report.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("PDF export failed:", err);
    alert("Failed to export PDF. Is the backend running?");
  } finally {
    elements.exportPdfBtn.disabled = false;
    elements.exportPdfBtn.querySelector("span").textContent = "PDF";
  }
}

// ── Export: Markdown ──────────────────────────────────────────────
function exportMarkdown() {
  if (!currentReport) return;

  const r = currentReport;
  let md = `# ${r.repo_name || "Repository Analysis"}\n\n`;

  if (r.repo_url) md += `> ${r.repo_url}\n\n`;
  if (r.executive_summary) md += `## Executive Summary\n\n${r.executive_summary}\n\n`;
  if (r.what_it_actually_is) md += `## What The Project Actually Is\n\n${r.what_it_actually_is}\n\n`;

  if (r.core_strengths && r.core_strengths.length) {
    md += `## Core Strengths\n\n${r.core_strengths.map((s) => `- ${s}`).join("\n")}\n\n`;
  }

  if (r.engineering_assessment) md += `## Engineering Assessment\n\n${r.engineering_assessment}\n\n`;
  if (r.scope_vs_execution) md += `## Scope vs Execution\n\n${r.scope_vs_execution}\n\n`;

  if (r.product_direction) {
    md += `## Product Direction\n\n`;
    const pd = r.product_direction;
    if (pd.strongest_direction) md += `**Strongest Direction:** ${pd.strongest_direction}\n\n`;
    if (pd.highest_impact_next_step) md += `**Highest Impact Next Step:** ${pd.highest_impact_next_step}\n\n`;
    if (pd.biggest_technical_risk) md += `**Biggest Technical Risk:** ${pd.biggest_technical_risk}\n\n`;
    if (pd.most_impressive_aspect) md += `**Most Impressive Aspect:** ${pd.most_impressive_aspect}\n\n`;
    if (pd.most_underrated_feature) md += `**Most Underrated Feature:** ${pd.most_underrated_feature}\n\n`;
  }

  if (r.biggest_risks && r.biggest_risks.length) {
    md += `## Biggest Risks\n\n${r.biggest_risks.map((s) => `- ${s}`).join("\n")}\n\n`;
  }

  if (r.most_impressive_aspect) md += `## Most Impressive Aspect\n\n${r.most_impressive_aspect}\n\n`;
  if (r.recommended_next_step) md += `## Recommended Next Step\n\n${r.recommended_next_step}\n\n`;
  if (r.portfolio_assessment) md += `## Portfolio Assessment\n\n${r.portfolio_assessment}\n\n`;
  if (r.developer_intelligence) md += `## Developer Intelligence\n\n${r.developer_intelligence}\n\n`;
  if (r.final_verdict) md += `## Final Verdict\n\n${r.final_verdict}\n\n`;

  md += `---\n\n*Generated by OpenDoc — Turn coding chaos into structured intelligence.*\n`;

  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(r.repo_name || "opendoc").replace(/\//g, "_")}_report.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Export: Copy Summary ──────────────────────────────────────────
async function copySummary() {
  if (!currentReport || !currentReport.executive_summary) return;

  try {
    await navigator.clipboard.writeText(currentReport.executive_summary);
    const span = elements.copyBtn.querySelector("span");
    span.textContent = "Copied!";
    setTimeout(() => (span.textContent = "Copy"), 1500);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = currentReport.executive_summary;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);

    const span = elements.copyBtn.querySelector("span");
    span.textContent = "Copied!";
    setTimeout(() => (span.textContent = "Copy"), 1500);
  }
}

// ── Event Listeners ───────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  const settings = await loadSettings();
  elements.llmProvider.value = settings.provider || "groq";
  elements.llmModel.value = settings.model || "";
  elements.apiKey.value = settings.apiKey || "";
  elements.backendUrl.value = settings.backendUrl;

  const updateHints = () => {
    const provider = elements.llmProvider.value;
    if (provider === "groq") {
      elements.llmModel.placeholder = "llama-3.3-70b-versatile";
      elements.apiKeyHint.innerHTML = 'Get your key at <a href="https://console.groq.com" target="_blank" rel="noopener">console.groq.com</a>';
    } else if (provider === "openai") {
      elements.llmModel.placeholder = "gpt-4o";
      elements.apiKeyHint.innerHTML = 'Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com</a>';
    } else if (provider === "anthropic") {
      elements.llmModel.placeholder = "claude-3-5-sonnet-latest";
      elements.apiKeyHint.innerHTML = 'Get your key at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>';
    } else if (provider === "google") {
      elements.llmModel.placeholder = "gemini-2.5-pro";
      elements.apiKeyHint.innerHTML = 'Get your key at <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">aistudio.google.com</a>';
    }
  };
  
  updateHints();
  elements.llmProvider.addEventListener("change", updateHints);

  elements.analyzeBtn.addEventListener("click", () => {
    const url = elements.repoUrl.value.trim();
    if (!url) {
      elements.inputHint.textContent = "Please enter a GitHub repository URL";
      elements.inputHint.classList.add("error");
      return;
    }
    if (!isValidGitHubUrl(url)) {
      elements.inputHint.textContent = "Invalid URL. Use format: https://github.com/owner/repo";
      elements.inputHint.classList.add("error");
      return;
    }
    elements.inputHint.classList.remove("error");
    analyzeRepo(url);
  });

  elements.repoUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") elements.analyzeBtn.click();
  });

  elements.repoUrl.addEventListener("input", () => {
    elements.inputHint.classList.remove("error");
    elements.inputHint.textContent =
      "Paste a public GitHub repository URL to generate an intelligence report";
  });

  elements.retryBtn.addEventListener("click", resetToInput);

  elements.newAnalysisBtn.addEventListener("click", () => {
    currentReport = null;
    elements.repoUrl.value = "";
    resetToInput();
  });

  elements.exportPdfBtn.addEventListener("click", exportPdf);
  elements.exportMdBtn.addEventListener("click", exportMarkdown);
  elements.copyBtn.addEventListener("click", copySummary);

  elements.settingsBtn.addEventListener("click", () => {
    elements.settingsPanel.classList.remove("hidden");
  });

  elements.settingsCloseBtn.addEventListener("click", () => {
    elements.settingsPanel.classList.add("hidden");
  });

  elements.saveSettingsBtn.addEventListener("click", async () => {
    const provider = elements.llmProvider.value;
    const model = elements.llmModel.value.trim();
    const apiKey = elements.apiKey.value.trim();
    const backendUrl = elements.backendUrl.value.trim();
    await saveSettings(provider, model, apiKey, backendUrl);

    elements.saveToast.classList.remove("hidden");
    setTimeout(() => elements.saveToast.classList.add("hidden"), 2000);
  });
});
