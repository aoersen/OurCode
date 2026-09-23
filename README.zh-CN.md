# OurCode IDE

[![CI](https://github.com/aoersen/OurCode/actions/workflows/ci.yml/badge.svg)](https://github.com/aoersen/OurCode/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/aoersen/OurCode)](https://github.com/aoersen/OurCode/releases)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](./LICENSE)

基于 Electron 的桌面 AI 代码编辑器：支持多种大模型提供商、带人工确认的智能体工具，以及可编辑的对话历史。

[English Documentation](./README.md)

## 功能

### AI 助手与对话

- 流式回复，思考块（Thinking）实时渲染；聊天中的 Markdown 经 DOMPurify 消毒后展示。
- 对话历史可编辑：修改、删除或从任意一条消息重新生成，支持拖拽排序与批量删除。
- 可从任意消息分支出新会话，也可在竞技场（Arena）中让多个模型并行回答同一提示词。
- 项目记忆（可开关）、图片输入（工具栏按钮、`Ctrl+V` 粘贴、拖拽，过大图片在本地缩放并重新编码）、可复用工作流模板。

### 模型提供商

- OpenAI、Anthropic、Google Gemini、DeepSeek、Groq、Azure OpenAI、Ollama，以及任意 OpenAI 兼容接口。
- 多 API 分组：每组独立配置颜色标签、自定义请求头与传输格式覆盖（`openai` / `responses` / `anthropic` / `azure` / `ollama`）。
- 引导式配置：分步连接测试、自动拉取模型列表、可加密的配置导入导出。

### 智能体工具

- 助手可读取文件、搜索工作区、编辑文件、执行命令。写操作需显式批准，只读操作立即执行，支持一键批量审批。
- AI 改动可在 Diff 视图逐块审查，接受或拒绝每个改动块。
- 四种 Agent 模式：`confirm_before_change`、`auto_edit`、`plan`、`full_access`。
- 计划模式：助手先提出计划、维护任务清单，并可在任务中途向你提问。
- 内置子智能体 `code-reviewer`、`test-generator`、`researcher`，可用 `.ourcode/agents/*.md` 自定义；以权限递减、迭代/Token 预算与 checkpoint 回滚方式执行。
- 技能系统：类 Claude Code 的 `SKILL.md` 发现机制，按需以只读工具加载。
- 自动加载项目规则：`AGENTS.md`、`.ourcoderules`、`rules.json`、`RULES.md`、`.cursorrules`、`.windsurfrules`，已有规则的项目无需迁移。
- 防空转：完全相同参数的重复调用先提醒，仍打转则停止运行并说明原因；被 `max_tokens` 截断的调用拒绝执行。
- MCP：支持 stdio 与 HTTP（streamable）连接，断线自动重连。
- 原生 git 工具（`git_status` / `git_diff` / `git_log` / `git_branch` / `git_add` / `git_commit` / `git_push`），零配置、无需 MCP；提交与推送需确认。
- 内置浏览器会话：仅限 http(s)，提供 `browser_navigate`、`browser_read_console`、`browser_screenshot`、`browser_act`（需审批），与「浏览器」面板镜像同一会话。
- PR 走本机已登录的 `gh` CLI：`read_pull_request`、`create_pull_request`，应用不存储账号或令牌。
- 内置 git MCP 使用 IDE 自带 Node 运行时启动，无 Node 环境的机器也能用。
- 配合 Playwright MCP 可对 Web 项目做浏览器 UI 自测（`ui-self-test` 技能），见 [docs/BROWSER_SELF_TEST.md](docs/BROWSER_SELF_TEST.md)。

### 编辑器与工作区

- 基于 Monaco：多标签、Diff 视图、面包屑、Snippet、minimap。
- 大文件分块流式加载，写入保留原编码与 BOM。
- 文件浏览器、快速打开（`Ctrl+P`）、命令面板（`Ctrl+Shift+P`）、工作区全文搜索与批量替换。
- 按语言启用 LSP 诊断（如 Python 的 `pylsp`），结果汇入 Problems 面板。
- hot-exit 崩溃恢复，意外退出后恢复未保存的缓冲区。

### 终端与 Git

- xterm.js + node-pty 集成终端：多标签、左右分屏、深浅色 ANSI 配色。
- 助手用 `run_command`（`background=true`）启动的 dev server / watch 会以 `AI: <命令>` 标签出现在终端面板，助手通过 `read_terminal_output` 读输出、`stop_terminal` 停止。
- Git 面板：状态、Diff、暂存、提交、Push/Pull、日志；支持 AI 生成提交信息与 Lifeguard 提交前预检。

### 扩展与定制

- 插件运行于 Web Worker 沙箱，通过权限清单声明能力，内置安装管理界面。
- VS Code / JetBrains 快捷键预设，自定义主题，中英双语界面。

### 其他

- 按模型、技能、子智能体、MCP 工具分级的用量统计。
- 基于 electron-updater 的应用内自动更新。

## 支持的提供商

| 提供商 | 说明 |
| --- | --- |
| OpenAI | 官方 API |
| Anthropic | Claude 系列模型 |
| Google Gemini | Gemini 系列模型 |
| DeepSeek | DeepSeek API |
| Groq | Groq 云端推理 |
| Azure OpenAI | Azure 托管的 OpenAI |
| Ollama | 通过 Ollama 运行本地模型 |
| Custom | 任意 OpenAI 兼容接口 |

## 安装

预构建安装包见 [Releases](https://github.com/aoersen/OurCode/releases)。

从源码运行需要 [Node.js](https://nodejs.org) 20+ 与 npm：

```bash
npm install
npm run dev
```

`better-sqlite3` 与 `node-pty` 是原生模块，若在 Electron 下出现 ABI 不匹配错误，重新构建即可：

```bash
npx electron-builder install-app-deps
```

Windows 下也可直接用 `dev.bat` / `run.bat` 代替上面的手动步骤。

## 使用说明

1. 启动应用并完成引导。
2. 在 **设置 → API 配置** 中创建 API 分组：选择提供商、填入 API Key（可选填写 Base URL 与自定义请求头）、设置默认模型。Base URL 支持 `http://` 与 `https://`；内网网关使用自签名 / 私有 CA 证书时可勾选「跳过证书校验」。所有 API 与 MCP 请求均由主进程代理发出，不受浏览器 CORS 限制。
3. 在 **偏好设置** 中调整行为，在 **快捷键** 中查看键位。
4. 打开文件夹开始对话。写操作会先征求批准，只读操作自动执行。

## 开发

```bash
npm run typecheck   # TypeScript 类型检查
npm run lint        # ESLint
npm test            # Vitest 单元测试
npm run test:e2e    # Playwright 端到端测试（需先 npx playwright install）
```

构建与打包：

```bash
npm run build            # 构建（开发预览用）
npm run dist:win         # Windows（nsis + portable）
npm run dist:mac         # macOS（dmg + zip）
npm run dist:linux       # Linux（AppImage + deb）
```

## 插件开发

插件运行于 Web Worker 沙箱，通过清单声明权限：

```jsonc
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "main": "index.js",
  "permissions": ["editor.read", "file.write"]
}
```

生效的权限：`editor.read`、`editor.write`、`file.read`、`file.write`、`ai.chat`、`ui.panel`、`ui.statusbar`。（`ai.completion`、`terminal.read`、`terminal.write`、`network` 在清单中可声明，但暂不对应任何 API。）

插件在运行时通过 `api.commands.register` 注册命令，并入统一命令注册表。详见 [docs/EXTENSIONS_ARCHITECTURE.md](docs/EXTENSIONS_ARCHITECTURE.md)。

## 安全

- 文件夹须先被信任才会被读写，其声明的 MCP 服务（`mcp_config.json` / `.mcp.json`）也只在信任后启动。所有 `fs:*` IPC 处理会对照可信根重新校验路径并解析符号链接，工作区内的链接无法指向工作区之外；信任只能通过主进程弹出的原生确认框授予。
- 非应用自带的 MCP 服务，每次工具调用都需逐次批准。
- 窗口固定于应用自身源：外部链接交给系统浏览器打开，内置浏览器会话仅限 http(s) 页面，且不加载 preload 桥。
- `git` / `gh` 执行通道只接受白名单子命令，拒绝 `-c`、`--config`、`--exec-path`、`--git-dir`、`--work-tree`、`--output` 与 `ext::` 传输——这些正是可借 git 参数执行任意程序的形态；不暴露 `gh api`。
- 渲染进程使用严格的 Content-Security-Policy。
- API Key 用 AES-256-GCM 加密存储，密钥与本机绑定。这只能防止数据库文件被拷走后泄露密钥——以你的用户身份运行的程序可以做同样的派生。
- 聊天记录、工具输出与模型请求日志以明文存放在应用数据目录。
- 聊天中的 Markdown 经 DOMPurify 消毒后渲染。

## 项目结构

```
OurCode-ide/
├── electron/            # 主进程（main.ts、preload.ts）与服务
│   └── services/        # file-system、sqlite-store、crypto、backup、mcp-manager
├── src/                 # 渲染进程（React）
│   ├── components/      # ChatPanel、Editor、Terminal、Git、Settings 等
│   ├── services/        # LLM 客户端/适配器、工具、技能、子智能体、插件
│   ├── stores/          # Zustand 状态（chat、editor、config、plugins、shortcuts）
│   └── hooks/           # 自定义 Hook
├── shared/              # 主进程与渲染进程共享的类型与常量
├── e2e/                 # Playwright 端到端测试
└── tools/               # CLI 工具（create-nebula-plugin）
```

## 文档

- [docs/EXTENSIONS_ARCHITECTURE.md](docs/EXTENSIONS_ARCHITECTURE.md) — 插件与扩展架构
- [docs/BROWSER_SELF_TEST.md](docs/BROWSER_SELF_TEST.md) — 配合 Playwright MCP 的浏览器 UI 自测
- [examples/ui-self-test-demo](examples/ui-self-test-demo) — 可运行示例

## 许可证

[PolyForm Noncommercial License 1.0.0](./LICENSE)。任何非商业目的——个人研究、学习、教育、业余项目，以及慈善机构、教育机构、公共研究机构、政府机构等非商业组织——均可自由使用、修改和分发。

禁止商业使用，商业用途需联系作者单独授权。完整条款见 [LICENSE](./LICENSE)。

## 参与贡献

欢迎提交 issue 与 pull request。提交改动前请先运行 `npm run typecheck && npm run lint && npm test`。
