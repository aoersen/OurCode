# 微信 Agent 重设计方案（Wechat Agent Redesign）

> 状态：设计稿 v1，待评审。**未开始任何代码改动。**
> 目标读者：实现者 + 产品决策人。
> 参考：Nous Research Hermes Agent（常驻「数字员工」：持久记忆、自演化技能、事件驱动、独立于任何单次对话/单个项目）、OpenClaw/Moltbot、Claude/Codex on mobile 等 chat-first agent 的通用模式。

---

## 1. 现状问题（为什么必须重设计）

今天的微信接入是一个「微信 → IDE 会话」的管道（`wechatBridge.ts`），核心缺陷：

1. **绑定 UI 工作区**：`runAgentLoop` 的 agent 模式守卫要求「IDE 当前打开着某个项目」（读 DOM `file-tree-root` / `uiStore.rootPath`，`chatStore.ts:3360-3369`），而不是会话自己的工作区。微信会话创建时抓一次 `projectPath` 就永久固化，无运行时工作区概念。IDE 没开项目 → 微信 agent 拒绝启动。
2. **抢占 UI 焦点**：决策槽机制（`offerDecision`/`rebalanceDecisions`）与 `activeSessionId` 绑定，微信桥接只能靠 `setActiveSession` 把微信会话顶到前台才能处理审批——每次来消息都会把用户正在用的 IDE 会话挤下去。
3. **微信会话污染主界面**：微信会话出现在左侧栏，和 IDE 自己的对话混在一起。
4. **状态不可对话调整**：`wechatWorkspaceDir` / `wechatApprovalMode` / 模型选择是设置面板里的静态偏好，改一次要打开 IDE 设置。
5. **没有 agent 自己的状态记录**：没有「当前在哪工作、处于什么模式、记住了什么」这类 agent 级持久状态。

## 2. 目标（本次重设计的验收标准）

1. 微信接入是一个**独立的常驻 agent**（下称 WeChat Agent），有自己的身份、状态记录与工作上下文，不依附于 IDE 当前打开的项目。
2. **初始处于独立沙盒空间**（不在任何用户工作区），可在 IDE 未打开任何项目时正常工作。
3. **可随时通过对话切换到任意工作区**，也可切回沙盒。
4. **状态可通过对话查看与调整**（工作区、审批模式、模型、记忆等）。
5. 微信会话不再抢占 IDE 焦点、不出现在主界面会话列表。
6. 现有能力不回归：扫码登录、流式回发、审批应答、免审批模式、崩溃自愈。

## 3. 核心概念模型

```
┌────────────┐   contacts   ┌──────────────────────────────────┐
│  WeChat 用户├──────────────┤        WeChat Agent（单例）        │
│  (多人/群)  │  多会话线程   │                                  │
└────────────┘              │  ┌────────────────────────────┐  │
                            │  │ AgentState（持久化）        │  │
                            │  │  · currentWorkspace        │  │
                            │  │  · sandboxPath             │  │
                            │  │  · approvalMode            │  │
                            │  │  · model/group 偏好        │  │
                            │  │  · memory[] 记忆条目        │  │
                            │  │  · 最近状态快照             │  │
                            │  └────────────────────────────┘  │
                            │  ┌────────────────────────────┐  │
                            │  │ 会话线程 per contact        │  │
                            │  │ （沿用 chatStore 会话）      │  │
                            │  └────────────────────────────┘  │
                            │  ┌────────────────────────────┐  │
                            │  │ 执行引擎（复用 runAgentLoop）│  │
                            │  │  · workspace 参数化运行     │  │
                            │  │  · 后台决策通道（不抢焦点）  │  │
                            │  │  · agent 级排队             │  │
                            │  └────────────────────────────┘  │
                            └──────────────────────────────────┘
```

- **一个 agent，多条会话线程**：所有联系人的消息都发给同一个 WeChat Agent（共享状态、共享当前工作区），但每个联系人/群保留独立的会话历史（现有 `sessionByContact` 映射保留）。
- **AgentState 是权威**：agent 的「当前工作区」存在状态里，会话里的 `projectPath` 只作历史记录（每次任务开始时的快照）。

## 4. 状态模型（AgentState）

