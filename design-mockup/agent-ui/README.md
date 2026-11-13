# Agent UI · 四版界面方向（agent-ui 分支样稿）

> **筛选请开 [index.html](./index.html)**——已升级为两轮 11 版总览页（第一轮手写 v1–v4 +
> Stitch 云端 A–G，含新增的 E 检查点时间线 / F 规格三段式 / G 暗色指挥舱）。
> Stitch 各稿详情见 [stitch/](./stitch/README.md)。

> 目标：把项目从「IDE + 聊天侧栏」改成「Agent 主画布」。
> 本轮只出壳与信息架构样稿，不改 agent 运行时（循环、工具、权限、checkpoint、claw 桥保持原样）。
> 视觉不另起一套：沿用当前项目的 Glass Light 画布、`#0058BC` 主色、玻璃卡片、Plus Jakarta Sans / JetBrains Mono。

## 先看哪个

打开 **[index.html](./index.html)**（对比索引页），四版缩略图、差异表与推荐组合都在里面。
每版是 1440 × 900 的独立 HTML，可直接在浏览器打开；同目录 `shots/*.png` 是渲染截图。

| # | 样稿 | 一句话 | 参考对象 |
| --- | --- | --- | --- |
| 01 | [任务驾驶舱](./v1-mission-control.html) | 首页 = 派发任务 + 并行 Agent 进度 + 审批收件箱 | Devin 首页 / Manus 任务列表 / Linear Inbox |
| 02 | [画布流](./v2-canvas-stream.html) | 对话是唯一主画布，计划 / diff / 预览内联在消息流 | ChatGPT Canvas / Claude Artifacts |
| 03 | [调度看板](./v3-agent-board.html) | 三列任务流 + 详情抽屉，面向多 Agent 并行 | Linear 看板 / Devin / 「一人公司」 |
| 04 | [协作分屏](./v4-agent-split.html) | 左对话常驻 + 右代码/终端 + 顶部变更审查条 | Cursor Composer / Windsurf Cascade / Zed Agent |

渲染截图：`shots/v1-mission-control.png` … `shots/v4-agent-split.png`。

## 四版分别在解决什么

### 01 任务驾驶舱（Agent 首页）
打开应用先看到「3 个 Agent 在干什么、哪 2 件事等我拍板」，而不是一个空编辑器。
- 结构：图标栏 + 主区（问候 / 大 composer / 3 张运行卡 / 最近完成）+ 右侧 352px 审批与产物栏。
- 适合：日常入口、管理者视角、多项目并行。
- 代价：需要任务与审批的结构化数据；点进任务后仍要一个工作区。

### 02 画布流（对话即工作台）
把运行过程收进消息流：执行计划 stepper、diff 卡、测试结果、实时预览都以「产物卡」形式内联。
- 结构：会话栏 256 + 860px 居中阅读列 + 52px 工具边栏；没有常驻右栏。
- 适合：长任务审阅、非工程用户、需要「读一遍就懂」的场景。
- 代价：内联产物的滚动、展开与状态管理复杂；多任务切换要回会话栏。

### 03 调度看板（多 Agent 编排）
把 Agent 当「员工」调度：已排队 / 进行中 / 待审阅三列，右侧抽屉看计划、变更、审批与补充指令。
- 结构：228px 导航 + 看板主区 + 372px 任务抽屉。
- 适合：一人公司、多 Agent 并行、需要验收队列。
- 代价：需要任务队列、Agent 分配与优先级模型；单任务场景会显得重。

### 04 协作分屏（最平滑迁移）
保留 IDE 用户的心智：左边永远有 Agent，右边永远有代码与终端；Agent 的改动先进入「待接受」状态。
- 结构：56px 图标栏 + 500px 对话 + 剩余宽度工作区（tab / 审查条 / 编辑器 / 终端）。
- 适合：现有 IDE 用户、边聊边改、需要实时看 diff 与测试输出。
- 代价：1024px 以下需要把对话折叠成抽屉；右侧信息密度高。

