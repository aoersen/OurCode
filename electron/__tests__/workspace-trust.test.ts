import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { WorkspaceTrust, canonicalDir, isWithinDir, type TrustPersistence } from '../services/workspace-trust'

/**
 * The fs allowlist is only as good as the decision that feeds it. These tests
 * pin the rule that replaced "the renderer says so": a path is reachable only
 * after the user answered a native dialog for it (or for one of its parents),
 * and that answer survives a restart.
 */

function memoryStore(seed: string[] = []): TrustPersistence & { rows: string[] } {
  const rows = [...seed]
  return {
    rows,
    load: () => [...rows],
    add: (p) => {
      if (!rows.includes(p)) rows.push(p)
    },
    remove: (p) => {
      const i = rows.indexOf(p)
      if (i >= 0) rows.splice(i, 1)
    },
  }
}

let base = ''
beforeEach(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'ourcode-trust-'))
  mkdirSync(join(base, 'project'), { recursive: true })
  mkdirSync(join(base, 'project', 'src'), { recursive: true })
  mkdirSync(join(base, 'other'), { recursive: true })
})

const clean = () => {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* temp dirs get collected by the OS */
  }
}

describe('canonicalDir', () => {
  it('resolves a lexical parent escape', () => {
    const escaped = canonicalDir(join(base, 'project', '..', 'other'))
    expect(escaped).toBe(canonicalDir(join(base, 'other')))
  })

  it('survives a path that does not exist yet', () => {
    const missing = canonicalDir(join(base, 'project', 'new', 'file.ts'))
    // The existing part is still resolved, so the remainder hangs off the real dir.
    expect(missing.startsWith(canonicalDir(join(base, 'project')))).toBe(true)
  })

  it('is stable across slash direction and case noise on Windows', () => {
    const a = canonicalDir(join(base, 'project'))
    const b = canonicalDir(a.replace(/\\/g, '/'))
    expect(a).toBe(b)
  })
})

describe('WorkspaceTrust', () => {
  it('refuses a path nobody granted', () => {
    const trust = new WorkspaceTrust(memoryStore())
    expect(trust.isTrusted(join(base, 'project'))).toBe(false)
    clean()
  })

  it('covers the whole tree below a granted folder, but not its siblings', () => {
    const trust = new WorkspaceTrust(memoryStore())
    const project = join(base, 'project')
    trust.grant(project)
    expect(trust.isTrusted(project)).toBe(true)
    expect(trust.isTrusted(join(project, 'src'))).toBe(true)
    // A shared string prefix is not containment: 'project-evil' ≠ under 'project'
    const evil = join(base, 'project-evil')
    mkdirSync(evil, { recursive: true })
    expect(trust.isTrusted(evil)).toBe(false)
    expect(trust.isTrusted(join(base, 'other'))).toBe(false)
    clean()
  })

  it('lets an escape attempt through .. be seen for what it is', () => {
    const trust = new WorkspaceTrust(memoryStore())
    trust.grant(join(base, 'project'))
    expect(trust.isTrusted(join(base, 'project', '..', '..', '..'))).toBe(false)
    clean()
  })

  it('keeps grants across a restart and forgets them on revoke', () => {
    const rows = memoryStore()
    const project = join(base, 'project')
    new WorkspaceTrust(rows).grant(project)

    const reopened = new WorkspaceTrust(rows)
    expect(reopened.isTrusted(project)).toBe(true)

    reopened.revoke(project)
    expect(reopened.isTrusted(project)).toBe(false)
    // Spelling the same folder differently must still match the stored grant.
    expect(new WorkspaceTrust(rows).isTrusted(project.replace(/\\/g, '/'))).toBe(false)
    expect(rows.rows).toHaveLength(0)
    clean()
  })

  it('treats the app data dir and everything under it as owned', () => {
    const trust = new WorkspaceTrust(memoryStore())
    trust.addAppOwned(base)
    expect(trust.isTrusted(join(base, 'project', 'src'))).toBe(true)
    expect(trust.isTrusted(join(base, 'spill'))).toBe(true)
    clean()
  })

  it('grants are idempotent and empty paths never match', () => {
    const rows = memoryStore()
    const trust = new WorkspaceTrust(rows)
    const project = join(base, 'project')
    trust.grant(project)
    trust.grant(project)
    expect(rows.rows).toHaveLength(1)
    expect(trust.isTrusted('')).toBe(false)
    clean()
  })

  it('reads an existing seed as already granted', () => {
    const project = join(base, 'project')
    const trust = new WorkspaceTrust(memoryStore([canonicalDir(project)]))
    expect(trust.isTrusted(project)).toBe(true)
    clean()
  })
})

describe('symlink escape', () => {
  // Creating links needs privileges that are not always available (Windows
  // developer mode, container filesystems); skip quietly when the platform
  // refuses rather than shipping a test that fails for the wrong reason.
  let sandbox = ''
  let outside = ''
  let workspace = ''
  let made = false
  try {
    const root = realpathSync(tmpdir())
    outside = mkdtempSync(join(root, 'ourcode-trust-out-'))
    sandbox = mkdtempSync(join(root, 'ourcode-trust-link-'))
    workspace = join(sandbox, 'workspace')
    mkdirSync(workspace, { recursive: true })
    symlinkSync(outside, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    made = true
  } catch {
    made = false
  }

  const maybe = made ? it : it.skip

  maybe('a link inside a granted root does not widen the root', () => {
    const trust = new WorkspaceTrust(memoryStore())
    trust.grant(workspace)
    expect(trust.isTrusted(workspace)).toBe(true)
    // <workspace>/link resolves outside the granted root, so it is not in it.
    expect(trust.isTrusted(join(workspace, 'link'))).toBe(false)
    expect(trust.isTrusted(join(workspace, 'link', 'file.txt'))).toBe(false)
    try {
      rmSync(sandbox, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    } catch {
      /* temp dirs get collected by the OS */
    }
  })
})

describe('isWithinDir — the boundary rule itself', () => {
  afterEach(clean)
  // Purely lexical: isWithinDir never touches the filesystem, so these paths
  // don't have to exist. Built with join() so they read the same on win32.
  const root = join(base || '/seed', 'project')

  it('matches the root and its descendants', () => {
    expect(isWithinDir(root, root)).toBe(true)
    expect(isWithinDir(root, join(root, 'src', 'a.ts'))).toBe(true)
  })

  it('rejects a sibling that shares the name as a string prefix', () => {
    expect(isWithinDir(root, root + '-evil')).toBe(false)
    expect(isWithinDir(root, join(root, 'sub', '..', 'x'))).toBe(true) // '..' is canonicalDir's job, not this predicate's
  })

  it('accepts a root written with a trailing separator', () => {
    // realpath of a drive root keeps it ('c:\'), so this spelling is live.
    expect(isWithinDir(root + sep, join(root, 'src'))).toBe(true)
  })

  it('handles the filesystem root without doubling its separator', () => {
    expect(isWithinDir('/', '/etc/passwd')).toBe(true)
    expect(isWithinDir('/', join('some', 'where'))).toBe(false)
  })

  it('never matches on empty inputs', () => {
    expect(isWithinDir('', '/x')).toBe(false)
    expect(isWithinDir('/x', '')).toBe(false)
  })
})
