import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/global.css'
import { useEditorStore } from './stores/editorStore'
import { useUIStore } from './stores/uiStore'
import { DEFAULT_PREFERENCES } from './types'
import { setLocale, resolveLocale, setSystemLocale, getSystemLocale, type LanguagePreference } from './i18n'
import { installBudgetFuse } from './services/targetMode/budget'
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

  // 一人公司独立窗口：落地即为 3D 办公室视图。办公室窗口不带右侧聊天面板
  // （isChatVisible 恒为 false），侧栏保持可见且停留在 office 页。
  if (IS_OFFICE) {
    useUIStore.setState({
      activeSidebarTab: 'office',
      isSidebarVisible: true,
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
