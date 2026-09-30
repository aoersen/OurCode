/**
 * Auto-update orchestration (electron-updater).
 *
 * Wraps the updater singleton so main.ts stays a thin IPC bridge and the logic
 * is unit-testable without spinning up Electron. Responsibilities:
 *
 *  - feed selection: a custom generic URL from preferences.updateFeedUrl wins,
 *    otherwise the packaged default (app-update.yml → GitHub Releases);
 *  - event fan-out to the renderer via `broadcast`;
 *  - startup auto-check (silent — only "update available" disturbs the user);
 *  - optional silent download when preferences.autoUpdateDownload is on.
 *
 * Events are broadcast with a `source` ('auto' | 'manual') so the renderer can
 * stay quiet for background checks: a failed/empty auto-check must not nag the
 * user on every launch.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { IPC_CHANNELS } from '../../shared/constants'
import type { UserPreferences } from '../../shared/types'

export type UpdateSource = 'auto' | 'manual'

export interface UpdateCheckResult {
  state: 'available' | 'not-available' | 'error'
  version?: string
  releaseNotes?: string
  releaseDate?: string
  message?: string
}

export interface AppUpdaterDeps {
  isDev: boolean
  /** Live preferences reader — settings change without a main-process cache. */
  getPreferences: () => UserPreferences
  broadcast: (channel: string, ...args: unknown[]) => void
}

/** electron-builder ships the effective publish config here (packaged builds). */
const APP_UPDATE_YML = () => join(process.resourcesPath, 'app-update.yml')

export class AppUpdater {
  private deps: AppUpdaterDeps
  private lastCheckSource: UpdateSource = 'manual'

  constructor(deps: AppUpdaterDeps) {
    this.deps = deps
  }

  /** Wire the updater singleton once (non-dev only). */
  init(): void {
    if (this.deps.isDev) return
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    this.applyFeed(this.deps.getPreferences().updateFeedUrl ?? '')
    this.registerEvents()
  }

  /**
   * Point the updater at a feed. Non-empty URL → generic provider (self-hosted
   * or mirror server serving latest.yml + installers). Empty → restore the
   * packaged default from app-update.yml (GitHub Releases).
   */
  applyFeed(url: string): void {
    if (this.deps.isDev) return
    const trimmed = (url ?? '').trim().replace(/\/+$/, '')
    if (trimmed) {
      autoUpdater.setFeedURL({ provider: 'generic', url: trimmed })
      return
    }
    // Restore the default feed bundled into the package.
    try {
      const ymlPath = APP_UPDATE_YML()
      if (!existsSync(ymlPath)) return
      const text = readFileSync(ymlPath, 'utf-8')
      const pick = (key: string): string | undefined =>
        text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim()
      const provider = pick('provider') ?? 'github'
      const base: Record<string, string | undefined> = {
        provider,
        owner: pick('owner'),
        repo: pick('repo'),
        url: pick('url'),
      }
      autoUpdater.setFeedURL(base as never)
    } catch {
      // Keep whatever feed the updater already resolved — never crash the app
      // over a malformed app-update.yml.
    }
  }

  /** Check for updates and return the result directly to the IPC caller. */
  async check(source: UpdateSource): Promise<UpdateCheckResult> {
    if (this.deps.isDev) return { state: 'not-available' }
    this.lastCheckSource = source
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result) {
        const info = result.updateInfo
        return {
          state: 'available',
          version: info.version,
          releaseNotes: normalizeReleaseNotes(info.releaseNotes),
          releaseDate: info.releaseDate,
        }
      }
      return { state: 'not-available' }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      // Manual checks surface the error to the caller (and via the 'error'
      // event below); auto checks fail silently by design.
      return { state: 'error', message }
    }
  }

  async download(): Promise<{ state: 'downloading' | 'not-available' | 'error'; message?: string }> {
    if (this.deps.isDev) return { state: 'not-available' }
    try {
      await autoUpdater.downloadUpdate()
      return { state: 'downloading' }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { state: 'error', message }
    }
  }

  install(): void {
    autoUpdater.quitAndInstall()
  }

  /** Startup auto-check: delayed so a cold launch isn't racing the network.
   *  Silent by construction — only 'available' reaches the renderer. */
  scheduleStartupCheck(delayMs = 10000): void {
    if (this.deps.isDev) return
    if (this.deps.getPreferences().autoUpdateCheck === false) return
    const timer = setTimeout(() => {
      void this.check('auto').catch(() => {
        // check() never throws (it catches internally); guard for safety.
      })
    }, delayMs)
    // Don't keep the app alive just for the check.
    if (typeof timer.unref === 'function') timer.unref()
  }

  private registerEvents(): void {
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.broadcast(IPC_CHANNELS.UPDATE_STATUS, {
        state: 'available',
        source: this.lastCheckSource,
        version: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
      })
      // Silent-download mode: start right away; failures surface through the
      // 'error' event and stay quiet for auto checks.
      if (this.deps.getPreferences().autoUpdateDownload) {
        Promise.resolve(autoUpdater.downloadUpdate()).catch(() => {})
      }
    })

    autoUpdater.on('update-not-available', () => {
      // A background check that found nothing is not news.
      if (this.lastCheckSource === 'manual') {
        this.broadcast(IPC_CHANNELS.UPDATE_STATUS, { state: 'not-available' })
      }
    })

    autoUpdater.on('download-progress', (progress) => {
      this.broadcast(IPC_CHANNELS.UPDATE_PROGRESS, {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    })

    autoUpdater.on('update-downloaded', () => {
      this.broadcast(IPC_CHANNELS.UPDATE_STATUS, { state: 'downloaded' })
    })

    autoUpdater.on('error', (error: Error) => {
      // Same policy as not-available: background failures stay silent so an
      // offline startup doesn't light up the status bar every time.
      if (this.lastCheckSource === 'manual') {
        this.broadcast(IPC_CHANNELS.UPDATE_STATUS, { state: 'error', message: error.message })
      }
    })
  }

  private broadcast(channel: string, payload: unknown): void {
    this.deps.broadcast(channel, payload)
  }
}

/** electron-updater ships release notes as markdown text or a note array. */
function normalizeReleaseNotes(notes: string | Array<{ note: string | null }> | null | undefined): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  return notes.map((n) => n.note).filter((n): n is string => !!n).join('\n\n') || undefined
}
