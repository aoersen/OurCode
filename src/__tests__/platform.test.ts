import { describe, it, expect, vi, afterEach } from 'vitest'
import { hostPlatform, shellEnvironmentNote } from '@/utils/platform'

// The helper reads globals at call time; tests stub them per case. Each stub
// is torn down after the test so the suite's setup globals stay intact.
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hostPlatform', () => {
  it('prefers the synchronous electronAPI platform when the bridge exists', () => {
    vi.stubGlobal('window', { electronAPI: { platform: 'darwin' } })
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(hostPlatform()).toBe('darwin')
  })

  it('falls back to navigator.platform legacy tokens without the bridge', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(hostPlatform()).toBe('darwin')

    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(hostPlatform()).toBe('linux')

    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(hostPlatform()).toBe('win32')
  })

  it('returns null when nothing identifies the host', () => {
    vi.stubGlobal('navigator', { platform: 'FreeBSD' })
    expect(hostPlatform()).toBeNull()
  })
})

describe('shellEnvironmentNote', () => {
  it('gives PowerShell guidance on Windows', () => {
    vi.stubGlobal('window', { electronAPI: { platform: 'win32' } })
    expect(shellEnvironmentNote()).toContain('PowerShell')
    expect(shellEnvironmentNote()).not.toContain('bash')
  })

  it('gives bash guidance on macOS and Linux', () => {
    vi.stubGlobal('window', { electronAPI: { platform: 'darwin' } })
    expect(shellEnvironmentNote()).toContain('bash')
    expect(shellEnvironmentNote()).not.toContain('PowerShell')

    vi.stubGlobal('window', { electronAPI: { platform: 'linux' } })
    expect(shellEnvironmentNote()).toContain('bash')
    expect(shellEnvironmentNote()).not.toContain('PowerShell')
  })

  it('keeps platform-neutral guidance when unknown', () => {
    vi.stubGlobal('navigator', { platform: 'FreeBSD' })
    expect(shellEnvironmentNote()).toContain('PowerShell')
    expect(shellEnvironmentNote()).toContain('bash')
  })
})
