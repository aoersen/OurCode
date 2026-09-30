import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useUpdateStore } from '@/stores/updateStore'

// The store reads window.electronAPI only inside its actions (never at module
// load), so a per-test stub is enough. Each test swaps in fresh mocks and a
// fresh set of push-event subscribers, mirroring the preload surface.
type StatusListener = (status: {
  state: string
  source?: 'auto' | 'manual'
  version?: string
  releaseNotes?: string
  releaseDate?: string
  message?: string
}) => void
type ProgressListener = (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void

const statusListeners: StatusListener[] = []
const progressListeners: ProgressListener[] = []

const electronApi = {
  getVersion: vi.fn(async () => '0.3.1'),
  checkForUpdate: vi.fn(),
  downloadUpdate: vi.fn(),
  installUpdate: vi.fn(),
  setUpdateFeedUrl: vi.fn(async () => ({ ok: true })),
  onUpdateStatus: vi.fn((cb: StatusListener) => {
    statusListeners.push(cb)
    return () => {
      const i = statusListeners.indexOf(cb)
      if (i >= 0) statusListeners.splice(i, 1)
    }
  }),
  onUpdateProgress: vi.fn((cb: ProgressListener) => {
    progressListeners.push(cb)
    return () => {
      const i = progressListeners.indexOf(cb)
      if (i >= 0) progressListeners.splice(i, 1)
    }
  }),
}

vi.stubGlobal('window', { electronAPI: electronApi })

const initialState = useUpdateStore.getState()

beforeEach(() => {
  useUpdateStore.setState(initialState)
  statusListeners.length = 0
  progressListeners.length = 0
  vi.clearAllMocks()
  electronApi.getVersion.mockResolvedValue('0.3.1')
})

describe('updateStore init', () => {
  it('fetches the app version and subscribes to status/progress pushes', async () => {
    const cleanup = useUpdateStore.getState().init()
    expect(electronApi.onUpdateStatus).toHaveBeenCalledTimes(1)
    expect(electronApi.onUpdateProgress).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(useUpdateStore.getState().appVersion).toBe('0.3.1'))
    cleanup()
    expect(statusListeners).toHaveLength(0)
  })

  it('survives a version fetch failure', async () => {
    electronApi.getVersion.mockRejectedValueOnce(new Error('ipc down'))
    useUpdateStore.getState().init()
    await new Promise((r) => setTimeout(r, 0))
    expect(useUpdateStore.getState().appVersion).toBe('')
  })
})

describe('updateStore state machine', () => {
  it('manual check: idle → checking → available with metadata', async () => {
    electronApi.checkForUpdate.mockResolvedValueOnce({
      state: 'available',
      version: '0.4.0',
      releaseNotes: 'notes',
      releaseDate: '2026-09-28',
    })
    const promise = useUpdateStore.getState().check()
    expect(useUpdateStore.getState().uiState).toBe('checking')
    await promise
    const s = useUpdateStore.getState()
    expect(s.uiState).toBe('available')
    expect(s.newVersion).toBe('0.4.0')
    expect(s.releaseNotes).toBe('notes')
    expect(s.dialogDismissed).toBe(false)
  })

  it('manual check: not-available returns to idle', async () => {
    electronApi.checkForUpdate.mockResolvedValueOnce({ state: 'not-available' })
    await useUpdateStore.getState().check()
    expect(useUpdateStore.getState().uiState).toBe('idle')
  })

  it('manual check: error state keeps the message', async () => {
    electronApi.checkForUpdate.mockResolvedValueOnce({ state: 'error', message: '404' })
    await useUpdateStore.getState().check()
    const s = useUpdateStore.getState()
    expect(s.uiState).toBe('error')
    expect(s.errorMessage).toBe('404')
  })

  it('push: available (auto source) reopens a previously dismissed dialog', () => {
    useUpdateStore.setState({ dialogDismissed: true })
    const cleanup = useUpdateStore.getState().init()
    statusListeners[0]?.({ state: 'available', source: 'auto', version: '1.0.0' })
    const s = useUpdateStore.getState()
    expect(s.uiState).toBe('available')
    expect(s.newVersion).toBe('1.0.0')
    expect(s.dialogDismissed).toBe(false)
    cleanup()
  })

  it('push: download progress drives the downloading state', () => {
    const cleanup = useUpdateStore.getState().init()
    progressListeners[0]?.({ percent: 66, bytesPerSecond: 1, transferred: 2, total: 3 })
    expect(useUpdateStore.getState().uiState).toBe('downloading')
    expect(useUpdateStore.getState().downloadPercent).toBe(66)
    cleanup()
  })

  it('push: downloaded reopens the dialog for the restart prompt', () => {
    useUpdateStore.setState({ dialogDismissed: true })
    const cleanup = useUpdateStore.getState().init()
    statusListeners[0]?.({ state: 'downloaded' })
    const s = useUpdateStore.getState()
    expect(s.uiState).toBe('downloaded')
    expect(s.dialogDismissed).toBe(false)
    cleanup()
  })

  it('push: not-available and error update the state', () => {
    const cleanup = useUpdateStore.getState().init()
    statusListeners[0]?.({ state: 'not-available' })
    expect(useUpdateStore.getState().uiState).toBe('idle')
    statusListeners[0]?.({ state: 'error', message: 'boom' })
    expect(useUpdateStore.getState().uiState).toBe('error')
    expect(useUpdateStore.getState().errorMessage).toBe('boom')
    cleanup()
  })
})

describe('updateStore actions', () => {
  it('download: success stays in downloading (downloaded arrives via push)', async () => {
    electronApi.downloadUpdate.mockResolvedValueOnce({ state: 'downloading' })
    await useUpdateStore.getState().download()
    expect(useUpdateStore.getState().uiState).toBe('downloading')
  })

  it('download: failure moves to error', async () => {
    electronApi.downloadUpdate.mockResolvedValueOnce({ state: 'error', message: 'disk full' })
    await useUpdateStore.getState().download()
    const s = useUpdateStore.getState()
    expect(s.uiState).toBe('error')
    expect(s.errorMessage).toBe('disk full')
  })

  it('install delegates to the preload API', () => {
    useUpdateStore.getState().install()
    expect(electronApi.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('dismissDialog sets the session-wide flag', () => {
    useUpdateStore.getState().dismissDialog()
    expect(useUpdateStore.getState().dialogDismissed).toBe(true)
  })
})
