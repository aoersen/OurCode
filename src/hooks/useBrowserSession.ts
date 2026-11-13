import { useCallback, useEffect, useState } from 'react'

import type { BrowserSessionState } from '@shared/types'

export const EMPTY_BROWSER_STATE: BrowserSessionState = {
  url: '',
  title: '',
  loading: false,
  visible: false,
  canGoBack: false,
  canGoForward: false,
}

/**
 * Shared view of the main-process agent browser session.
 *
 * The window lives in the main process; both the chat bubble and the Settings
 * section need its state (visible / url / title) and a way to show or hide it.
 * State events keep every subscriber in sync; `refresh` covers the mount case
 * (e.g. the bubble appears after the agent already navigated).
 */
export function useBrowserSession() {
  const [state, setState] = useState<BrowserSessionState>(EMPTY_BROWSER_STATE)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState(await window.electronAPI.browserState())
    } catch {
      /* main process not ready */
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = window.electronAPI.onBrowserEvent((payload) => {
      if (payload.type === 'state') setState(payload.state)
    })
    return off
  }, [refresh])

  const setVisible = useCallback(async (visible: boolean): Promise<BrowserSessionState | null> => {
    try {
      const next = await window.electronAPI.browserSetVisible(visible)
      setState(next)
      return next
    } catch {
      return null
    }
  }, [])

  return { state, refresh, setVisible }
}
