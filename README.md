# OurCode IDE

> An AI-powered code editor with multi-provider LLM support, agentic workflows, and editable chat history.

[中文文档](./README.zh-CN.md)

OurCode IDE is a desktop code editor built with Electron that brings an AI assistant directly into your coding workflow. Chat with the assistant, let it read and edit files in your workspace, run commands in the integrated terminal, and keep full control with human-in-the-loop approvals — or delegate autonomous subtasks to specialized subagents.

## ✨ Feature Highlights

### 🤖 AI Assistant & Chat

- **Streaming chat with live thinking** — Responses stream token by token with thinking blocks rendered in real time; Markdown output is sanitized with DOMPurify before display.
- **Editable chat history** — Edit, delete, or regenerate from any past message; drag to reorder, or batch-delete.
- **Branch & compare** — Fork the conversation from any message into a new session, or run the same prompt across several models in an Arena and adopt the best answer with one click.
- **Long-term memory** — The assistant can save and retrieve project memories (toggleable).
- **Image input (vision)** — Attach screenshots with the toolbar button, `Ctrl+V`, or by dropping files into the composer. Oversized images are downscaled and re-encoded locally before they go out, and attachments are stored with the session so they survive a restart.
- **Reusable workflows** — Save prompts as workflow templates to kick off recurring tasks in a single click.

### 🌐 Multi-Provider LLM Support

- **8 provider families** — OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Azure OpenAI, Ollama (local), and any OpenAI-compatible endpoint.
- **Multiple API groups** — Per-group color labels, custom headers, and wire-format override (`openai` / `responses` / `anthropic` / `azure` / `ollama`).
- **Painless setup** — Guided onboarding, step-by-step connection tests, model-list fetching, and (optionally encrypted) import/export of your configuration.

### 🛠️ Agentic Tools & Autonomous Workflows

- **Agentic tool calling** — The assistant reads files, searches your workspace, creates/edits files, and runs commands. **Write operations always require your explicit approval**; read-only operations run immediately. Batch-approve with one click.
- **Hunk-by-hunk review of AI edits** — *View Changes* in the File Changes sidebar opens a diff with review arrows beside every change block. Rejecting restores that block from the pre-edit snapshot and writes the file back (original encoding/BOM preserved, open editor buffers kept in sync); accepting only advances the comparison baseline and never touches disk. Each decision recomputes the remaining changes, so you don't have to revert the whole file.
- **Four agent modes** — `confirm_before_change`, `auto_edit`, `plan`, and `full_access` let you dial autonomy from strict confirmation to hands-free.
- **Plan mode & todos** — The assistant can propose a plan, maintain a task checklist, and ask you clarifying questions mid-task.
- **Subagents** — Built-in `code-reviewer`, `test-generator`, and `researcher` agents (customizable via `.ourcode/agents/*.md`) run delegated subtasks with monotonically-decreasing permissions, iteration/token budgets, and checkpoint rollback.
- **Skills** — Claude-Code-style `SKILL.md` discovery: skills in your workspace or user directory are exposed as read-only tools, and more can be installed from a skill registry.
- **Project rules** — `AGENTS.md` (workspace root, plus the per-directory ones along the file you are editing), `.ourcoderules`, `rules.json`, `RULES.md`, `.cursorrules`, and `.windsurfrules` are loaded into the prompt automatically, so a repo that already carries rules for another agent tool needs no migration.
- **Runaway protection** — a tool call repeated verbatim gets the model nudged out of the loop and, if it keeps spinning, the run stops with an explanation instead of burning tokens; tool calls whose arguments were cut off by `max_tokens` are refused rather than executed.
- **MCP support** — Connect MCP servers over stdio or HTTP (streamable) to extend the assistant with external tools, resources, and prompts, with automatic reconnection.
- **Native Git tools (Claude-Code style, zero config)** — Built-in `git_status` / `git_diff` / `git_log` / `git_branch` / `git_add` / `git_commit` / `git_push` tools work with **no MCP setup**: the agent can inspect changes, stage files per group (`git add` needs no approval), commit (`git commit` requires confirmation) and push (`git push` requires confirmation). Read-only git tools also work in plan mode — inspect the diff before proposing a plan. When the bundled git MCP is connected, its same-named tools are auto-hidden to avoid two overlapping sets.
- **Integrated browser session** — A sandboxed, http(s)-only page the assistant can drive: `browser_navigate`, `browser_read_console` (console output **and** uncaught page errors), `browser_screenshot`, and `browser_act` (click / type / press / scroll — approval-gated, since clicking can change remote state). This closes the loop the terminal never could: after a frontend change the model opens the dev server, reads what the page logged, and looks at a screenshot instead of guessing. The Browser panel mirrors the same session, so you see the console it sees and can pop the page into a real window (or log into something it cannot).
- **Pull requests, through your own `gh`** — `read_pull_request` (list / view with CI checks and review comments) and `create_pull_request` (create / comment, approval-gated). No account, no token stored by the app: it drives the GitHub CLI you already authenticated.
- **Bundled Git MCP (no Node required)** — The bundled git-server MCP runs on the IDE's own Node runtime (configure with `bundled-node` command and `bundled:` args; one-click add in Settings), so AI can inspect repo status, generate commit messages, commit and push even on machines without Node — only the `git` CLI needs to be installed.

