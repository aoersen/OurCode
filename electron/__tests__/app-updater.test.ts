import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AppUpdater } from '../services/app-updater'
import { DEFAULT_PREFERENCES, IPC_CHANNELS } from '@shared/constants'
import type { UserPreferences } from '@shared/types'

const mocks = vi.hoisted(() => {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    setFeedURL: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = (listeners[event] ??= [])
      list.push(cb)
    }),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  }
  return { listeners, autoUpdater }
})

vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }))

const emit = (event: string, ...args: unknown[]) => {
  for (const cb of mocks.listeners[event] ?? []) cb(...args)
}

function makeUpdater(overrides: { isDev?: boolean; prefs?: Partial<UserPreferences> } = {}) {
  const broadcast = vi.fn()
  const updater = new AppUpdater({
    isDev: overrides.isDev ?? false,
    getPreferences: () => ({ ...DEFAULT_PREFERENCES, ...overrides.prefs }) as UserPreferences,
    broadcast,
  })
  return { updater, broadcast }
}

describe('AppUpdater', () => {
  let resourcesDir: string

  beforeEach(() => {
    resourcesDir = mkdtempSync(join(tmpdir(), 'app-updater-test-'))
    Object.defineProperty(process, 'resourcesPath', { value: resourcesDir, configurable: true })
    vi.clearAllMocks()
    mocks.listeners['update-available'] = []
    mocks.listeners['update-not-available'] = []
    mocks.listeners['download-progress'] = []
    mocks.listeners['update-downloaded'] = []
    mocks.listeners['error'] = []
  })

  afterEach(() => {
    rmSync(resourcesDir, { recursive: true, force: true })
  })

  describe('init', () => {
    it('configures the updater and registers event listeners in packaged builds', () => {
      const { updater } = makeUpdater()
      updater.init()
      expect(mocks.autoUpdater.autoDownload).toBe(false)
      expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(false)
      expect(mocks.autoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function))
      expect(mocks.autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function))
    })

    it('is a no-op in dev', () => {
      const { updater } = makeUpdater({ isDev: true })
      updater.init()
      expect(mocks.autoUpdater.on).not.toHaveBeenCalled()
    })

    it('applies a custom feed from preferences on startup', () => {
      const { updater } = makeUpdater({ prefs: { updateFeedUrl: 'https://updates.example.com/base/' } })
      updater.init()
      expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'https://updates.example.com/base' })
    })
  })

  describe('check', () => {
    it('returns not-available immediately in dev', async () => {
      const { updater } = makeUpdater({ isDev: true })
      await expect(updater.check('manual')).resolves.toEqual({ state: 'not-available' })
      expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    })

    it('returns the update info when an update is available', async () => {
      mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({
        updateInfo: { version: '9.9.9', releaseNotes: 'notes', releaseDate: '2026-09-28' },
      })
      const { updater } = makeUpdater()
      await expect(updater.check('manual')).resolves.toEqual({
        state: 'available',
        version: '9.9.9',
        releaseNotes: 'notes',
        releaseDate: '2026-09-28',
      })
    })

    it('joins array release notes into markdown text', async () => {
      mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({
        updateInfo: { version: '9.9.9', releaseNotes: [{ version: '9.9.9', note: 'a' }, { version: '9.9.9', note: null }, { version: '9.9.9', note: 'b' }] },
      })
      const { updater } = makeUpdater()
      const result = await updater.check('manual')
      expect(result.releaseNotes).toBe('a\n\nb')
    })

    it('returns not-available when nothing was found', async () => {
      mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce(null)
      const { updater } = makeUpdater()
      await expect(updater.check('auto')).resolves.toEqual({ state: 'not-available' })
    })

    it('returns error with the message when the check throws', async () => {
      mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('network down'))
      const { updater } = makeUpdater()
      await expect(updater.check('manual')).resolves.toEqual({ state: 'error', message: 'network down' })
    })
  })

  describe('broadcast policy', () => {
    it('broadcasts update-available with the check source', () => {
      const { updater, broadcast } = makeUpdater()
      updater.init()
      void updater.check('auto')
      emit('update-available', { version: '9.9.9' })
      expect(broadcast).toHaveBeenCalledWith(IPC_CHANNELS.UPDATE_STATUS, expect.objectContaining({ state: 'available', source: 'auto', version: '9.9.9' }))
    })

    it('stays silent on not-available for auto checks', () => {
      const { updater, broadcast } = makeUpdater()
      updater.init()
      void updater.check('auto')
      emit('update-not-available')
      expect(broadcast).not.toHaveBeenCalled()
    })

    it('broadcasts not-available for manual checks', () => {
      const { updater, broadcast } = makeUpdater()
      updater.init()
      void updater.check('manual')
      emit('update-not-available')
      expect(broadcast).toHaveBeenCalledWith(IPC_CHANNELS.UPDATE_STATUS, { state: 'not-available' })
    })

    it('stays silent on error for auto checks', () => {
      const { updater, broadcast } = makeUpdater()
      updater.init()
      void updater.check('auto')
      emit('error', new Error('offline'))
      expect(broadcast).not.toHaveBeenCalled()
    })

    it('broadcasts error for manual checks', () => {
      const { updater, broadcast } = makeUpdater()
      updater.init()
      void updater.check('manual')
      emit('error', new Error('offline'))
      expect(broadcast).toHaveBeenCalledWith(IPC_CHANNELS.UPDATE_STATUS, { state: 'error', message: 'offline' })
    })

    it('broadcasts download progress and downloaded', () => {
      const { updater, broadcast } = makeUpdater()
      updater.init()
      emit('download-progress', { percent: 42, bytesPerSecond: 1000, transferred: 420, total: 1000 })
      emit('update-downloaded')
      expect(broadcast).toHaveBeenCalledWith(IPC_CHANNELS.UPDATE_PROGRESS, expect.objectContaining({ percent: 42 }))
      expect(broadcast).toHaveBeenCalledWith(IPC_CHANNELS.UPDATE_STATUS, { state: 'downloaded' })
    })
  })

  describe('silent auto-download', () => {
    it('starts a download when update-available fires and the pref is on', () => {
      const { updater } = makeUpdater({ prefs: { autoUpdateDownload: true } })
      updater.init()
      emit('update-available', { version: '9.9.9' })
      expect(mocks.autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    })

    it('does not download when the pref is off', () => {
      const { updater } = makeUpdater()
      updater.init()
      emit('update-available', { version: '9.9.9' })
      expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled()
    })
  })

  describe('download / install', () => {
    it('download returns downloading on success and error on failure', async () => {
      const { updater } = makeUpdater()
      mocks.autoUpdater.downloadUpdate.mockResolvedValueOnce([])
      await expect(updater.download()).resolves.toEqual({ state: 'downloading' })
      mocks.autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('disk full'))
      await expect(updater.download()).resolves.toEqual({ state: 'error', message: 'disk full' })
    })

    it('install delegates to quitAndInstall', () => {
      const { updater } = makeUpdater()
      updater.install()
      expect(mocks.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    })
  })

  describe('applyFeed', () => {
    it('trims trailing slashes and uses the generic provider', () => {
      const { updater } = makeUpdater()
      updater.applyFeed('  https://mirror.example.com/updates/// ')
      expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'https://mirror.example.com/updates' })
    })

    it('restores the packaged default feed from app-update.yml when the URL is empty', () => {
      mkdirSync(resourcesDir, { recursive: true })
      writeFileSync(join(resourcesDir, 'app-update.yml'), 'provider: github\nowner: aoersen\nrepo: OurCode\n')
      const { updater } = makeUpdater()
      updater.applyFeed('')
      expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ provider: 'github', owner: 'aoersen', repo: 'OurCode' }))
    })

    it('survives a missing app-update.yml', () => {
      const { updater } = makeUpdater()
      expect(() => updater.applyFeed('')).not.toThrow()
    })
  })

  describe('scheduleStartupCheck', () => {
    it('checks after the delay when auto-check is enabled', () => {
      vi.useFakeTimers()
      const { updater } = makeUpdater()
      mocks.autoUpdater.checkForUpdates.mockResolvedValue(null)
      updater.scheduleStartupCheck(10000)
      expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
      vi.advanceTimersByTime(9999)
      expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })

    it('does not schedule when auto-check is disabled', () => {
      vi.useFakeTimers()
      const { updater } = makeUpdater({ prefs: { autoUpdateCheck: false } })
      updater.scheduleStartupCheck(10000)
      vi.advanceTimersByTime(60000)
      expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('does not schedule in dev', () => {
      vi.useFakeTimers()
      const { updater } = makeUpdater({ isDev: true })
      updater.scheduleStartupCheck(10000)
      vi.advanceTimersByTime(60000)
      expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled()
      vi.useRealTimers()
    })
  })
})
