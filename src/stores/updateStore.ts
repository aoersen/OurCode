import { create } from 'zustand'

/**
 * Auto-update UI state, shared by the status bar indicator and the update
 * dialog. The main process is the source of truth (electron-updater events
 * arrive via `window.electronAPI.onUpdateStatus` / `onUpdateProgress`); this
 * store translates them into a small state machine:
 *
 *   idle → checking → available → downloading → downloaded
 *                     └→ error (retry → checking)
 *
 * Auto checks (source === 'auto') stay quiet unless an update is actually
 * found — their checking/not-available/error phases never surface in the UI.
 */

export type UpdateUiState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateStatusPayload {
  state: string
  source?: 'auto' | 'manual'
  version?: string
  releaseNotes?: string
  releaseDate?: string
  message?: string
}

interface UpdateStoreState {
  appVersion: string
  uiState: UpdateUiState
  newVersion: string
  releaseNotes: string
  releaseDate: string
  downloadPercent: number
  errorMessage: string
  /** The user dismissed the dialog this session; don't re-pop it until the
   *  next check finds something new. */
  dialogDismissed: boolean

  /** One-time wiring: fetch app version + subscribe to main-process pushes. */
  init: () => () => void
  /** Manual check (status bar version click / settings button). */
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => void
  dismissDialog: () => void
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
  appVersion: '',
  uiState: 'idle',
  newVersion: '',
  releaseNotes: '',
  releaseDate: '',
  downloadPercent: 0,
  errorMessage: '',
  dialogDismissed: false,

  init: () => {
    void window.electronAPI.getVersion().then((version) => {
      if (version) set({ appVersion: version })
    }).catch(() => { /* ignore */ })

    const cleanupStatus = window.electronAPI.onUpdateStatus((status: UpdateStatusPayload) => {
      if (status.state === 'available') {
        set({
          uiState: 'available',
          newVersion: status.version || '',
          releaseNotes: status.releaseNotes || '',
          releaseDate: status.releaseDate || '',
          // A newly found version may re-open the dialog even if an older one
          // was dismissed earlier this session.
          dialogDismissed: false,
        })
      } else if (status.state === 'not-available') {
        set({ uiState: 'idle' })
      } else if (status.state === 'downloaded') {
        set({ uiState: 'downloaded', dialogDismissed: false })
      } else if (status.state === 'error') {
        // Only surface failures from manual checks — background auto checks
        // fail silently (the main process doesn't even broadcast those).
        set({ uiState: 'error', errorMessage: status.message || '' })
      }
    })

    const cleanupProgress = window.electronAPI.onUpdateProgress((progress) => {
      set({ uiState: 'downloading', downloadPercent: progress.percent })
    })

    return () => {
      cleanupStatus()
      cleanupProgress()
    }
  },

  check: async () => {
    set({ uiState: 'checking', errorMessage: '' })
    try {
      const result = await window.electronAPI.checkForUpdate()
      if (result.state === 'available') {
        set({
          uiState: 'available',
          newVersion: result.version || '',
          releaseNotes: result.releaseNotes || '',
          releaseDate: result.releaseDate || '',
          dialogDismissed: false,
        })
      } else if (result.state === 'error') {
        set({ uiState: 'error', errorMessage: result.message || '' })
      } else {
        set({ uiState: 'idle' })
      }
    } catch {
      // The IPC layer itself failed — treat as a check error.
      set({ uiState: 'error', errorMessage: '' })
    }
  },

  download: async () => {
    set({ uiState: 'downloading' })
    try {
      const result = await window.electronAPI.downloadUpdate()
      if (result.state === 'error') {
        set({ uiState: 'error', errorMessage: result.message || '' })
      }
    } catch {
      set({ uiState: 'error', errorMessage: '' })
    }
  },

  install: () => {
    window.electronAPI.installUpdate()
  },

  dismissDialog: () => {
    set({ dialogDismissed: true })
  },
}))