### 📝 Code Editor & Workspace

- **Monaco-based editor** — Multi-tab editing, diff views, breadcrumbs, snippets, and minimap.
- **Large-file friendly** — Chunked streaming for big files, automatic encoding detection, and encoding/BOM-preserving writes.
- **Fast navigation** — File explorer, Quick Open (`Ctrl+P`), and a VS Code-style command palette (`Ctrl+Shift+P`).
- **Search & replace** — Whole-workspace search with case/whole-word/regex options, include/exclude patterns, and batch replace.
- **LSP diagnostics** — Per-language LSP servers (e.g. `pylsp` for Python) stream diagnostics into the Problems panel.
- **Crash recovery** — Hot-exit backups and automatic restore of unsaved buffers after an unexpected quit.

### 🖥️ Terminal & Git

- **Integrated terminal** — Full-featured xterm.js + node-pty terminal with multiple tabs, renaming, side-by-side split panes, and light/dark ANSI palettes.
- **The assistant's long-running tasks are visible** — A dev server or watcher the assistant starts with `run_command(background=true)` is a real integrated-terminal session owned by the main process: the panel opens an `AI: <command>` tab you can watch, or type into to answer a prompt, and closing that tab only detaches the view. The agent reads it with `read_terminal_output` and cleans up with `stop_terminal`, which can only stop runs the assistant started — and the child environment is credential-scrubbed like every other agent subprocess.
- **Git panel** — Status, diff, stage/unstage, commit, push/pull/fetch, stash, branch creation and log — plus **AI-generated commit messages** and a **Lifeguard** pre-commit review that flags potential bugs with error/warning/info severity. Committing takes exactly the files you staged (nothing is swept in behind your back), every operation reports its failure in a toast instead of the console, and conflicted files get their own section with an *abort merge* escape hatch.
- **Pull request section** — Lists the current branch's PR with its checks and review comments, opens one from the branch's own commits, and hands reviewer feedback to the assistant as a request. Backed by the locally installed `gh` (`gh auth login`); when it is missing or signed out the panel says so in one line instead of hiding the feature.

### 🧩 Extensibility & Customization

- **Sandboxed plugins** — Web-Worker plugins with a permission model; register commands through a manifest, with an in-app install/management UI.
- **Shortcut presets** — VS Code, JetBrains, or fully custom keybindings.
- **Theming** — Dark / light / system themes with a custom accent color.
- **Bilingual UI** — Chinese (zh-CN) and English (en-US).

### 🔒 Security & Privacy

- Filesystem access is restricted to an explicit allowlist (only folders you opened).
- **No off-origin navigation.** Every window is pinned to the app's own origins (`will-navigate` + `setWindowOpenHandler`): a stray link opens in your system browser, and anything that is neither the app nor a preview is refused — including `window.open()` from the HTML you preview. The browsed page in the browser session is http(s)-only, so a remote page cannot reach your workspace through the `ourcode-file://` preview scheme, and it loads without a preload bridge.
- **`git` / `gh` argument gate.** The exec channels accept an allowlisted subcommand only, and refuse `-c`, `--config`, `--exec-path`, `--git-dir`, `--work-tree`, `--output` and `ext::` transports — the shapes that let a git argument turn into arbitrary program execution or a write outside the workspace. `gh api` is not exposed.
- Strict Content-Security-Policy in the renderer.
- API keys encrypted with AES-256-GCM using a machine-bound key.
- Markdown rendered in chat is sanitized with DOMPurify.
- Local-first storage (SQLite) — your data stays on your machine, except for the API calls you configure.

### ⚙️ More

- **Usage analytics** — Per-model usage dashboard with stats for models, skills, subagents, and MCP tools.
- **Auto-update** — Seamless in-app updates via electron-updater.

## 🌐 Supported Providers

| Provider | Notes |
| --- | --- |
| OpenAI | Official API |
| Anthropic | Claude models |
| Google Gemini | Gemini models |
| DeepSeek | DeepSeek API |
| Groq | Groq cloud inference |
| Azure OpenAI | Azure-hosted OpenAI |
| Ollama | Local models via Ollama |
| Custom | Any OpenAI-compatible endpoint |

