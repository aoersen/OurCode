export const agentsData = [
  {
    id: 1,
    role: "总监",
    codeName: "Director-01",
    type: "director",
    status: "thinking",
    task: "评估多 Agent 协同拓扑与任务自洽性决策",
    progress: 85,
    avatarIndex: 0, // Top-Left: Suit with glasses
    avatarColor: {
      suit: 0x18181b, // 曜石黑正装西装
      shirt: 0xffffff,
      tie: 0x0284c7, // 科技蓝领带
      hair: 0x1c1917, // 沉稳深黑偏分
      skin: 0xfbd0b3,
      accent: 0xeab308, // 金色工牌
      glasses: true,
      hairStyle: "sidePart"
    },
    deskPos: { x: -5.7, z: -3.5, row: 0, col: 0 },
    stats: { completed: 28, pending: 2, efficiency: "99.4%" },
    logs: [
      { t: "14:40:12", k: "thinking", title: "规划架构", desc: "完成 Agent 协同通信拓扑 V3 方案初评" },
      { t: "14:22:05", k: "transfer", title: "任务指派", desc: "向 需求分析师-02 派发 PRD 拆解任务" },
      { t: "13:58:30", k: "completed", title: "审批完成", desc: "批准 3D 渲染引擎重构方案" }
    ]
  },
  {
    id: 2,
    role: "需求分析师",
    codeName: "PM-02",
    type: "pm",
    status: "receiving",
    task: "拆解用户交互规范与 8 状态机映射表",
    progress: 56,
    avatarIndex: 1, // Top-Center: Female PM pink top wavy brown hair
    avatarColor: {
      suit: 0xf472b6, // 温柔粉色针织上衣
      shirt: 0xfdf2f8,
      hair: 0x78350f, // 栗棕色大波浪长发
      skin: 0xfce3d2,
      accent: 0xf43f5e,
      glasses: false,
      hairStyle: "femaleLong"
    },
    deskPos: { x: -1.9, z: -3.5, row: 0, col: 1 },
    stats: { completed: 34, pending: 3, efficiency: "97.2%" },
    logs: [
      { t: "14:41:00", k: "receiving", title: "接收任务", desc: "接收来自 总监 的系统交互规约" },
      { t: "14:15:20", k: "work", title: "需求细化", desc: "完成 3D 抛物线文件传递触发机制文档" },
      { t: "13:40:10", k: "completed", title: "需求定稿", desc: "评审通过工位状态驱动规范" }
    ]
  },
  {
    id: 3,
    role: "UI/UX 设计师",
    codeName: "Design-03",
    type: "ui",
    status: "thinking",
    task: "3D 等距办公室光影调优与动效曲线定型",
    progress: 88,
    avatarIndex: 2, // Top-Right: Purple sweatshirt glasses
    avatarColor: {
      suit: 0x7c3aed, // 紫色设计师连帽卫衣
      shirt: 0xede9fe,
      hair: 0x27272a, // 黑色微卷短发
      skin: 0xfcdac2,
      accent: 0xa855f7,
      glasses: true,
      hasHeadphones: true,
      hairStyle: "curls"
    },
    deskPos: { x: 1.9, z: -3.5, row: 0, col: 2 },
    stats: { completed: 41, pending: 1, efficiency: "99.1%" },
    logs: [
      { t: "14:42:15", k: "thinking", title: "设计构思", desc: "优化 3D 人物托腮与欢呼骨骼关键帧曲线" },
      { t: "14:10:00", k: "transfer", title: "交付设计稿", desc: "向 业务研发-1 传送全新 3D 场景组件规格" },
      { t: "13:30:45", k: "completed", title: "调色定稿", desc: "输出等距低 FOV 色调映射参数" }
    ]
  },
  {
    id: 4,
    role: "核心架构师",
    codeName: "Dev-04",
    type: "dev",
    status: "working",
    task: "构建高吞吐 Agent 任务调度器与双向事件总线",
    progress: 65,
    avatarIndex: 3, // Bottom-Left: Blue collared developer
    avatarColor: {
      suit: 0x1e293b, // 深黑极客连帽衫
      shirt: 0x38bdf8,
      hair: 0x171717,
      skin: 0xfbd0b3,
      accent: 0x38bdf8,
      glasses: true,
      hairStyle: "shortSpiky"
    },
    deskPos: { x: 5.7, z: -3.5, row: 0, col: 3 },
    stats: { completed: 42, pending: 4, efficiency: "97.8%" },
    logs: [
      { t: "14:42:30", k: "work", title: "编写核心代码", desc: "编译 Agent 状态驱动中间件" },
      { t: "14:05:12", k: "completed", title: "模块重构", desc: "优化任务路由并发锁机制" }
    ]
  },
  {
    id: 5,
    role: "业务研发-1",
    codeName: "Dev-05",
    type: "dev",
    status: "working",
    task: "实现 WebGL 3D 工位资产与骨骼动作融合渲染",
    progress: 92,
    avatarIndex: 3, // Bottom-Left: Glasses developer
    avatarColor: {
      suit: 0x0284c7, // 蔚蓝科技夹克
      shirt: 0xffffff,
      hair: 0x1f1f1f,
      skin: 0xfcdac2,
      accent: 0x38bdf8,
      glasses: true,
      hairStyle: "shortSpiky"
    },
    deskPos: { x: -5.7, z: 2.5, row: 1, col: 0 },
    stats: { completed: 37, pending: 2, efficiency: "98.5%" },
    logs: [
      { t: "14:43:00", k: "work", title: "3D 渲染执行", desc: "实时驱动 8 个工位多态动态 Canvas 屏幕" },
      { t: "14:20:18", k: "work", title: "骨骼绑定", desc: "绑定 Typing / Thinking 关节动画控制器" },
      { t: "13:50:00", k: "transfer", title: "代码提交", desc: "推送至 业务研发-2 进行 CR" }
    ]
  },
  {
    id: 6,
    role: "业务研发-2",
    codeName: "Dev-06",
    type: "dev",
    status: "reviewing",
    task: "手持黄色项目任务板，在工位间走动协作交接",
    progress: 80,
    avatarIndex: 5, // Bottom-Right: Smiling young dev runner
    avatarColor: {
      suit: 0x0284c7, // 浅蓝连帽卫衣
      shirt: 0xffedd5,
      hair: 0x451a03, // 棕色层次短发
      skin: 0xfbd0b3,
      accent: 0xfacc15, // 黄色文件夹
      glasses: false,
      hairStyle: "modernShort"
    },
    deskPos: { x: -1.9, z: 2.5, row: 1, col: 1 },
    stats: { completed: 31, pending: 1, efficiency: "97.4%" },
    logs: [
      { t: "14:43:10", k: "review", title: "任务交接", desc: "携带黄色 PRD 文件夹前往 自动化测试-1 交付" },
      { t: "14:12:00", k: "work", title: "代码审查", desc: "比对 双屏 Diff 补丁：文件飞行与落桌光环动效" }
    ]
  },
  {
    id: 7,
    role: "自动化测试-1",
    codeName: "QA-07",
    type: "qa",
    status: "receiving",
    task: "接收交付件，执行 Bug 漏洞扫描与自动化用例",
    progress: 45,
    avatarIndex: 4, // Bottom-Center: Female QA yellow collar with mic
    avatarColor: {
      suit: 0xeab308, // 明黄暖色翻领衬衫
      shirt: 0xfffbeb,
      hair: 0x3f3f46, // 黑色齐肩鲍伯短发
      skin: 0xfce3d2,
      accent: 0xf59e0b,
      hasMic: true,
      hairStyle: "femaleBob"
    },
    deskPos: { x: 1.9, z: 2.5, row: 1, col: 2 },
    stats: { completed: 48, pending: 3, efficiency: "99.3%" },
    logs: [
      { t: "14:43:25", k: "receiving", title: "接取交付件", desc: "启动 Bug 扫描雷达与 120 项自动化用例" },
      { t: "13:55:10", k: "completed", title: "缺陷分析", desc: "生成红色 Bug 缺陷分析直方图" }
    ]
  },
  {
    id: 8,
    role: "性能测试-2",
    codeName: "QA-08",
    type: "qa",
    status: "idle",
    task: "待命状态 · 监控 GPU DrawCall 与内存占用基线",
    progress: 20,
    avatarIndex: 4, // Female QA
    avatarColor: {
      suit: 0x16a34a, // 绿色针织衫
      shirt: 0xf0fdf4,
      hair: 0x1f1f1f, // 黑色披肩长发
      skin: 0xfcdac2,
      accent: 0x22c55e,
      glasses: false,
      hairStyle: "femaleLong"
    },
    deskPos: { x: 5.7, z: 2.5, row: 1, col: 3 },
    stats: { completed: 22, pending: 0, efficiency: "96.5%" },
    logs: [
      { t: "14:40:00", k: "idle", title: "待命轮询", desc: "等待下一轮端到端性能压测批次" },
      { t: "13:45:00", k: "completed", title: "性能报告", desc: "输出 WebGL 渲染管线内存驻留报告" }
    ]
  }
];

