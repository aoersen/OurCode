import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { useEditorStore } from './stores/editorStore'
import { useUIStore } from './stores/uiStore'
import { DEFAULT_PREFERENCES } from './types'
import { setLocale, resolveLocale, setSystemLocale, getSystemLocale, type LanguagePreference } from './i18n'
import { installBudgetFuse, flushBudgetWrites } from './services/targetMode/budget'
import { IS_OFFICE } from './utils/windowMode'

/**
 * Load persisted preferences + system locale BEFORE the first render so the
 * initial language is applied without a flash of the default locale. The
 * splash screen in index.html stays visible while these async calls run.
 */
async function bootstrap(): Promise<void> {
  try {
    const prefs = await window.electronAPI.getPreferences()
    useEditorStore.setState({ preferences: { ...DEFAULT_PREFERENCES, ...prefs } })
  } catch {
    // Keep store defaults if preferences can't be read
  }
  try {
    setSystemLocale(await window.electronAPI.getLocale())
  } catch {
    // Falls back to navigator.language inside the i18n module
  }
  setLocale(resolveLocale(
    useEditorStore.getState().preferences.language as LanguagePreference,
    getSystemLocale(),
  ))
  // Target-mode budget fuse (v2 §13.3): listens for usage-recorded events and
  // accumulates per target-mode session; only consulted by target-mode auto-resume.
  installBudgetFuse()
  // 预算累计是节流落盘的（5s）；关窗前把最后一次累计写回 budget.md，避免
  // 重启后从更早的持久值继续（用量会少记最后一小段）。
  window.addEventListener('beforeunload', () => { flushBudgetWrites() })

  // 一人公司独立窗口：落地即为 3D 办公室视图。办公室窗口不带右侧聊天面板
  // （isChatVisible 恒为 false），侧栏（工作区时显示项目列表）常驻。
  if (IS_OFFICE) {
    useUIStore.setState({
      activeSidebarTab: 'office',
      isChatVisible: false,
    })
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
