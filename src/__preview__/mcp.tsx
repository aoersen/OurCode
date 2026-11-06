/**
 * 「MCP 服务器分配」面板 v2 的本地浏览器预览（仅供截图核对，不进任何打包产物）。
 *
 * 用真实组件 + 打桩的 electron 桥：company.json 里放一份「UI 研发 = 自选 3」的
 * 配置，MCP 目录里放 8 个服务器（6 可用 / 2 不可用）+ 1 个已失效条目，
 * 覆盖「跟随默认 / 自选 / 失效条目 / 禁用服务器」四种呈现。
 *
 * 启动：npx vite --config vite.config.preview.ts，然后打开 /mcp.html
 */
import { createRoot } from 'react-dom/client'
import '@/styles/global.css'
import { useEditorStore } from '@/stores/editorStore'
import RoleMcpSettingsCard from '@/components/Office/RoleMcpSettingsCard'

const PROJECT = 'C:\\workspace\\ourcode'
const COMPANY_JSON = JSON.stringify({
  mcp: {
    default: 'all',
    roles: { 'tm-ui-developer': ['aioli', 'stitch', 'filesystem', 'postgres'] },
  },
})

const servers = [
  { name: 'aioli', state: 'ready' },
  { name: 'stitch', state: 'ready' },
  { name: 'filesystem', state: 'ready' },
  { name: 'git', state: 'ready' },
  { name: 'playwright', state: 'ready' },
  { name: 'chrome-devtools', state: 'ready' },
  { name: 'memory', state: 'failed' },
  { name: 'postgres', state: 'disabled' },
]

;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
  stat: async () => ({ isFile: true, modifiedAt: 1_700_000_000_000 }),
  readFile: async () => ({ content: COMPANY_JSON }),
  writeFile: async () => undefined,
  createDir: async () => undefined,
  mcpStatus: async () => servers,
}

// 语言偏好：预览固定中文
useEditorStore.setState((s) => ({ preferences: { ...s.preferences, language: 'zh-CN' as const } }))

createRoot(document.getElementById('root')!).render(
  <div className="h-full" style={{ background: '#F6F7FB' }}>
    <RoleMcpSettingsCard projectPath={PROJECT} onClose={() => undefined} />
  </div>,
)
