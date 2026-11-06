/**
 * 「一人公司」看板 / 工作台上下分栏的本地浏览器预览（仅用于布局与拖拽验收，
 * 不进任何打包产物）。
 *
 * 用途：不开 Electron 就能按真实窗口尺寸（如 1291×406、893×531）复现
 * 「看板显示不全 / 分割条拖不动」的现场，并验证修复后的行为。
 * 启动：npx vite --config vite.config.preview.ts，然后打开 /office.html
 */
import { createRoot } from 'react-dom/client'
import '@/styles/global.css'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import { WORKER_ROSTER, titleForSlot } from '@/services/office/workers'
import OfficeView from '@/components/Office/OfficeView'
import NotificationToasts from '@/components/Common/NotificationToasts'

// --- electron bridge stub：预览环境没有主进程，调用一律返回空结果 -----------
// 列表类接口必须真的返回数组（store 会把返回值直接写进状态，undefined 会让
// 看板里的卡片在 map/展开时抛错，整个视图被 React 卸载掉）。
// .ourcode/targemode 下预置一份目标修订快照（finalGoal_v1.md），用来复现
// 「待决中心每次进来都叫你处理」的现场。
const PREVIEW_PROJECT = 'C:\\workspace\\ourcode'
const REVISION_DIR = `${PREVIEW_PROJECT}\\.ourcode\\targemode`
const DIR_FIXTURES: Record<string, Array<{ name: string; isDirectory: boolean; size: number; modifiedAt: number }>> = {
  [REVISION_DIR]: [
    { name: 'finalGoal.md', isDirectory: false, size: 2048, modifiedAt: 1_760_000_000_000 },
    { name: 'finalGoal_v1.md', isDirectory: false, size: 1900, modifiedAt: 1_759_000_000_000 },
    { name: 'implementationStatus.md', isDirectory: false, size: 320, modifiedAt: 1_760_100_000_000 },
  ],
}

const stubTarget: Record<string, unknown> = {
  // 真实 Electron 端会归一化路径；预览里把 '/' 折成 '\\' 再查 fixture
  listDir: (path: string) =>
    Promise.resolve(DIR_FIXTURES[String(path).replace(/\//g, '\\')] ?? []),
}
const stub = new Proxy(stubTarget, {
  get: (target, prop) => {
    if (prop in target) return target[prop as string]
    const name = String(prop)
    const empty = /(List|list)$/.test(name) || name === 'mcpStatus' || name === 'mcpList'
    return (() => Promise.resolve(empty ? [] : undefined)) as never
  },
})
;(window as unknown as { electronAPI: unknown }).electronAPI = stub

// --- store seeds：一个带项目的会话，看板才有内容可渲染 --------------------
const modelParams = {
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  thinking: false,
  reasoningEffort: 'medium' as const,
}

useEditorStore.setState({ isEditorVisible: true } as never)
useUIStore.setState({
  rootPath: 'C:\\workspace\\ourcode',
  recentProjects: ['C:\\workspace\\ourcode'],
})
// 增员要读 activeConfigGroupId（没有模型就雇不了），预览里先给一个配置组
useConfigStore.setState({
  configGroups: [
    {
      id: 'cfg-1',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-preview',
      systemPrompt: '',
      defaultModel: 'deepseek-chat',
      provider: 'deepseek',
      customHeaders: {},
      createdAt: 0,
      updatedAt: 0,
    },
  ],
  activeConfigGroupId: 'cfg-1',
} as never)

const PROJECT = 'C:\\workspace\\ourcode'

// 最低编制员工（与 ensureWorkers 一致）：2 需求分析师 / 3 UI 研发 / 4 研发-1 / 7 测试-1
const workerSessions = WORKER_ROSTER.map((def) => ({
  id: `worker-${def.slot}`,
  title: titleForSlot(def.slot),
  configGroupId: 'cfg-1',
  model: 'deepseek-chat',
  modelParams,
  messages: [],
  createdAt: Date.now() - 3_000_000,
  updatedAt: Date.now() - 120_000,
  agentMode: 'agent',
  projectEditMode: 'guarded',
  todos: [],
  planStatus: 'none',
  projectPath: PROJECT,
  workerRole: def.role,
  workerSlot: def.slot,
  hidden: true,
}))

useChatStore.setState({
  sessions: [
    {
      id: 'sess-1',
      title: '一人公司看板',
      configGroupId: 'cfg-1',
      model: 'deepseek-chat',
      modelParams,
      messages: [],
      createdAt: Date.now() - 3_600_000,
      updatedAt: Date.now() - 60_000,
      lastUserMessageAt: Date.now() - 8 * 60_000,
      projectPath: PROJECT,
      targetMode: true,
    } as never,
    ...(workerSessions as never[]),
  ],
  activeSessionId: 'sess-1',
})

// 给探针脚本留一个只读入口（预览专用，不进打包产物）
;(window as unknown as { __officePreview: unknown }).__officePreview = {
  chatStore: useChatStore,
  uiStore: useUIStore,
  configStore: useConfigStore,
}

createRoot(document.getElementById('root')!).render(
  <div className="h-full">
    <OfficeView />
    <NotificationToasts />
  </div>,
)
