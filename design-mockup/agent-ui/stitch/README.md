# Agent UI · Stitch 云端样稿（7 方案，2026-11-10）

> 本目录是 agent-ui 分支的第二轮样稿，用 **Google Stitch** 云端生成（第一轮 [../](../README.md) 的
> v1–v4 是本地手写 HTML）。两轮方向高度互补：同一套项目 token（Glass Light / `#0058BC` /
> Plus Jakarta Sans / JetBrains Mono / 16px 玻璃卡片），不同的构图诠释，放在一起筛。
>
> Stitch 项目：`projects/7782445583613816394`（OurCode Agent UI · agent-ui 分支样稿），
> 在 Stitch 网页端打开可继续 Edit / Variants 迭代。
> A–D 为上午批次；**E/F/G 为下午补方向批次**（检查点时间线 / 规格三段式 / 暗色指挥舱），
> 屏幕资源名：E `screens/74339890bd5945ee9a8d7d36af7db193`、F `screens/e9f957d1faa744a88e4c411f3510e09e`、
> G `screens/df82094a559445c1a8975461f38cf0f6`。

## 七张稿

| 方案 | 文件 | 架构一句话 | 参考对象 | 与第一轮的对应 |
| --- | --- | --- | --- | --- |
| A 对话驾驶舱 | [方案A-对话驾驶舱](./方案A-对话驾驶舱.png) / [.html](./方案A-对话驾驶舱.html) | 会话栏 + 720px 对话主流（RUN 时间线 / 审批卡内联）+ 右侧「实时工作区」（变更 diff / 终端 / 预览标签，取代文件树） | Cursor Agent Panel / Claude Code | 接近 v4 协作分屏，但右栏从「编辑器」换成了「产物视图」 |
| B 任务计划中心 | [方案B-任务计划中心](./方案B-任务计划中心.png) / [.html](./方案B-任务计划中心.html) | 任务列表 + PLAN 步骤时间线（检查点/回退/PASS 徽标）+ 右侧 Agent 工作台（浏览器/终端/编辑器）+ 底部追加指令条 | Devin / Manus | 对应 v3 调度看板的「单任务详情页」形态 |
| C 极简对话优先 | [方案C-极简对话优先](./方案C-极简对话优先.png) / [.html](./方案C-极简对话优先.html) | 无常驻面板：56px 图标轨 + 居中对话列 + 内联 diff 卡/文件 chip + 右下角「工作区 2」悬浮抽屉 | Claude Desktop / ChatGPT | 对应 v2 画布流的极简版，IDE 元素全部收起 |
| D 多 Agent 指挥台 | [方案D-多Agent指挥台](./方案D-多Agent指挥台.png) / [.html](./方案D-多Agent指挥台.html) | KPI 条（活跃/完成/待审批/Token）+ Agent 角色卡片网格 + 右侧审批抽屉 + 底部总监指令条 | Mission Control / Linear / 一人公司 | 对应 v1 任务驾驶舱的角色化版本，贴合 office/targetMode 概念 |
| E 检查点时间线 | [方案E-检查点时间线](./方案E-检查点时间线.png) / [.html](./方案E-检查点时间线.html) | 垂直执行时间线为主画布（CP-01…CP-04 检查点卡，随时回退/从分支处理）+ 左任务列表 + 右「实时预览 + 产物」栏 + 底部悬浮指令条 | Replit Agent / Cursor Checkpoints | 对应 v2 的「执行过程可视化」路线，但以可回退检查点为一等公民 |
| F 规格三段式 | [方案F-规格三段式](./方案F-规格三段式.png) / [.html](./方案F-规格三段式.html) | 顶部「① 规格 → ② 计划 → ③ 实现」阶段条；左规格列（目标/约束/验收标准）+ 中计划列（步骤卡）+ 右实现列（diff/终端 + 全部接受） | GitHub Copilot Workspace | 新方向：先对齐规格与计划再动手，A/B 都没有「规格」层 |
| G 暗色指挥舱 | [方案G-暗色指挥舱](./方案G-暗色指挥舱.png) / [.html](./方案G-暗色指挥舱.html) | 全局深色：KPI 徽标条 + 72px 导航轨 + 2×2 Agent 角色卡网格 + 右审批收件箱 + 底部总监指令条 | Warp / Linear Dark / Raycast | D 的暗色完整版，面向夜间挂机监控；唯一深色底方案 |

## 两轮样稿怎么看

```bash
# Stitch 稿：浏览器直接打开 HTML（自带 Tailwind CDN，可交互查看细节）
start "" "OurCode-ide/design-mockup/agent-ui/stitch/方案A-对话驾驶舱.html"
# 或先看 PNG 缩略
# 第一轮手写稿（更贴近现有 token、可直接当实现参考）：
start "" "OurCode-ide/design-mockup/agent-ui/index.html"
```

## 筛选建议

- **要最平滑迁移** → A（右栏仍是工作区心智，`MainLayout` 渐进替换）或第一轮 v4。
- **要「打开就是 Agent 产品」** → C（极简对话优先）或第一轮 v2。
- **要任务/计划为中心的自治感** → B（检查点、回退、产物落盘都在任务维度）或 E（时间线 + 回退更极致）。
- **要一人公司多 Agent 编排** → D（角色卡片 + 审批收件箱 + 总监指令），夜间挂机选 G（暗色版）。
- **要先对齐再动手、控制返工** → F（规格三段式，唯一有「规格/验收标准」层的方案）。
- **要执行过程完全可视化、随时反悔** → E（每个动作都是检查点）。

推荐组合与第一轮相同：D/G 当首页与编排层，A 当默认工作区，C 当专注审阅模式，F 可作为「重要任务」的可选流程叠加在 A/B 上。

## 备注

- 生成 prompt 与项目 token 全部写死在 prompt 文本里（见 [prompts/](./prompts/)），
  Stitch 项目级 design system 已自动收敛为「Technical Glassmorphism Cockpit」（primary `#0058bc`），
  资产 `assets/8172acbddc504aae962287d4c1a9054f`；E/F/G 生成时显式传了该 DS。
- 已知问题：MCP `list_screens` / `get_project.screenInstances` 对本项目**服务端持续返回空**
  （不是客户端问题，直连 HTTP 同样为空），所以生成后必须从 `generate_screen_from_text` 的
  同步返回里拿屏幕资源名。本会话的 MCP 工具层 30s 超时会截断该返回（生成实际 80–140s），
  **用 `node scripts/stitch.mjs generate_screen_from_text … --prompt-file` 直连即可**（无超时），
  下载用 `scripts/stitch-fetch-agent-ui-round3.mjs`（按 result JSON 里的 file 名拉 PNG+HTML）。
  第一次提交 E/F/G 因超时丢资源名，云端可能残留 3 张同内容孤儿屏，可在网页端删除。
- 上午批次（A–D）prompt 见 `prompts/prompt-A.txt` … `prompt-D.txt`；下午批次见
  `prompt-E/F/G.txt`（含本地备注）与 `gen-E/F/G.txt`（发给 Stitch 的干净版）。
