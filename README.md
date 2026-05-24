# 🧠 OpenDoc

> Turn coding chaos into structured engineering insight.

OpenDoc is an experimental, AI-powered developer intelligence tool built as a VS Code sidebar extension and a Chrome browser extension, backed by a FastAPI server.

Instead of simply summarizing repositories, OpenDoc analyzes projects and coding sessions to generate:
* **Engineering Reviews** — tradeoffs, code quality, and structural health.
* **Architecture Insights** — pattern detection and design decision tracking.
* **Development Notes** — activity summaries detailing edited files, imports, and goals.
* **Learning Reports** — growth topics, repeated concepts, and refactoring areas.
* **Portfolio Summaries** — stand-out resume-centric engineering achievements.
* **Customizable Exports** — clean Markdown and resilient PDF documents.

> [!IMPORTANT]
> **This project is not complete.** It is an active experiment. Feel free to contribute by opening issues, submitting pull requests, or sharing feedback!

---

# 🎯 Why OpenDoc Exists

Modern development is increasingly fast, experimental, and AI-assisted. Developers often:
* Ship features quickly
* Forget architectural decisions
* Lose track of learning progress
* Struggle to document projects
* Can’t clearly explain their own codebases later

OpenDoc attempts to solve that problem by converting repositories and coding activity into structured, readable insight.

---

# 💡 Philosophy

OpenDoc is **NOT** trying to become:
* Another AI coding assistant
* Another Copilot clone
* Another generic repo summarizer

The focus is: **Developer Understanding.**

The project is more interested in:
* Engineering insight
* Technical reflection
* Architecture awareness
* Development intelligence

than code generation itself.

---

# ✨ Features

### 🔍 Repository Analysis
Analyze projects directly from VS Code or a Chrome extension. OpenDoc reviews:
* Project structure and folder layouts
* Architecture patterns and design paradigms
* Core dependencies and library choices
* Implementation maturity and engineering tradeoffs
* Scope vs execution status

### 📊 Multiple Report Modes
Generate different types of reports depending on your goal:
* **Client Report**: Professional project overview for clients or presentations.
* **Learning Report**: Focus on concepts, growth, and technical understanding.
* **Understanding Report**: Helps explain architecture and workflow clearly.
* **Portfolio Report**: Highlights engineering decisions and standout technical work.
* **Custom Report**: Choose exactly what sections to include.

### 📝 Development Notes
Generate lightweight, readable summaries from recent coding activity:
* Files edited and functions modified
* External imports introduced
* Session goals and accomplishments

### 📄 Markdown & PDF Export
Export reports safely into clean, structured Markdown or crash-resilient PDF files.

---

# 🏗️ Project Structure

```
opendoc/
├── extension/                     # Chrome/Chromium Browser Extension
│   ├── manifest.json
│   ├── popup/
│   │   ├── popup.html             # Extension popup UI
│   │   ├── popup.css              # Premium dark theme
│   │   └── popup.js               # Popup logic & browser API calls
│   └── icons/
│
├── vscode-extension/              # VS Code Extension
│   ├── package.json               # Extension configuration & configuration schema
│   ├── tsconfig.json
│   └── src/
│       ├── extension.ts           # Extension entrypoint & workspace scanner
│       └── OpenDocViewProvider.ts # Sidebar Webview controller & backend wrapper
│
├── backend/                       # FastAPI Backend
│   ├── main.py                    # App entrypoint & CORS middleware
│   ├── config.py                  # Settings & environment variables resolver
│   ├── routers/
│   │   └── analyze.py             # Route handlers for analyze, local, dev-notes, and PDF
│   ├── services/
│   │   ├── github_service.py      # Git URL parsing & context collector
│   │   ├── ai_service.py          # LLM API request dispatcher & cleaner
│   │   ├── dev_notes_service.py   # Developer activity notes formatter
│   │   └── pdf_service.py         # Resilient PDF generator (using fpdf2)
│   ├── models/
│   │   └── schemas.py             # Pydantic request/response schemas
│   ├── prompts/                   # System instructions and prompt builders
│   ├── tests/                     # Unit test suites (custom prompt, pdf, API router)
│   ├── requirements.txt
│   └── .env.example
│
└── README.md                      # Project documentation
```

---

# 🚀 Tech Stack

### Frontend
* **VS Code Extension API**: TypeScript sidebar webview.
* **Chrome Extension**: Vanilla HTML5, CSS3, and JavaScript (Manifest V3).

### Backend
* **FastAPI**: Python-based high-performance asynchronous web server.
* **FPDF2**: Clean and fast PDF export generation.

### AI
* **Groq API**: Defaults to Llama 3.3 70B (fast inference).
* **Multi-LLM Compatible**: Also supports OpenAI, Anthropic Claude, and Google Gemini models.

---

# 🔌 API Endpoints

| Method | Endpoint | Input Payload | Description |
|--------|----------|---------------|-------------|
| `GET` | `/` | None | Service health status check |
| `POST` | `/api/analyze` | `AnalyzeRequest` | Analyze a remote public GitHub repository |
| `POST` | `/api/analyze-local` | `AnalyzeLocalRequest` | Analyze local workspace structure & contents |
| `POST` | `/api/generate-dev-notes` | `DevNotesRequest` | Generate dev summary from tracked file edits |
| `POST` | `/api/generate-pdf` | `PDFRequest` | Generate clean, safe PDF from report data |

---

# 🚀 Installation & Quick Start

### 1. Set Up the Backend

```bash
cd backend

# Create and activate virtual environment
python -m venv venv
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure settings
copy .env.example .env
# Edit .env to set your default provider API keys (optional)

# Start server
uvicorn main:app --reload --port 8000
```
The backend API will run at `http://localhost:8000`. You can inspect the Interactive OpenAPI docs at `http://localhost:8000/docs`.

---

### 2. Set Up the Clients

#### Option A: VS Code Extension (Recommended)
1. Open the `opendoc/vscode-extension` directory in a terminal.
2. Install dependencies and compile the TypeScript source:
   ```bash
   npm install
   npm run compile
   ```
3. In VS Code, press `F5` to open the **[Extension Development Host]** window.
4. Go to Settings (`Ctrl+,` or `Cmd+,`), search for `opendoc`, and input your **API Key** and **Provider**.
5. Open the sidebar (OpenDoc tab) to start generating reports for the current workspace folder!

#### Option B: Chrome Browser Extension
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** (top-left).
4. Select the `opendoc/extension` directory.
5. Click the OpenDoc icon in your extension bar, go to Settings (⚙️), paste your API key, and set your backend URL.

---

# 🛠️ Testing

Run the test suite to verify code stability, custom prompt filtering, and PDF generation safety:
```bash
cd backend
python -m pytest
```

---

# 🚧 Open Problems & Ongoing Areas

OpenDoc is an experimental prototype. Contributions and experiments are welcome for:
* **Smarter Repository Context Filtering** — selecting the highest-signal code files.
* **Less Repetitive AI Outputs** — fine-tuning instructions to avoid boilerplate summaries.
* **Architecture Diagramming** — generating visual charts of code relationships.
* **Local Model Support** — running summaries with local Ollama/Llama.cpp setups.
* **Session-Aware Memory** — tracking development state over long coding sessions.

---

# ⚠️ Disclaimer

OpenDoc is experimental. AI-generated analyses may:
* Miss critical codebase context.
* Hallucinate implementation details.
* Misinterpret complex architecture decisions.

Always review outputs critically.

---

# 🌟 Vision

OpenDoc explores a simple idea:

> What if coding sessions could become understandable knowledge instead of forgotten chaos?
