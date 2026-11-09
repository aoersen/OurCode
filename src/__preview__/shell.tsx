/**
 * Local-only render harness for the new agent shell (`src/shell/agent`).
 * Seeds the stores with a realistic conversation and renders AgentShell at
 * 1440x900 without booting Electron, so the layout can be screenshotted.
 *
 *   ?bubble=expanded|collapsed   run status bubble state (default expanded)
 *   ?artifact=plan|browser|none  right artifact panel (default plan)
 *   ?empty=1                     open an empty conversation (hero composer)
 */
import { createRoot } from 'react-dom/client'
import '@/styles/global.css'
import AgentShell from '@/shell/agent/AgentShell'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { useUIStore } from '@/stores/uiStore'
import type { ChatMessage, ChatSession } from '@/types'

const params = new URLSearchParams(location.search)
const bubbleState = params.get('bubble') ?? 'expanded'
const artifact = params.get('artifact') ?? 'plan'
const emptyState = params.get('empty') === '1'
const runningState = params.get('running') === '1'
const darkTheme = params.get('theme') === 'dark'

if (darkTheme) document.documentElement.classList.add('dark')

// 文件树 / 预览用到的桥：给一份假目录，让「文件」模式和 markdown 预览可核对
const fakeTree: Record<string, Array<{ name: string; path: string; isDirectory: boolean; isHidden: boolean }>> = {
  'C:\\workspace\\ourcode': [
    { name: '.github', path: 'C:\\workspace\\ourcode\\.github', isDirectory: true, isHidden: false },
    { name: 'build', path: 'C:\\workspace\\ourcode\\build', isDirectory: true, isHidden: false },
    { name: 'src', path: 'C:\\workspace\\ourcode\\src', isDirectory: true, isHidden: false },
    { name: 'README.md', path: 'C:\\workspace\\ourcode\\README.md', isDirectory: false, isHidden: false },
    { name: 'package.json', path: 'C:\\workspace\\ourcode\\package.json', isDirectory: false, isHidden: false },
    { name: 'tsconfig.json', path: 'C:\\workspace\\ourcode\\tsconfig.json', isDirectory: false, isHidden: false },
  ],
  'C:\\workspace\\ourcode\\src': [
    { name: 'components', path: 'C:\\workspace\\ourcode\\src\\components', isDirectory: true, isHidden: false },
    { name: 'shell', path: 'C:\\workspace\\ourcode\\src\\shell', isDirectory: true, isHidden: false },
    { name: 'styles', path: 'C:\\workspace\\ourcode\\src\\styles', isDirectory: true, isHidden: false },
    { name: 'App.tsx', path: 'C:\\workspace\\ourcode\\src\\App.tsx', isDirectory: false, isHidden: false },
    { name: 'main.tsx', path: 'C:\\workspace\\ourcode\\src\\main.tsx', isDirectory: false, isHidden: false },
  ],
  'C:\\workspace\\ourcode\\src\\shell': [
    { name: 'agent', path: 'C:\\workspace\\ourcode\\src\\shell\\agent', isDirectory: true, isHidden: false },
    { name: 'settings', path: 'C:\\workspace\\ourcode\\src\\shell\\settings', isDirectory: true, isHidden: false },
    { name: 'pure.css', path: 'C:\\workspace\\ourcode\\src\\shell\\pure.css', isDirectory: false, isHidden: false },
  ],
  'C:\\workspace\\ourcode\\src\\shell\\agent': [
    { name: 'rail', path: 'C:\\workspace\\ourcode\\src\\shell\\agent\\rail', isDirectory: true, isHidden: false },
    { name: 'AgentShell.tsx', path: 'C:\\workspace\\ourcode\\src\\shell\\agent\\AgentShell.tsx', isDirectory: false, isHidden: false },
    { name: 'SessionRail.tsx', path: 'C:\\workspace\\ourcode\\src\\shell\\agent\\SessionRail.tsx', isDirectory: false, isHidden: false },
    { name: 'ArtifactPanel.tsx', path: 'C:\\workspace\\ourcode\\src\\shell\\agent\\ArtifactPanel.tsx', isDirectory: false, isHidden: false },
  ],
  'C:\\workspace\\ourcode\\src\\shell\\agent\\rail': [
    { name: 'railModel.ts', path: 'C:\\workspace\\ourcode\\src\\shell\\agent\\rail\\railModel.ts', isDirectory: false, isHidden: false },
    { name: 'ProjectRow.tsx', path: 'C:\\workspace\\ourcode\\src\\shell\\agent\\rail\\ProjectRow.tsx', isDirectory: false, isHidden: false },
  ],
  'C:\\workspace\\ourcode\\src\\styles': [
    { name: 'global.css', path: 'C:\\workspace\\ourcode\\src\\styles\\global.css', isDirectory: false, isHidden: false },
  ],
  'C:\\workspace\\ourcode\\src\\components': [
    { name: 'Common', path: 'C:\\workspace\\ourcode\\src\\components\\Common', isDirectory: true, isHidden: false },
  ],
  'C:\\workspace\\ourcode\\build': [
    { name: 'icon.png', path: 'C:\\workspace\\ourcode\\build\\icon.png', isDirectory: false, isHidden: false },
  ],
  'C:\\workspace\\ourcode\\.github': [],
  'C:\\workspace\\ourcode\\src\\shell\\settings': [],
  'C:\\workspace\\ourcode\\src\\components\\Common': [],
}