## 推荐

**不必只选一版。** 建议按「一个产品、多个模式」组合：

```
V1 驾驶舱（启动首页）
      ↓ 进入任务
V4 协作分屏（默认工作区） ──↔── V3 调度看板（多 Agent 时）
      ↓
V2 画布流（专注审阅模式）
```

- 如果只能先落一版：**V4**。迁移成本最低，现有 `MainLayout` 的三栏结构可以渐进替换，不要求先做任务模型。
- 如果目标是「看起来就是 Agent 产品」：**V2**。对话优先最彻底，但需要先定义 run / artifact 的数据结构。
- V1 与 V3 依赖同一套任务 / 审批数据，适合在 V4 稳定后再上。

## 视觉 token（与当前项目一致）

| 用途 | 值 | 现有变量 |
| --- | --- | --- |
| 画布底色 | `#F6F7FB` + 四角柔和渐变光斑 | `--bg` |
| 玻璃面板 | `rgba(255,255,255,.72)` + `blur(20px) saturate(180%)` | `--card` / `.glass-chrome` |
| 主色 | `#0058BC` | `--accent` |
| 主色浅底 | `#E8F0FF` | `--primary-container` |
| 正文 / 次级 / 弱化 | `#0F172A` / `#334155` / `#64748B` | `--text-primary/secondary/muted` |
| 描边 | `rgba(15,23,42,.08)` | `--border` |
| 成功 / 警告 / 错误 | `#16A34A` / `#D97706` / `#DC2626` | `--success/warning/error` |
| 字体 | Plus Jakarta Sans；代码 JetBrains Mono | 项目已 vendored |
| 圆角 / 阴影 | 16px 面板、13px 卡片、柔和低对比阴影 | `--radius` / `--shadow-*` |

没有引入新的硬编码色板；样稿里的颜色都来自 `src/styles/global.css` 的现有 token。

## 文件

```
design-mockup/agent-ui/
  index.html                  # 对比索引页
  v1-mission-control.html     # 01 任务驾驶舱
  v2-canvas-stream.html       # 02 画布流
  v3-agent-board.html         # 03 调度看板
  v4-agent-split.html         # 04 协作分屏
  shared.css                  # 共享 token / 玻璃组件 / 代码 diff 样式
  sprite.js                   # 内联 SVG 图标
  shot.mjs                    # Playwright 截图脚本
  shots/*.png                 # 1440×900 渲染结果
```

## 复现截图

```bash
cd OurCode-ide/design-mockup/agent-ui
node shot.mjs                 # 渲染全部 v*.html
node shot.mjs v4-agent-split.html   # 只渲染某一版
```

脚本使用系统 Chrome（`channel: 'chrome'`），不需要额外下载 Playwright 浏览器。

## 下一步（选版后）

1. 选定方向与组合方式，先做 1 个壳的 P0（静态布局 + 真实数据只读接入）。
2. 把「运行状态」收口成一个 `RunTimeline` 数据模型：`run → steps[] → artifacts[]`，再分别渲染成 V1 卡片 / V2 内联卡 / V3 看板卡 / V4 步骤条。
3. composer 统一成一个组件，`hero` 与 `inline` 两种 variant；模型、权限、上下文环只出现在 composer 内。
4. 验收：1440 / 1280 / 1024 三档不破版；键盘可达；正文对比度 ≥ 4.5:1、控件 ≥ 3:1；`prefers-reduced-motion` 下关闭 pulse / spinner 以外的动效。

> 说明：本会话未暴露 Stitch MCP 工具，因此没有走云端出图，而是直接用项目现有 token 写高保真 HTML 原型；好处是颜色、字体、圆角与现有代码 1:1 对齐，后续可直接作为实现参考，也方便你在浏览器里点开对比。