export const statusMeta = {
  working: {
    label: "工作中",
    en: "Working",
    color: "#22c55e",
    colorName: "green",
    icon: "⌨",
    badge: "WORK",
    hint: "专注打字编码 / 原型设计中"
  },
  idle: {
    label: "空闲中",
    en: "Idle",
    color: "#eab308",
    colorName: "yellow",
    icon: "☕",
    badge: "IDLE",
    hint: "在座待命，轻微呼吸环视"
  },
  transfer: {
    label: "任务传递",
    en: "Transferring",
    color: "#3b82f6",
    colorName: "blue",
    icon: "➜",
    badge: "FLY",
    hint: "黄色任务档案正向目标工位飞递交接"
  },
  thinking: {
    label: "思考中",
    en: "Thinking",
    color: "#a855f7",
    colorName: "purple",
    icon: "✦",
    badge: "THINK",
    hint: "托腮沉思，脑力风暴粒子环绕"
  },
  receiving: {
    label: "任务接收",
    en: "Receiving",
    color: "#06b6d4",
    colorName: "cyan",
    icon: "↓",
    badge: "RECV",
    hint: "伸手接纳飞来的任务交付件"
  },
  reviewing: {
    label: "代码评审",
    en: "Reviewing",
    color: "#6366f1",
    colorName: "indigo",
    icon: "⌕",
    badge: "DIFF",
    hint: "双屏代码对比与交付物审核"
  },
  completed: {
    label: "已完成",
    en: "Completed",
    color: "#10b981",
    colorName: "teal",
    icon: "✓",
    badge: "DONE",
    hint: "振臂欢呼，任务高质量验收完成"
  },
  error: {
    label: "异常告警",
    en: "Error",
    color: "#ef4444",
    colorName: "red",
    icon: "!",
    badge: "ALERT",
    hint: "抱头焦灼，红色警报急促闪烁"
  },
  offline: {
    label: "工位空闲/离线",
    en: "Offline",
    color: "#64748b",
    colorName: "gray",
    icon: "⏻",
    badge: "OFF",
    hint: "工位无人，电脑黑屏关闭"
  }
};

