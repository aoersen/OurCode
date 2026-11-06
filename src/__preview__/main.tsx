/**
 * Local-only render harness for the welcome hub: seeds the stores with a
 * realistic workspace so the screen can be screenshotted at 1440x900 without
 * booting Electron. Not part of any app bundle.
 */
import { createRoot } from 'react-dom/client'
import '@/styles/global.css'
import { useUIStore } from '@/stores/uiStore'
import { useChatStore } from '@/stores/chatStore'
import { useConfigStore } from '@/stores/configStore'
import { useEditorStore } from '@/stores/editorStore'
import WelcomeHub from '@/components/Welcome/WelcomeHub'

// Preload the welcome screen inside the same glass panel the real layout uses.
const params = new URLSearchParams(location.search)
const state = params.get('state') ?? 'normal'
const dark = params.get('theme') === 'dark'

document.documentElement.classList.toggle('dark', dark)

// --- electron bridge stubs -------------------------------------------------
;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  mcpGetGlobalConfig: async () => ({
    ok: true,
    file: null,
    config: { mcpServers: { stitch: {}, playwright: {}, filesystem: {}, git: {} } },
  }),
  mcpGetConfig: async () => ({
    ok: true,
    file: null,
    config: { mcpServers: {} },
  }),
}

// --- store seeds -----------------------------------------------------------
const modelParams = {
  temperature: 0.7,
  maxTokens: 4096,
  topP: 1,
  frequencyPenalty: 0,
  presencePenalty: 0,
  thinking: false,
  reasoningEffort: 'medium' as const,
}

useConfigStore.setState({
  configGroups: state === 'firstrun'
    ? []
    : [{
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
      }],
  activeConfigGroupId: state === 'firstrun' ? null : 'cfg-1',
})

useUIStore.setState({
  rootPath: 'C:\\workspace\\ourcode',
  recentProjects: ['C:\\workspace\\ourcode'],
})

useChatStore.setState({
  sessions: state === 'firstrun'
    ? []
    : [{
        id: 'sess-1',
        title: '重构认证中间件与 Cookie 签名',
        configGroupId: 'cfg-1',
        model: 'deepseek-chat',
        modelParams,
        messages: [{ id: 'm1' } as never],
        createdAt: Date.now() - 3_600_000,
        updatedAt: Date.now() - 60_000,
        lastUserMessageAt: Date.now() - 8 * 60_000,
        projectPath: 'C:\\workspace\\ourcode',
      }],
  activeSessionId: null,
})

useEditorStore.setState({ isEditorVisible: true } as never)

createRoot(document.getElementById('root')!).render(
  <div className="h-full bg-nova-bg p-2">
    <div className="h-full rounded-xl glass-flat overflow-hidden flex">
      <WelcomeHub />
    </div>
  </div>,
)
