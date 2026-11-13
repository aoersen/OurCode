---
name: ui-self-test
description: 对客户 Web 项目做自动化 UI 自测：启动服务、用 Playwright MCP 浏览器工具打开页面、点击/输入/读取快照逐项验证功能，输出通过/失败测试报告
---

# 浏览器 UI 自测（ui-self-test）

用浏览器操作工具对工作区内的 **Web 项目** 做端到端界面自测：
真实打开页面 → 点击、输入、提交 → 读取页面快照验证结果 → 输出报告。
**不修改被测源码**，只验证行为。

## 前置条件

1. **确认目标**：`target`（网页入口，如 `app/index.html`、`dist/index.html`、`src/...`）。
   未指定时，在工作区中查找 `index.html` / `package.json` 的 dev/build 产物。
2. **确认浏览器工具可用**：两条路任选其一。
   - **内置浏览器**（IDE 已有，无需额外安装）：`browser_navigate` / `browser_snapshot` / `browser_act` /
     `browser_read_console` / `browser_screenshot`。`browser_act` 发送真实 CDP 鼠标/键盘/滚轮事件，
     支持 `ref`（优先）、`selector`、`x/y`（CSS 视口像素）、`hover`、`drag`、`scroll`（`delta_x`/`delta_y`
     或 `direction`）、`click_count` 与按键和弦（如 `Control+a`）。坐标先用 `browser_screenshot`
     （返回视口与图像尺寸）定位；坐标点选 canvas/iframe 内容时尤其有用（快照只覆盖顶层帧）。
   - **Playwright MCP**：`browser_click`、`browser_type`、`browser_snapshot`、`browser_take_screenshot`
     （来自 `@playwright/mcp`，工作区 `mcp_config.json` 配置，参考 `examples/ui-self-test-demo/mcp_config.json`）。
   - 两条路都没有时，向用户说明如何启用（见 `docs/BROWSER_SELF_TEST.md`），不要硬试。
3. **确定验收依据**：优先读取工作区中的测试计划 / 需求清单（如 `EXPECTED.md`、
   `TEST_PLAN.md`、README 的功能说明）；没有则基于页面实际功能自行归纳待验证项，
   并**先向用户确认范围**。

## 执行步骤

1. **启动服务**（页面需用 URL 打开时）：
   - 用 `run_command` 启动静态服务，如 `npx serve <target目录>`、
     `python -m http.server <端口> -d <目录>`，或项目自带 dev server。
   - 注意 `@playwright/mcp` 默认屏蔽 `file://`，一律通过 http 服务访问页面。
   - 等待服务就绪（轮询 HTTP 状态或固定等待）。
2. **打开页面并建立基线**：`browser_navigate` 打开入口 → `browser_snapshot`
   读取可访问性快照，确认页面结构（导航、表单、列表、按钮）。
3. **逐项验证**：按验收清单逐条执行，每条遵循「操作 → 断言」闭环：
   - 操作：内置浏览器用 `browser_act`（`click` / `type` / `hover` / `drag` / `scroll`）；
     Playwright MCP 用 `browser_click`、`browser_type`、`browser_select` 等。
   - 断言：**以 `browser_snapshot` 的实际 DOM 状态为准**（元素文本、可见性、
     计数、样式类、`aria` 属性），不要只凭 URL 或想当然；运行时错误看
     `browser_read_console`。
   - 关键路径（提交、删除、切换）操作后必须重新 `browser_snapshot` 确认结果。
4. **失败排查**：失败时用 `browser_take_screenshot` 留证，并区分「测试操作方式不对」
   还是「被测功能确实有 bug」：前者换一种可访问的操作方式重试；后者记录为失败项。
5. **清理**：自测完成后关闭浏览器（`browser_close`），如需保留截图先保存路径。

## 规则

- **不修改被测源码**；确需修改时先向用户说明并获得同意。
- 优先使用语义化/可访问的选择方式（按钮文本、label、aria-label）定位元素。
- 每个用例要独立可复现：操作前先恢复已知状态（如刷新页面 / 清空输入）。
- 被测应用有持久化（localStorage/DB）时，注意用例间的状态污染，必要时先清理。
- 网络依赖的应用（登录、外部 API）若环境不可达，明确标注「跳过（环境限制）」。
- 测试用的临时脚本/服务进程用 `run_command` 清理，不留残留。

## 完成判定

- 验收清单每条给出 通过 / 失败 / 跳过(原因)。
- 失败项附 `browser_take_screenshot` 截图与根因分析（测试操作问题 or 被测 bug）。
- 输出汇总：通过 X / 共 Y，以及遗留失败项清单。
