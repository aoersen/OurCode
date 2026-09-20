import { describe, it, expect } from 'vitest'
import { pathToFileURL } from 'url'
import { join } from 'path'
import { decideNavigation, isInternalUrl } from '../services/navigation-guard'

const DEV = { devOrigin: 'http://localhost:5173' }
// Built with join()/pathToFileURL so the assertions mean the same thing on
// Windows (drive letters) and POSIX — a literal "/app/…" file URL throws inside
// fileURLToPath on Windows and would quietly test the wrong thing.
const RENDERER_DIR = join(process.cwd(), 'dist-electron', 'renderer')
const PACKAGED = { rendererDir: RENDERER_DIR }

describe('isInternalUrl', () => {
  it('accepts the dev-server origin and nothing else over http', () => {
    expect(isInternalUrl('http://localhost:5173/src/main.tsx', DEV)).toBe(true)
    expect(isInternalUrl('https://evil.example/', DEV)).toBe(false)
    expect(isInternalUrl('http://localhost:9999/', DEV)).toBe(false)
  })

  it('accepts only file URLs inside the packaged renderer dir', () => {
    expect(isInternalUrl(pathToFileURL(join(RENDERER_DIR, 'index.html')).href, PACKAGED)).toBe(true)
    expect(isInternalUrl(pathToFileURL(join(process.cwd(), 'secret.env')).href, PACKAGED)).toBe(false)
    // Without a renderer dir (dev), no file: URL is internal.
    expect(isInternalUrl(pathToFileURL(join(RENDERER_DIR, 'index.html')).href, DEV)).toBe(false)
  })

  it('accepts the app preview scheme and about:blank', () => {
    expect(isInternalUrl('ourcode-file://local/E%3A/ls/proj/index.html', {})).toBe(true)
    expect(isInternalUrl('about:blank', {})).toBe(true)
  })

  it('rejects unparseable input rather than throwing', () => {
    expect(isInternalUrl('not a url', DEV)).toBe(false)
    expect(isInternalUrl('', DEV)).toBe(false)
  })
})

describe('decideNavigation', () => {
  it('allows internal URLs in app windows', () => {
    expect(decideNavigation('http://localhost:5173/', DEV, false)).toBe('allow')
  })

  it('sends stray external links from an app window to the OS browser', () => {
    expect(decideNavigation('https://github.com/x/y', DEV, false)).toBe('open-external')
  })

  it('never lets an app window load a scheme the preload cannot be trusted near', () => {
    expect(decideNavigation('file:///etc/passwd', DEV, false)).toBe('deny')
    expect(decideNavigation('javascript:alert(1)', DEV, false)).toBe('deny')
    expect(decideNavigation('chrome://settings', DEV, false)).toBe('deny')
  })

  it('lets the agent browser reach any http(s) site but not the local filesystem', () => {
    expect(decideNavigation('http://localhost:3000/dashboard', DEV, true)).toBe('allow')
    expect(decideNavigation('https://example.com', DEV, true)).toBe('allow')
    // ourcode-file:// would read workspace files into a remote page's context.
    expect(decideNavigation('ourcode-file://local/E%3A/ls/secret.env', DEV, true)).toBe('deny')
    expect(decideNavigation('file:///etc/passwd', DEV, true)).toBe('deny')
    expect(decideNavigation('about:blank', DEV, true)).toBe('deny')
  })

  it('denies garbage', () => {
    expect(decideNavigation('   ', DEV, false)).toBe('deny')
  })
})