新增 SQLite 表 `wechat_agent_state`（单行，key-value 风格或 JSON 列；沿用 `user_preferences` 的存取模式）。字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sandboxPath` | string | 沙盒根目录，首次启动创建（见 §5） |
| `currentWorkspace` | string \| null | **null = 沙盒模式**；否则为当前工作区绝对路径 |
| `approvalMode` | `'approve' \| 'full_access'` | 审批模式（对话可调） |
| `configGroupId` / `modelId` | string | 模型偏好（对话可调，保留设置面板入口） |
| `memory` | array<{id, text, createdAt}> | agent 自己的记忆条目（`/memory` 管理） |
| `stateVersion` / `updatedAt` | number | 迁移与诊断用 |

**与「用户偏好」分离**：`wechatWorkspaceDir` 等设置偏好降级为「初始值」，运行期一切以 AgentState 为准。对话调整即时生效并持久化。

**状态快照回执**：每次状态变更后，向该联系人回执一行摘要（如 `✅ 已切换到 E:\project（免审批模式）`），并在 `/status` 中完整展示。

## 5. 沙盒空间

- 路径（**安装目录优先**）：`<安装目录>/wechat-agent/sandbox`——打包版为 exe 所在目录（`dirname(app.getPath('exe'))`），开发版为项目根目录（`app.getAppPath()`）；沙盒与程序随行，便于携带式部署。
- **可写性回退**：安装目录不可写（如系统级 `C:\Program Files` 无写权限）时，回退到 `<userData>/wechat-agent/sandbox`。选定的路径写入 `AgentState.sandboxPath` 持久化，启动时沿用，避免每次漂移。
- 创建时机：首次收到微信消息（或首次启动 WeChat Agent）时由主进程创建并做可写性探测。
- **信任注册**：创建即自动注册进 `workspace-trust` 白名单（目录由应用自己创建，不经过用户选择，视为安全）。
- 语义：沙盒 = agent 的私人工作台。agent 在这里可以建项目、写脚本、存笔记；用户随时可用 `/workspace` 把任务切到真实项目，或切回沙盒。
- 沙盒内工具调用仍需遵守审批模式（`approve` 模式照常逐条审批）。
- 已知风险（记录在案）：覆盖安装/卸载可能清除安装目录下的沙盒内容；自动更新器替换应用文件时不应触碰 `wechat-agent/` 子目录（实施时需确认 updater 的排除清单）。

## 6. 工作区切换

### 6.1 触发方式
- **确定性命令**：`/workspace <路径>`、`/workspace sandbox`（回到沙盒）、`/workspace`（查看当前）。
- **自然语言**：agent 在执行任务中需要换目录时，通过状态工具（§7 的 `wechat_state` 工具）自己调整，同样走下面的门禁。

### 6.2 信任门（安全关键）
切换到一个**未信任**的目录 = 授予 agent 对该目录的读写权，必须显式确认：

```
🔐 你请求将工作区切换到 E:\foo
该目录尚未获得本机信任。确认后微信 Agent 将有权读写该目录。
回复「批准」切换，「拒绝」取消
```

- 复用现有 `workspace-trust` 服务与 `fs:openProject` 的信任注册路径（主进程唯一授权入口）。
- 已信任目录直接切换，仅回执一行确认。
- 路径校验：必须为绝对路径；不存在 → 明确报错（不自动创建用户路径，只有沙盒自动创建）。

### 6.3 运行时生效
- 切换只影响**之后的轮次**；正在跑的任务继续在旧工作区完成（轮内快照）。
- 新任务开始（`beginRun`）时把 `currentWorkspace` 快照进该会话/该轮，写入会话 `projectPath` 供历史回看。
- 需要打通的关键点：**`runAgentLoop` 增加显式 workspace 参数**（见 §8.1）。

## 7. 对话命令集（确定性路由层）

在桥接层加一个轻量命令路由器：**先于 agent 处理**，前缀 `/` 或精确匹配中文短命令，确定性、无 LLM 开销：

| 命令 | 作用 |
|---|---|
| `/help`（帮助） | 列出全部命令 |
| `/status`（状态） | 当前工作区、审批模式、模型、记忆条数、沙盒路径 |
| `/workspace [路径]` | 查看/切换工作区；`/workspace sandbox` 回沙盒 |
| `/mode approve \| full_access` | 切换审批模式 |
| `/model <模型名>`、`/group <组名>` | 切换模型/配置组 |
| `/memory add <内容> \| list \| clear` | 记忆管理（注入后续任务的系统提示） |
| `/reset` | 重置 agent 状态（回沙盒+清记忆），需二次确认 |

非命令消息照常走 agent 循环；agent 任务执行中需要改状态时，通过新增的 **`wechat_state` 工具**（get/set workspace、mode、memory）由 agent 自行调用——同样受信任门与审批模式约束。

## 8. 运行架构改动（现有代码的具体动刀点）

### 8.1 解耦「工作区 = UI 当前项目」（核心改动）
- `runAgentLoop(sessionId, opts)` 增加 `opts.workspacePath`；agent 模式的守卫从「读 UI 全局 rootPath」改为「使用 `opts.workspacePath ?? session.projectPath`，并校验该目录存在」。
- 工具执行上下文（`ToolExecutionContext.projectPath`）与上下文加载（`loadWorkspaceKnowledge`、检索、技能扫描）全部改用该 workspace；`getWorkspaceRoot()` 的 UI 回退仅保留给**普通 IDE 会话**，WeChat 会话不再回退到 UI 项目。
- 效果：IDE 一个项目都没打开，微信 agent 也能在沙盒/指定工作区跑。

### 8.2 后台决策通道（不再抢焦点）
- 现状：决策入槽依赖 `activeSessionId`，桥接靠 `setActiveSession` 抢焦点。
- 方案：为 WeChat Agent 引入**独立决策队列**——`offerDecision` 增加 agent 上下文参数，微信会话的决策直接进入 agent 决策队列，由桥接层消费（现状的 backlog 逻辑迁移/复用）；IDE 的 `activeSessionId` 完全不被触碰。
- 同引擎两类通道：IDE 会话 → 原有槽位机制；WeChat Agent → 后台队列。审批结果仍然通过现有 resolve（`approveToolCall` 等）驱动 agent 循环。

### 8.3 会话隔离（不污染 UI）
- 复用现有 `mode` 字段（`'main' | 'office'` 已有先例）：微信会话 `mode: 'wechat'`，`getSessions('main')` 过滤掉，主界面左侧栏/最近会话不显示。
- 桥接层删除所有 `setActiveSession` 调用（§8.2 落地后不再需要）。
- 可选增强（P2）：设置面板加「微信 Agent」独立查看页（只读会话历史 + 状态面板）。

### 8.4 agent 级排队
- 现状按会话排队（`pendingBySession`）。共享工作区意味着**同一时间只跑一个任务**更安全：agent 级忙队列，跨联系人的消息按到达顺序排队，每条入队时回执「⏳ 排在 N 条任务后」。
- 决策等待不计入排队：等待审批期间允许新命令进入（路由层命令如 `/status` 仍即时响应）。

### 8.5 文件改动映射（供实施参考，本阶段不动）
| 现有文件 | 改动 |
|---|---|
| `src/services/wechat/wechatBridge.ts` | 重构为 agentHost：命令路由、AgentState 读写、后台决策消费、排队；删除 setActiveSession 与 UI 工作区依赖 |
| `src/stores/chatStore.ts` | `runAgentLoop` 支持 workspace 参数与微信会话守卫；`offerDecision` 支持后台队列；`createSession` 支持 `mode:'wechat'` |
| `src/stores/wechatStore.ts` | 增加 agentState 视图与命令动作 |
| `electron/main.ts` / `services/` | `fs:` 信任注册入口复用；沙盒目录创建 + 自动信任；`wechat_agent_state` 表（SQLiteStore） |
| `src/components/Settings/WechatSettingsSection.tsx` | 偏好降级为「初始值」文案；可加状态查看页 |
| `shared/types.ts` | AgentState、命令回执、事件扩展 |

## 9. 安全边界

- **工作区切换 = 授权**：永远过信任门（§6.2），未批准绝不切换。
- **沙盒默认**：新 agent 状态一律从沙盒开始，不继承任何用户目录权限。
- **审批模式默认 `approve`**（当前默认是 full_access——重设计后建议改回 `approve`，由用户对话开启免审批；待确认，见 §12）。
- 信任门回执使用统一的 `pendingSwitch` 决策（可复用现有决策广播机制，但走后台通道）。

## 10. 迁移与兼容

- 现有 `wechat_session_map`（localStorage）：联系人↔会话映射原样保留，旧会话标记 `mode:'wechat'` 后隐藏。
- 旧偏好 `wechatWorkspaceDir`：迁移为「首次切换的候选工作区」，不再作为运行依赖。
- 凭据/同步缓冲（网关侧）不受影响。

## 11. 分阶段实施计划

**P1（核心解耦，可先验证「沙盒跑起来」）**
- AgentState 表 + 沙盒创建/信任 + `runAgentLoop` workspace 参数化 + 微信会话守卫改造。
- 验收：IDE 不开项目，微信发任务，agent 在沙盒完成（含工具调用）。

**P2（独立性与对话控制）**
- 后台决策通道 + `mode:'wechat'` 会话隔离 + 命令路由（`/workspace` `/status` `/mode` `/model`）+ 信任门确认流。
- 验收：切换工作区、切回沙盒、免审批开关全程对话完成，IDE 焦点不被抢占。

**P3（记忆与打磨）**
- `/memory`、`/reset`、`wechat_state` 工具、agent 级排队、设置面板状态页、测试补齐（unit + 信任门/命令路由的覆盖）。
- 验收：状态在重启后保持，多联系人并发不串工作区。

## 12. 待确认的决策点

1. **多联系人共享一个 agent 状态**（推荐）：所有人共享同一当前工作区；还是每个联系人一个独立 agent 实例（互不干扰，但「切换到某工作区」需每人各自配置）？
2. **审批模式默认值**：重设计后是否改回 `approve`（推荐，配合信任门更安全）？
3. **命令风格**：仅 `/` 前缀命令，还是同时支持中文短命令（「状态」「切到 xxx」）——推荐两者都支持，但确定性解析只认固定词表。
4. **沙盒路径**：安装目录优先、不可写回退 userData（已按此确认写入 §5）。
5. **微信会话在 IDE 中的可见性**：完全隐藏（推荐） vs 只读展示区。

## 13. 微信 Agent × 一人公司：观察与干预（v2 增补）

微信 Agent 作为独立 agent，可以**观察**一人公司（office 窗口）里的项目与运行状态，并**干预**——通过向总监（公司会话）下指令的方式，指令下达前在微信侧**交互式确认**。

### 13.1 数据流

```
一人公司窗口(office renderer)          主进程                对话窗口(微信桥接)
  ┌────────────────────┐        office:pushStatus    ┌─────────────────────┐
  │ wechatRelay 快照发布│ ─────────────────────────→ │ 缓存最近快照(≤1s)     │
  │ (chatStore 订阅节流)│                            │ officeWindows 跟踪    │
  │                    │ office:wechatInstruction ←─ │ wechat:getOfficeSnapshot
  │ 指令接收(校验+注入) │ ──────────────────────────  │ wechat:sendOfficeInstruction
  │ office:wechatInstructionResult →                 │        ↑ 微信 /office 命令
  └────────────────────┘                            └────────┴ office_* 工具
