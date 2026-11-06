import { createContext, useContext } from 'react'

/**
 * Whether the sidebar panel a component lives in is the VISIBLE one.
 *
 * The sidebar keeps every visited panel mounted and only hides the inactive
 * ones (see Sidebar.tsx) so switching tabs never re-runs a panel's mount
 * effects — those effects are the expensive part (chokidar watcher restart,
 * `git status` subprocess, skills/config IPC fan-out). The trade-off is that a
 * hidden panel's timers and event subscriptions keep running, so panels
 * subscribe to this flag and pause background work while they are off screen.
 *
 * Defaults to `true`: panels rendered outside the sidebar (office view, quick
 * open, standalone modals) always count as visible.
 */
const PanelActivityContext = createContext(true)

export const PanelActivityProvider = PanelActivityContext.Provider

export function usePanelActive(): boolean {
  return useContext(PanelActivityContext)
}
