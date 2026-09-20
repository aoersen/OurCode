/**
 * Navigation boundary for app-owned windows.
 *
 * The renderer displays untrusted content (HTML preview of whatever file is
 * open, markdown, and now the agent-driven browser), so a single successful
 * top-level navigation to a remote page would put attacker-controlled script
 * next to the full IPC surface the preload exposes. These guards pin every
 * app window to the app's own origins and hand anything else to the OS browser.
 *
 * The one exception is the agent browser session, which navigates wherever the
 * task requires: it opts in by webContents id and is still restricted to http(s).
 */
import { fileURLToPath } from 'url'

export type NavigationAction = 'allow' | 'open-external' | 'deny'

/** webContents ids allowed to reach any http(s) site — the agent browser only.
 *  Owned here so both the guard and the browser session can see it without
 *  importing the main entry module. */
const arbitraryNavigationIds = new Set<number>()

export function allowArbitraryNavigation(webContentsId: number): void {
  arbitraryNavigationIds.add(webContentsId)
}

export function revokeArbitraryNavigation(webContentsId: number): void {
  arbitraryNavigationIds.delete(webContentsId)
}

export function hasArbitraryNavigation(webContentsId: number): boolean {
  return arbitraryNavigationIds.has(webContentsId)
}

export interface NavigationPolicy {
  /** Dev-server origin (electron-vite), e.g. http://localhost:5173 — empty in
   *  a packaged build, where the renderer is loaded from file://. */
  devOrigin?: string
  /** Directory the packaged renderer lives in (file:// URLs under it are ours). */
  rendererDir?: string
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`
}

/** True for the URLs our own windows legitimately load. */
export function isInternalUrl(rawUrl: string, policy: NavigationPolicy): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  switch (url.protocol) {
    case 'about:':
      return url.hostname === 'blank' || url.href === 'about:blank'
    case 'ourcode-file:':
      // The app's own local-file preview scheme (see registerPreviewProtocol).
      return true
    case 'file:': {
      const dir = policy.rendererDir
      if (!dir) return false
      // fileURLToPath, not url.pathname: on Windows the pathname is
      // "/E:/ls/…" with a leading slash, which never prefix-matches "E:\ls\…".
      let target: string
      try {
        target = fileURLToPath(url)
      } catch {
        return false
      }
      const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
      const candidate = norm(target)
      const root = norm(dir)
      return candidate === root || candidate.startsWith(`${root}/`)
    }
    case 'http:':
    case 'https:':
      return !!policy.devOrigin && originOf(url) === policy.devOrigin
    default:
      return false
  }
}

/**
 * Decide what to do with a top-level navigation or window.open request.
 *
 * `arbitrary` marks the agent browser's webContents: it may reach any http(s)
 * site, but never the local filesystem or the app's own origins — a page it
 * loads must not be able to read the workspace through ourcode-file:// or
 * reach the app UI.
 */
export function decideNavigation(rawUrl: string, policy: NavigationPolicy, arbitrary: boolean): NavigationAction {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'deny'
  }
  if (arbitrary) {
    return url.protocol === 'http:' || url.protocol === 'https:' ? 'allow' : 'deny'
  }
  if (isInternalUrl(rawUrl, policy)) return 'allow'
  if (url.protocol === 'http:' || url.protocol === 'https:') return 'open-external'
  return 'deny'
}