;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  listBackups: async () => [],
  mcpGetGlobalConfig: async () => ({ ok: true, file: null, config: { mcpServers: {} } }),
  mcpGetConfig: async () => ({ ok: true, file: null, config: { mcpServers: {} } }),
  listDir: async (path: string) => fakeTree[path] ?? [],
  stat: async () => ({ isDirectory: true }),
  openFolder: async () => 'C:\\workspace\\q3-report',
  openProject: async () => true,
  readFile: async () => ({ content: '# README\n\n这是预览用的假内容。\n', encoding: 'utf-8' }),
  writeFile: async () => ({ ok: true }),
  saveBackup: async () => undefined,
  deleteBackup: async () => undefined,
  setPreviewContent: async () => undefined,
  clearPreviewContent: async () => undefined,
  gitExec: async () => ({ success: false, output: '' }),
  gitStatus: async () => ({ branch: 'main', files: [] }),
}

const modelParams = {
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  thinking: false,
  reasoningEffort: 'medium' as const,
}

const now = Date.now()

const userMessage = (id: string, content: string, at: number): ChatMessage =>
  ({
    id,
    role: 'user',
    content,
    sortOrder: 0,
    contextFiles: [],
    tokenCount: 0,
    createdAt: at,
  }) as ChatMessage

const assistantMessage = (
  id: string,
  content: string,
  at: number,
  toolCalls?: ChatMessage['toolCalls'],
  toolResults?: ChatMessage['toolResults'],
): ChatMessage =>
  ({
    id,
    role: 'assistant',
    content,
    sortOrder: 0,
    contextFiles: [],
    tokenCount: 1200,
    createdAt: at,
    toolCalls,
    toolResults,
  }) as ChatMessage

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args,
  startedAt: now - 90_000,
})

const messages: ChatMessage[] = [
  userMessage('m1', '请把右侧的辅助对话面板改为主工作区画布，并调整对应的容器自适应逻辑。展开 Diff 和终端详情时整个界面不会产生异常的重排晃动。', now - 600_000),
  assistantMessage(
    'm2',
    '已重构底层容器布局架构。将原本辅助抽屉升级为标准居中主画布流式结构，主工作区锁定 720px 专注槽位，右侧面板展开与折叠均由弹性空白区域自然吸收。\n\n1. **时序竞争条件**：原先 `useEffect` 在流首包到达前测量高度，导致期间回退到基线。\n2. **同步测量补偿**：改用 `useLayoutEffect`，在浏览器 Paint 之前锁定真实 `scrollHeight`。\n3. **弹性容器高度保护**：外层保留 `contain: layout`，不修改外部 Flex 上下文。',
    now - 580_000,
    [
      call('c1', 'read_file', { path: 'src/components/Layout/MainLayout.tsx' }),
      call('c2', 'grep', { pattern: 'chatWidth' }),
      call('c3', 'edit_file', { path: 'src/shell/agent/AgentShell.tsx' }),
      call('c4', 'edit_file', { path: 'src/components/ChatPanel/ChatPanel.tsx' }),
      call('c5', 'run_command', { command: 'pnpm typecheck' }),
      call('c6', 'run_command', { command: 'pnpm test:unit --filter Layout' }),
      call('c7', 'run_command', { command: 'pnpm test:e2e:layout' }),
    ],
    [
      { toolCallId: 'c1', name: 'read_file', result: 'ok', startedAt: now - 95_000, finishedAt: now - 94_000, durationMs: 120 },
      { toolCallId: 'c2', name: 'grep', result: '4 matches', startedAt: now - 94_000, finishedAt: now - 93_900, durationMs: 64 },
      { toolCallId: 'c3', name: 'edit_file', result: '+142 −0', startedAt: now - 93_000, finishedAt: now - 92_000, durationMs: 980 },
      { toolCallId: 'c4', name: 'edit_file', result: '+28 −15', startedAt: now - 92_000, finishedAt: now - 91_000, durationMs: 1120 },
      { toolCallId: 'c5', name: 'run_command', result: 'passed in 1.4s', startedAt: now - 91_000, finishedAt: now - 89_600, durationMs: 1400 },
      { toolCallId: 'c6', name: 'run_command', result: '6 passed in 2.1s', startedAt: now - 89_000, finishedAt: now - 86_900, durationMs: 2100 },
      { toolCallId: 'c7', name: 'run_command', result: 'Error: layout container unexpectedly overflowed viewport', isError: true, startedAt: now - 86_000, finishedAt: now - 84_000, durationMs: 2000 },
    ],
  ),
  userMessage('m3', 'e2e 那条失败了，先别改容器，看看是不是断言写得比视口还宽。', now - 300_000),
  assistantMessage(
    'm4',
    '断言里写死了 760px，而容器实际是 720px —— 失败来自测试而不是布局。已把断言改成读取 `getBoundingClientRect()`，不再硬编码宽度。',
    now - 280_000,
    [call('c8', 'edit_file', { path: 'src/__tests__/layout.e2e.ts' })],
    [{ toolCallId: 'c8', name: 'edit_file', result: '+3 −3', startedAt: now - 290_000, finishedAt: now - 289_000, durationMs: 640 }],
  ),
]

