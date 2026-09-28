# Aioli MCP Server（内置）

本目录是从 [jaredhd/aioli](https://github.com/jaredhd/aioli)（MIT 协议）vendored 的 MCP 服务器，配合本仓库 `node_modules/aioli-design` 使用，**运行完全离线**（不需要网络，不需要 API key）。

## 为什么 vendored

`aioli-design` 的 npm 包（0.7.0）不含 `mcp-server/` 目录（`files` 列表未收录），只有 GitHub 仓库有。为了让 IDE 的 AI 在**内网 / 离线环境**也能用 aioli MCP 工具设计 UI，我们把服务器源码复制进仓库并做了两处适配：

1. **相对导入改指本地包**：`../agents/…`、`../lib/…` 改为 `../../node_modules/aioli-design/agents/…`、`../../node_modules/aioli-design/lib/…`；`tokens` 与 `projectRoot` 路径同样指向 `node_modules/aioli-design/`。
2. **日志重定向**：aioli 库启动时会用 `console.log` 打印横幅（如 `🎨 Design Token Agent: Loaded N tokens`），会污染 stdio 的 JSON-RPC 流。我们在初始化前把 `console.log` 重定向到 stderr，stdout 只输出 MCP 消息。

## 运行要求

- 本机 Node（≥ 20），且已执行 `npm install`（`aioli-design` 在 devDependencies 中，其依赖 `@modelcontextprotocol/sdk`、`zod` 随之安装）。
- 服务器暴露 16 个工具：`generate_component`、`generate_page`、`list_components`、`list_style_modifiers`、`list_themes`、`get_theme_css`、`derive_palette`、`get_tokens`、`resolve_token`、`check_contrast`、`validate_accessibility`、`review_code`、`derive_brand_theme`、`suggest_harmonies`、`validate_theme`、`import_theme`。

## 在 mcp_config.json 中启用

```json
{
  "mcpServers": {
    "aioli": {
      "command": "node",
      "args": ["mcp-servers/aioli-mcp/index.js"],
      "env": {}
    }
  }
}
```

## 升级

固定对应 `aioli-design@0.7.0`。升级时：

1. `npm i -D aioli-design@<新版本>`
2. 从 GitHub 对应 tag 取 `mcp-server/index.js` 覆盖本目录 `index.js`
3. 重新应用上述两处适配（相对导入 + 日志重定向）
4. 跑冒烟测试：`node mcp-servers/aioli-mcp/smoke-test.mjs`（校验握手、16 个工具、token 解析、组件生成、stdout 无杂行）

若升级后 vendored 文件与新包内部结构不兼容（相对导入报错），可临时移除 mcp_config.json 中的 aioli 条目，用 CLI/SDK 替代（见 docs/aioli-design-system.md）。