```

- **观察**：office 窗口把紧凑快照（公司列表/运行相位、员工工位、近期活动，节流 1s）推给主进程缓存；微信侧 `/office`（状态）与 agent 的 `office_status` 工具经 IPC 读取。办公室窗口未打开 → 快照为空，回「办公室未启动」。
- **干预**：微信侧 `/office instruct [--task <标题|路径>] <指令>`（或 agent 调用 `office_instruct` 工具）→ 桥接生成待确认指令 → 微信侧「批准/拒绝」确认（与工作区切换信任门同模式）→ 主进程把指令路由到 office 窗口 → office 渲染层校验会话后 `sendMessage(公司会话, 指令)`（走公司自身排队/审批流程，等同用户在办公室右下角发消息）→ 结果回执原路返回微信。
- **目标会话解析**：未指定 `--task` 时，唯一运行中的公司 → 它；否则最近更新的公司；多个候选 → 列出让用户在微信里点名。

### 13.2 关键约束
- 干预对象只能是 office 会话（公司在 office 窗口进程内运行），指令注入等同用户消息，公司自身的审批/排队语义不变。
- 微信侧确认是唯一的授权门：指令在确认前不产生任何效果；`office_instruct` 工具提交后同样挂起等待微信回复。
- 办公室窗口关闭 = 公司停止 → 观察与干预都返回明确提示，不假装成功。

---

*本文档仅描述设计；确认后按 P1→P3 实施，每阶段跑测试与验收清单。*