// 让操作行的 token 徽标读到真实 run（输入/输出分开统计）
messages[1].runId = 'run-1'
messages[3].runId = 'run-2'

const session = {
  id: 'sess-1',
  title: '重构对话主画布',
  configGroupId: 'cfg-1',
  model: 'claude-sonnet-4-5',
  modelParams,
  messages,
  agentRuns: [
    {
      id: 'run-1',
      task: '把右侧辅助面板改为主工作区画布',
      status: 'done',
      startedAt: now - 600_000,
      finishedAt: now - 560_000,
      toolCallCount: 7,
      fileChangeCount: 2,
      stepCount: 18,
      tokensIn: 8420,
      tokensOut: 1180,
      requestCount: 4,
      cacheReadTokens: 2100,
    },
    {
      id: 'run-2',
      task: '检查 e2e 断言宽度',
      status: 'done',
      startedAt: now - 300_000,
      finishedAt: now - 280_000,
      toolCallCount: 1,
      fileChangeCount: 1,
      stepCount: 3,
      tokensIn: 2140,
      tokensOut: 420,
      requestCount: 1,
    },
  ],
  createdAt: now - 7_200_000,
  updatedAt: now - 60_000,
  lastUserMessageAt: now - 300_000,
  projectPath: 'C:\\workspace\\ourcode',
  planContent:
    '# 对话主画布重构方案\n\n本次重构旨在消除悬浮卡片遮挡与视口抖动问题，将对话流作为最高优先级主工作区呈现。\n\n## 核心设计准则\n\n- 三栏独立流式排布，彻底移除 Absolute 浮动层\n- 中间专注阅读槽锁定 720px，保持最佳代码与文字可读性\n- 实时运行状态气泡内聚呈现，支持快捷折叠与任务跟踪\n\n> 设计契约：所有的尺寸变形均在父级 Flex 容器内自洽闭环，杜绝全局重排。\n\n```ts\ninterface LayoutConfig {\n  readonly railWidth: 260;\n  readonly readingSlot: 720;\n  readonly artifactSlot: 400;\n}\n```\n',
  planStatus: 'approved',
} as unknown as ChatSession

