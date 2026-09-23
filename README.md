# OurCode IDE

[![CI](https://github.com/aoersen/OurCode/actions/workflows/ci.yml/badge.svg)](https://github.com/aoersen/OurCode/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/aoersen/OurCode)](https://github.com/aoersen/OurCode/releases)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](./LICENSE)

A desktop AI code editor built with Electron: multiple LLM providers, agentic tools with human-in-the-loop approvals, and editable chat history.

[中文文档](./README.zh-CN.md)

## Features

### AI assistant & chat

- Streaming responses with thinking blocks rendered in real time; chat Markdown is sanitized with DOMPurify.
- Editable history: edit, delete, or regenerate from any message; drag to reorder or batch-delete.
- Fork a conversation from any message, or compare several models on the same prompt in the Arena.
- Project memory (toggleable), image input (toolbar button, `Ctrl+V`, drag-and-drop; oversized images are downscaled and re-encoded locally), and reusable prompt workflow templates.

### Providers

- OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, Azure OpenAI, Ollama, and any OpenAI-compatible endpoint.
- Multiple API groups, each with its own color label, custom headers, and wire-format override (`openai` / `responses` / `anthropic` / `azure` / `ollama`).
- Onboarding with step-by-step connection tests, model-list fetching, and optionally encrypted config import/export.

### Agents & tools

- The assistant reads files, searches the workspace, edits files, and runs commands. Write operations require explicit approval; read-only operations run immediately, with one-click batch approval.
- Review AI edits hunk by hunk in a diff view; accept or reject each block individually.
- Four agent modes: `confirm_before_change`, `auto_edit`, `plan`, `full_access`.
- Plan mode with task lists and mid-task clarifying questions.
- Built-in subagents `code-reviewer`, `test-generator`, and `researcher`, customizable via `.ourcode/agents/*.md`, running with decreasing permissions, iteration/token budgets, and checkpoint rollback.
- Skills via Claude-Code-style `SKILL.md` discovery, loaded on demand as read-only tools.
- Project rules from `AGENTS.md`, `.ourcoderules`, `rules.json`, `RULES.md`, `.cursorrules`, and `.windsurfrules` are loaded into the prompt automatically.
- Loop protection: a verbatim repeated tool call gets a warning, then the run stops with an explanation; calls truncated by `max_tokens` are refused.
- MCP servers over stdio or HTTP (streamable), with automatic reconnection.
- Native git tools (`git_status` / `git_diff` / `git_log` / `git_branch` / `git_add` / `git_commit` / `git_push`) with no MCP setup; commit and push require confirmation.
- Built-in browser session for the assistant, restricted to http(s): `browser_navigate`, `browser_read_console`, `browser_screenshot`, `browser_act` (approval-gated), mirrored in the Browser panel.
- Pull requests through your locally authenticated `gh` CLI: `read_pull_request`, `create_pull_request`. The app stores no account or token.
- Bundled git MCP server runs on the IDE's own Node runtime, for machines without Node installed.
- Browser UI self-testing with Playwright MCP (`ui-self-test` skill); see [docs/BROWSER_SELF_TEST.md](docs/BROWSER_SELF_TEST.md).

### Editor & workspace

- Monaco-based editor with tabs, diff views, breadcrumbs, snippets, and minimap.
- Large files load in chunks; writes preserve the original encoding and BOM.
- File explorer, Quick Open (`Ctrl+P`), command palette (`Ctrl+Shift+P`), and workspace search with batch replace.
- Per-language LSP diagnostics (e.g. `pylsp` for Python) in the Problems panel.
- Hot-exit crash recovery restores unsaved buffers.

### Terminal & git

- xterm.js + node-pty terminal with tabs, split panes, and light/dark palettes.
- Long-running assistant commands (`run_command` with `background=true`) appear as `AI: <command>` terminal tabs; the assistant reads them with `read_terminal_output` and stops them with `stop_terminal`.
- Git panel with status, diff, staging, commit, push/pull, and log; AI-generated commit messages and a Lifeguard pre-commit review.

### Extensibility

- Plugins in Web Worker sandboxes with a permission manifest and an in-app installer.
- VS Code or JetBrains keybinding presets, custom themes, and a Chinese/English UI.

### Other

- Per-model usage dashboard, broken down by models, skills, subagents, and MCP tools.
- In-app auto-update via electron-updater.

## Supported providers

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

## Install

Prebuilt packages are on the [releases page](https://github.com/aoersen/OurCode/releases).

To run from source you need [Node.js](https://nodejs.org) 20+ and npm:

```bash
npm install
npm run dev
```

`better-sqlite3` and `node-pty` are native modules. If you get ABI mismatch errors under Electron, rebuild them:

```bash
npx electron-builder install-app-deps
```

On Windows you can also use `dev.bat` / `run.bat` instead of the manual steps.

## Usage

1. Launch the app and complete the onboarding.
2. In **Settings → API Config**, create an API group: pick a provider, paste your API key, optionally set a base URL and custom headers, and choose a default model. Base URLs may use `http://` or `https://`; enable "Skip certificate verification" for internal gateways with self-signed or private CA certificates. All API and MCP requests are proxied through the main process, so there is no browser CORS restriction.
3. Adjust behavior in **Preferences** and review keybindings in **Shortcuts**.
4. Open a folder and start a chat. Write operations ask for approval first; read-only operations run automatically.

## Development

```bash
npm run typecheck   # TypeScript type check
npm run lint        # ESLint
npm test            # Vitest unit tests
npm run test:e2e    # Playwright e2e tests (npx playwright install first)
```

Build and package:

```bash
npm run build            # build for development preview
npm run dist:win         # Windows (nsis + portable)
npm run dist:mac         # macOS (dmg + zip)
npm run dist:linux       # Linux (AppImage + deb)
```

## Plugins

Plugins run in a Web Worker sandbox and declare permissions in a manifest:

```jsonc
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "main": "index.js",
  "permissions": ["editor.read", "file.write"]
}
```

Enforced permissions: `editor.read`, `editor.write`, `file.read`, `file.write`, `ai.chat`, `ui.panel`, `ui.statusbar`. (`ai.completion`, `terminal.read`, `terminal.write`, and `network` are accepted in manifests but currently grant no APIs.)

Plugins register commands at runtime with `api.commands.register`; those commands merge into the unified command registry. See [docs/EXTENSIONS_ARCHITECTURE.md](docs/EXTENSIONS_ARCHITECTURE.md).

## Security

- A folder must be trusted before it is read or written, and before the MCP servers it declares (`mcp_config.json` / `.mcp.json`) are started. Every `fs:*` IPC handler re-validates the path against the trusted roots and resolves symlinks, so a link inside a workspace cannot point outside it. Trust is granted only through a native dialog opened by the main process.
- MCP servers that don't ship with the app require approval on every tool call.
- Windows are pinned to the app's own origins: external links open in the system browser, and the built-in browser session is limited to http(s) pages, which load without a preload bridge.
- The `git` / `gh` exec channels accept an allowlisted subcommand only and refuse `-c`, `--config`, `--exec-path`, `--git-dir`, `--work-tree`, `--output`, and `ext::` transports, the shapes that can turn a git argument into arbitrary program execution. `gh api` is not exposed.
- Strict Content-Security-Policy in the renderer.
- API keys are stored encrypted with AES-256-GCM under a machine-bound key. This protects a copied database file, and nothing more: anything running as your user can redo the same derivation.
- Chat transcripts, tool outputs, and the model wire log are stored in plaintext in the app data directory.
- Markdown rendered in chat is sanitized with DOMPurify.

## Project structure

```
OurCode-ide/
├── electron/            # Main process (main.ts, preload.ts) & services
│   └── services/        # file-system, sqlite-store, crypto, backup, mcp-manager
├── src/                 # Renderer (React)
│   ├── components/      # ChatPanel, Editor, Terminal, Git, Settings, ...
│   ├── services/        # LLM clients/adapters, tools, skills, subagents, plugins
│   ├── stores/          # Zustand stores (chat, editor, config, plugins, shortcuts)
│   └── hooks/           # Custom hooks
├── shared/              # Types & constants shared between main and renderer
├── e2e/                 # Playwright end-to-end tests
└── tools/               # CLI helpers (create-nebula-plugin)
```

## Docs

- [docs/EXTENSIONS_ARCHITECTURE.md](docs/EXTENSIONS_ARCHITECTURE.md) — plugin and extension architecture
- [docs/BROWSER_SELF_TEST.md](docs/BROWSER_SELF_TEST.md) — browser UI self-testing with Playwright MCP
- [examples/ui-self-test-demo](examples/ui-self-test-demo) — runnable example

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE). Free to use, modify, and distribute for any noncommercial purpose: personal research, study, education, hobby projects, and use by noncommercial organizations (charities, educational institutions, public research organizations, government institutions).

Commercial use is not permitted; contact the author for a separate license. See [LICENSE](./LICENSE) for the full terms.

## Contributing

Issues and pull requests are welcome. Run `npm run typecheck && npm run lint && npm test` before submitting changes.
