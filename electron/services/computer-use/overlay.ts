/**
 * Computer Use — "OurCode is using your computer" overlay.
 *
 * A frameless, click-through, always-on-top window that draws a red frame
 * around the window being driven, plus the Esc reminder. It exists so the user
 * can always see that the machine is under automated control — hiding that fact
 * is the one behaviour this feature must never have.
 *
 * The overlay is created lazily, never focusable, and destroyed on shutdown.
 */
import { BrowserWindow, screen } from 'electron'

let overlay: BrowserWindow | null = null

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.frame{position:absolute;inset:0;border:2px solid #ff3b30;border-radius:10px;box-sizing:border-box}
.tag{position:absolute;left:10px;top:10px;padding:4px 9px;border-radius:7px;background:rgba(18,18,22,.88);color:#fff;font-size:12px;line-height:16px;white-space:nowrap}
</style></head><body><div class="frame"></div><div class="tag" id="t">OurCode 正在操作 · Esc 停止</div></body></html>`

function ensureOverlay(): BrowserWindow {
  if (overlay && !overlay.isDestroyed()) return overlay
  overlay = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  overlay.setIgnoreMouseEvents(true, { forward: true })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`).catch(() => undefined)
  overlay.on('closed', () => { overlay = null })
  return overlay
}

/** Physical-pixel window rect → DIP rect, tolerant of older Electron builds. */
function toDipRect(rect: [number, number, number, number]): { x: number; y: number; width: number; height: number } {
  const raw = { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }
  try {
    const convert = (screen as unknown as { screenToDipRect?: (w: null, r: Electron.Rectangle) => Electron.Rectangle }).screenToDipRect
    if (typeof convert === 'function') {
      const dip = convert(null, raw)
      if (dip && Number.isFinite(dip.x) && Number.isFinite(dip.y)) return dip
    }
  } catch { /* fall through to raw */ }
  return raw
}

export interface OverlayTarget {
  app?: string
  kind?: string
  bounds?: [number, number, number, number]
}

/** Show (or move) the frame around a target window. */
export function showOverlay(target: OverlayTarget): void {
  try {
    const win = ensureOverlay()
    const label = `${target.app ? `${target.app} · ` : ''}OurCode 正在操作 · Esc 停止`
    win.webContents.executeJavaScript(
      `(() => { const t = document.getElementById('t'); if (t) t.textContent = ${JSON.stringify(label)}; return true })()`,
    ).catch(() => undefined)
    if (target.bounds) {
      const rect = toDipRect(target.bounds)
      const pad = 6
      win.setBounds({
        x: Math.round(rect.x - pad),
        y: Math.round(rect.y - pad),
        width: Math.max(60, Math.round(rect.width + pad * 2)),
        height: Math.max(40, Math.round(rect.height + pad * 2)),
      })
    }
    win.showInactive()
  } catch {
    // An overlay failure must never block the action itself.
  }
}

export function hideOverlay(): void {
  try {
    if (overlay && !overlay.isDestroyed()) overlay.hide()
  } catch { /* window already gone */ }
}

export function destroyOverlay(): void {
  try {
    if (overlay && !overlay.isDestroyed()) overlay.destroy()
  } catch { /* already destroyed */ }
  overlay = null
}

/** Screen bounds of the cursor's display, used when the target rect is unknown. */
export function cursorDisplayBounds(): [number, number, number, number] | null {
  try {
    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    return [display.bounds.x, display.bounds.y, display.bounds.width, display.bounds.height]
  } catch {
    return null
  }
}
