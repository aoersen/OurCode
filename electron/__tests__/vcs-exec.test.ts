import { describe, it, expect } from 'vitest'
import {
  checkVcsArgs,
  parseGhAuthStatus,
  GIT_ALLOWED_SUBCOMMANDS,
} from '../services/vcs-exec'

describe('checkVcsArgs (git)', () => {
  it('accepts the commands the app actually runs', () => {
    for (const args of [
      ['status', '--porcelain=v1'],
      ['diff', '--cached', '--', 'src/a.ts'],
      ['log', '-1', '--format=%H|%s'],
      ['show', 'HEAD:src/a.ts'],
      ['commit', '-m', 'message'],
      ['push', '-u', 'origin', 'HEAD'],
      ['checkout', '-b', 'feat/x'],
      ['stash', 'push', '--include-untracked'],
    ]) {
      expect(checkVcsArgs('git', args)).toEqual({ ok: true, bin: 'git', args })
    }
  })

  it('refuses any leading option — that is where -c / --exec-path live', () => {
    const res = checkVcsArgs('git', ['-c', 'core.pager=calc', 'log'])
    expect(res.ok).toBe(false)
  })

  it('refuses subcommands outside the allowlist', () => {
    for (const sub of ['config', 'clone', 'filter-branch', 'cvsexportcommit', 'init']) {
      const res = checkVcsArgs('git', [sub])
      expect(res.ok, sub).toBe(false)
      if (!res.ok) expect(res.error).toContain(sub)
    }
  })

  it('keeps the allowlist to what the app actually sends', () => {
    // `git config` is the persistent RCE primitive (core.pager / core.fsmonitor);
    // clone/clean/init reach outside the working tree or create one.
    for (const sub of ['config', 'clone', 'clean', 'init', 'filter-branch', 'rm', 'mv', 'remote', 'tag']) {
      expect(GIT_ALLOWED_SUBCOMMANDS.has(sub), sub).toBe(false)
    }
    // apply is in only for the diff editor's patch-from-stdin shapes (below).
    expect(GIT_ALLOWED_SUBCOMMANDS.has('apply')).toBe(true)
  })

  it('allows only the patch-from-stdin shapes of `apply`', () => {
    // These four are exactly what GitDiffEditor.tryApplyPatch sends.
    expect(checkVcsArgs('git', ['apply', '--cached', '--whitespace=nowarn', '--check', '-']).ok).toBe(true)
    expect(checkVcsArgs('git', ['apply', '-R', '--whitespace=nowarn', '-']).ok).toBe(true)
    // A positional patch path, or a rewritten target, is not.
    expect(checkVcsArgs('git', ['apply', '/tmp/evil.patch']).ok).toBe(false)
    expect(checkVcsArgs('git', ['apply', '--cached', 'patch.diff']).ok).toBe(false)
    expect(checkVcsArgs('git', ['apply', '--cached', '-R', '--', '../outside']).ok).toBe(false)
    // Shape without the stdin marker is refused too.
    expect(checkVcsArgs('git', ['apply', '--cached']).ok).toBe(false)
  })

  it('blocks dangerous flags wherever they sit in the argv', () => {
    expect(checkVcsArgs('git', ['log', '--output=/tmp/pwned']).ok).toBe(false)
    expect(checkVcsArgs('git', ['log', '-c', 'x']).ok).toBe(false)
    expect(checkVcsArgs('git', ['log', '--git-dir=/etc']).ok).toBe(false)
    expect(checkVcsArgs('git', ['archive', '--remote=ext::touch x']).ok).toBe(false)
  })

  it('blocks the transport options that run a program inside an allowlisted subcommand', () => {
    // These all ride on fetch/pull/push, which ARE allowlisted — the name check
    // alone would let a local-path remote plus these flags execute anything.
    expect(checkVcsArgs('git', ['fetch', '--upload-pack=touch /tmp/pwned', '/tmp/repo']).ok).toBe(false)
    expect(checkVcsArgs('git', ['pull', '--upload-pack', 'calc']).ok).toBe(false)
    expect(checkVcsArgs('git', ['push', '--receive-pack=/tmp/x', 'origin']).ok).toBe(false)
    expect(checkVcsArgs('git', ['push', '--exec', '/tmp/sh', 'origin']).ok).toBe(false)
    // The plain forms the UI uses still pass.
    expect(checkVcsArgs('git', ['fetch', '--all', '--prune']).ok).toBe(true)
    expect(checkVcsArgs('git', ['push', '-u', 'origin', 'HEAD']).ok).toBe(true)
  })

  it('restricts merge/rebase to their recovery forms', () => {
    expect(checkVcsArgs('git', ['merge', '--abort']).ok).toBe(true)
    expect(checkVcsArgs('git', ['merge', 'deadbeef']).ok).toBe(false)
    expect(checkVcsArgs('git', ['rebase', '--continue']).ok).toBe(true)
    expect(checkVcsArgs('git', ['rebase', '-i', 'HEAD~3']).ok).toBe(false)
  })

  it('rejects non-arrays and non-string args', () => {
    expect(checkVcsArgs('git', undefined as never).ok).toBe(false)
    expect(checkVcsArgs('git', []).ok).toBe(false)
    expect(checkVcsArgs('git', ['status', 123 as never]).ok).toBe(false)
  })
})

describe('checkVcsArgs (gh)', () => {
  it('allows the PR verbs and auth probe', () => {
    expect(checkVcsArgs('gh', ['pr', 'list', '--json', 'number']).ok).toBe(true)
    expect(checkVcsArgs('gh', ['pr', 'create', '--title', 't', '--body', 'b']).ok).toBe(true)
    expect(checkVcsArgs('gh', ['auth', 'status']).ok).toBe(true)
  })

  it('denies `gh api` — it is an arbitrary HTTP escape', () => {
    expect(checkVcsArgs('gh', ['api', '/v1/user']).ok).toBe(false)
  })

  it('denies unknown pr verbs', () => {
    expect(checkVcsArgs('gh', ['pr', 'review', '--approve']).ok).toBe(false)
    expect(checkVcsArgs('gh', ['repo', 'delete']).ok).toBe(false)
  })
})

describe('parseGhAuthStatus', () => {
  it('reads host and account out of a logged-in report', () => {
    const out = [
      'github.com',
      '  ✓ Logged in to github.com account octocat (keyring)',
      '  - Active account: true',
    ].join('\n')
    expect(parseGhAuthStatus(out)).toEqual({ authed: true, host: 'github.com', user: 'octocat' })
  })

  it('reports logged-out for the failure text and for empty output', () => {
    expect(parseGhAuthStatus('You are not logged in to any GitHub hosts.')).toEqual({ authed: false })
    expect(parseGhAuthStatus('')).toEqual({ authed: false })
  })
})