## 🧰 Tech Stack

- **Electron + electron-vite** — desktop shell and build tooling
- **React + TypeScript** — renderer UI
- **Tailwind CSS** — styling
- **Monaco Editor** — code editing
- **xterm.js + node-pty** — integrated terminal
- **better-sqlite3** — local storage
- **Zustand** — state management
- **Vitest / Playwright** — unit and e2e tests

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 20+ and npm
- (Windows quick start) you can use `dev.bat` / `run.bat` instead of the manual steps below

### Install

```bash
npm install
```

> `better-sqlite3` and `node-pty` are native modules. If you hit ABI mismatch errors when running under Electron, rebuild them with:
>
> ```bash
> npx electron-builder install-app-deps
> ```

### Run in development

```bash
npm run dev
```

### Quality checks

```bash
npm run typecheck   # TypeScript type check
npm run lint        # ESLint
npm test            # Vitest unit tests
npm run test:e2e    # Playwright e2e tests (npx playwright install first)
```

### Build & package

```bash
npm run build            # build for development preview
npm run dist:win         # Windows (nsis + portable)
npm run dist:mac         # macOS (dmg + zip)
npm run dist:linux       # Linux (AppImage + deb)
```

## ⚙️ Usage

1. Launch the app and complete the onboarding.
2. Open **Settings** → **API Config** and create an API group: pick a provider, paste your API key (optionally a base URL and custom headers), and set a default model.
3. Use **Preferences** to tweak behavior and **Shortcuts** to review keybindings.
4. Open a folder, then start a chat — the assistant can use agentic tools; write operations ask for your approval first, read-only operations run automatically.

## 📁 Project Structure

```
OurCode-ide/
├── electron/            # Main process (main.ts, preload.ts) & services
│   └── services/        # file-system, sqlite-store, crypto, backup, mcp-manager
├── src/                 # Renderer (React)
│   ├── components/      # ChatPanel, Editor, Sidebar, Terminal, Git, SearchPanel,
│   │                    # CommandPalette, Skills, Plugin, Settings...
│   ├── services/        # LLM clients/adapters, tools, skills, subagents, plugin, commands
│   ├── stores/          # Zustand stores (chat, editor, config, plugins, shortcuts...)
│   ├── hooks/           # Custom hooks
│   └── utils/           # Helpers (file icons, etc.)
├── shared/              # Types & constants shared between main and renderer
├── e2e/                 # Playwright end-to-end tests
└── tools/               # CLI helpers (create-nebula-plugin)
```

## 🔌 Plugin Development

Plugins are sandboxed in Web Workers and declare their capabilities via a manifest with explicit permissions:

```jsonc
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "main": "index.js",
  "permissions": ["editor.read", "file.write"]
}
```

Enforced permissions — each maps to a whitelist of callable APIs: `editor.read`, `editor.write`, `file.read`, `file.write`, `ai.chat`, `ui.panel`, `ui.statusbar`. The manifest also accepts `ai.completion`, `terminal.read`, `terminal.write`, and `network`, but those currently grant no APIs.

Plugins reach the command palette by calling `api.commands.register` at runtime; those commands merge into the unified command registry. The declarative `contributes` block is only summarized on the plugin's card — the host does not yet register commands, keybindings, panels, or status-bar items from it, and panels/status-bar items registered at runtime have no surface to render into yet.

## 🔐 Security

- A folder has to be trusted before it is used. An untrusted folder is neither read nor written, and the MCP servers it declares (`mcp_config.json` / `.mcp.json`) are never started. Every `fs:*` IPC handler re-validates the path against the trusted roots, resolving symlinks so a link inside a workspace cannot point outside it; trust is granted only through a native dialog the main process itself opens.
- MCP servers that don't ship inside the app package need your approval on every tool call.
- Strict Content-Security-Policy in the renderer.
- API keys are stored encrypted (AES-256-GCM) under a key derived from this machine's id plus a fixed salt. That keeps a copied database file from revealing them, and nothing more — anything running as your user can redo the same derivation.
- Chat transcripts, tool outputs and the model wire log are plaintext in the app's data directory.
- Markdown rendered in chat is sanitized with DOMPurify.

## 📄 License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — free to use, modify, and distribute for any **noncommercial purpose**, including personal research, study, education, hobby projects, and use by noncommercial organizations (charities, educational institutions, public research organizations, and government institutions).

**Commercial use is not permitted.** If you'd like to use OurCode IDE for commercial purposes, please contact the author for a separate license.

See [LICENSE](./LICENSE) for the full terms.