const otherSessions = [
  {
    id: 'sess-2',
    title: 'Composer 高度抖动修复',
    configGroupId: 'cfg-1',
    model: 'claude-sonnet-4-5',
    modelParams,
    messages: [],
    createdAt: now - 90_000_000,
    updatedAt: now - 5_400_000,
    lastUserMessageAt: now - 5_400_000,
    projectPath: 'C:\\workspace\\ourcode',
    agentRuns: [{ id: 'r2', task: '修复抖动', status: 'done', startedAt: 0, toolCallCount: 2, fileChangeCount: 1, stepCount: 4 }],
  },
  {
    id: 'sess-3',
    title: '权限中间件拦截器',
    configGroupId: 'cfg-1',
    model: 'claude-sonnet-4-5',
    modelParams,
    messages: [],
    createdAt: now - 90_000_000,
    updatedAt: now - 9_000_000,
    lastUserMessageAt: now - 9_000_000,
    projectPath: 'C:\\workspace\\ourcode',
    agentRuns: [{ id: 'r3', task: '拦截器', status: 'error', lastError: 'tsc failed', startedAt: 0, toolCallCount: 3, fileChangeCount: 1, stepCount: 6 }],
  },
  {
    id: 'sess-4',
    title: '补全缓存延迟',
    configGroupId: 'cfg-1',
    model: 'claude-sonnet-4-5',
    modelParams,
    messages: [],
    createdAt: now - 90_000_000,
    updatedAt: now - 12_000_000,
    lastUserMessageAt: now - 12_000_000,
    projectPath: 'C:\\workspace\\ourcode',
    agentRuns: [{ id: 'r4', task: '缓存', status: 'stopped', startedAt: 0, toolCallCount: 1, fileChangeCount: 0, stepCount: 2 }],
  },
  {
    id: 'sess-5',
    title: 'Q3 报表口径确认',
    configGroupId: 'cfg-1',
    model: 'claude-sonnet-4-5',
    modelParams,
    messages: [],
    createdAt: now - 90_000_000,
    updatedAt: now - 90_000_000,
    lastUserMessageAt: now - 90_000_000,
    projectPath: 'C:\\workspace\\q3-report',
    agentRuns: [{ id: 'r5', task: '口径', status: 'done', startedAt: 0, toolCallCount: 2, fileChangeCount: 0, stepCount: 3 }],
  },
  {
    id: 'sess-6',
    title: '微信渠道接入联调',
    configGroupId: 'cfg-1',
    model: 'claude-sonnet-4-5',
    modelParams,
    messages: [],
    createdAt: now - 90_000_000,
    updatedAt: now - 120_000_000,
    lastUserMessageAt: now - 120_000_000,
    projectPath: 'C:\\workspace\\wechat-twin',
    agentRuns: [{ id: 'r6', task: '联调', status: 'error', lastError: 'token expired', startedAt: 0, toolCallCount: 4, fileChangeCount: 2, stepCount: 8 }],
  },
] as unknown as ChatSession[]

useConfigStore.setState({
  configGroups: [
    {
      id: 'cfg-1',
      name: 'Claude',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-preview',
      systemPrompt: '',
      defaultModel: 'claude-sonnet-4-5',
      provider: 'anthropic',
      customHeaders: {},
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  activeConfigGroupId: 'cfg-1',
})

useUIStore.setState({
  rootPath: 'C:\\workspace\\ourcode',
  recentProjects: ['C:\\workspace\\ourcode'],
  isArtifactPanelOpen: artifact !== 'none',
  statusBubbleExpanded: bubbleState === 'expanded' ? { 'sess-1': true } : {},
})

// 打开的文件：用来核对「一个文件一条标签 + 类型自动识别」
useEditorStore.setState({
  isEditorVisible: true,
  activeFilePath: 'C:\\workspace\\ourcode\\src\\shell\\agent\\AgentShell.tsx',
  openFiles: [
    {
      path: 'C:\\workspace\\ourcode\\src\\shell\\agent\\AgentShell.tsx',
      content: [
        "import SessionRail from './SessionRail'",
        "import ConversationHeader from './ConversationHeader'",
        "import ArtifactPanel from './ArtifactPanel'",
        '',
        'export default function AgentShell() {',
        '  return (',
        '    <div className="pure-shell h-full flex">',
        '      <SessionRail />',
        '      <ConversationView />',
        '      <ArtifactPanel />',
        '    </div>',
        '  )',
        '}',
        '',
      ].join('\n'),
      language: 'typescript',
      encoding: 'utf-8',
      lineEnding: 'lf',
      isDirty: true,
    },
    {
      path: 'C:\\workspace\\ourcode\\README.md',
      content: '# OurCode IDE\n\n对话优先的工作台。\n',
      language: 'markdown',
      encoding: 'utf-8',
      lineEnding: 'lf',
      isDirty: false,
    },
    {
      path: 'C:\\workspace\\ourcode\\src\\styles\\global.css',
      content: '.pure-shell {\n  color: #0d0d0d;\n}\n',
      language: 'css',
      encoding: 'utf-8',
      lineEnding: 'lf',
      isDirty: false,
    },
    {
      path: 'C:\\workspace\\ourcode\\build\\icon.png',
      content: '',
      language: 'plaintext',
      encoding: 'utf-8',
      lineEnding: 'lf',
      isDirty: false,
    },
  ],
} as never)

useChatStore.setState({
  sessions: emptyState ? [{ ...session, id: 'sess-empty', title: '新对话', messages: [], agentRuns: [] } as unknown as ChatSession, ...otherSessions] : [session, ...otherSessions],
  activeSessionId: emptyState ? 'sess-empty' : 'sess-1',
  runningSessionIds: runningState ? ['sess-1'] : [],
})

createRoot(document.getElementById('root')!).render(<AgentShell />)
