import { describe, it, expect } from 'vitest'
import { checkVcsArgs } from '../services/vcs-exec'
import { applyPatchArgs, type PatchAction } from '@/utils/gitPatch'

/**
 * Every git argv the app itself sends must satisfy the exec gate.
 *
 * The gate is a deny-by-default allowlist, so its most likely failure mode is
 * not "lets something bad through" but "refuses something the UI already does" —
 * which already happened once (per-hunk `git apply -` and the stdin argument
 * both broke when the handler was rewritten). If you add a git call, add it
 * here; the test fails instead of the feature.
 */
const UI_ARGV: Array<{ label: string; args: string[] }> = [
  // GitPanel
  { label: 'panel branch', args: ['rev-parse', '--abbrev-ref', 'HEAD'] },
  { label: 'panel status', args: ['status', '--porcelain=v1'] },
  { label: 'panel last commit', args: ['log', '-1', '--format=%H|%s|%an|%ar'] },
  { label: 'panel stage', args: ['add', 'src/a.ts'] },
  { label: 'panel unstage', args: ['reset', 'HEAD', 'src/a.ts'] },
  { label: 'panel stage all', args: ['add', '-A'] },
  { label: 'panel unstage all', args: ['reset', 'HEAD'] },
  { label: 'panel commit', args: ['commit', '-m', 'feat: x'] },
  { label: 'panel lifeguard diff', args: ['diff', 'HEAD'] },
  { label: 'panel push', args: ['push', '-u', 'origin', 'HEAD'] },
  { label: 'panel pull', args: ['pull'] },
  { label: 'panel fetch', args: ['fetch', '--all', '--prune'] },
  { label: 'panel stash', args: ['stash', 'push', '--include-untracked'] },
  { label: 'panel stash pop', args: ['stash', 'pop'] },
  { label: 'panel new branch', args: ['checkout', '-b', 'feat/x'] },
  { label: 'panel abort merge', args: ['merge', '--abort'] },
  // services/git — blob reads for the diff sides (untrimmed channel)
  { label: 'blob HEAD side', args: ['show', 'HEAD:src/a.ts'] },
  { label: 'blob index side', args: ['show', ':src/a.ts'] },
  { label: 'blob commit', args: ['show', '--format=', '--no-renames', 'abc123', '--', 'src/a.ts'] },
  { label: 'file diff', args: ['diff', '--cached', '--', 'src/a.ts'] },
  // services/github — push state for the PR form
  { label: 'upstream ref', args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'] },
  { label: 'ahead count', args: ['rev-list', '--left-right', '--count', 'origin/main...HEAD'] },
  { label: 'pr body commits', args: ['log', '-8', '--format=%s'] },
  { label: 'pr body diffstat', args: ['diff', 'HEAD', '--stat'] },
  // agent git tools
  { label: 'tool status', args: ['status', '--porcelain=v1', '--branch'] },
  { label: 'tool diff path', args: ['diff', '--cached', '--stat', '--', 'src'] },
  { label: 'tool log', args: ['log', '-10', '--oneline', '--decorate'] },
  { label: 'tool branch', args: ['branch'] },
  { label: 'tool add group', args: ['add', '--', 'src/a.ts', 'src/b.ts'] },
  { label: 'tool push remote', args: ['push', 'origin', 'feat/x'] },
]

describe('git argv used by the app passes the exec gate', () => {
  for (const { label, args } of UI_ARGV) {
    it(label, () => {
      const res = checkVcsArgs('git', args)
      expect(res.ok, JSON.stringify(args)).toBe(true)
    })
  }

  it('all six apply shapes of the diff editor', () => {
    const actions: PatchAction[] = ['stage', 'unstage', 'revert']
    for (const action of actions) {
      for (const staged of [true, false]) {
        const { check, apply } = applyPatchArgs(action, staged)
        for (const args of [check, apply]) {
          const res = checkVcsArgs('git', args)
          expect(res.ok, JSON.stringify(args)).toBe(true)
        }
      }
    }
  })

  it('gh argv used by the PR layer passes the gate', () => {
    const prFields = 'number,title,state,url'
    const shapes: string[][] = [
      ['auth', 'status'],
      ['pr', 'list', '--json', prFields, '--limit', '8'],
      ['pr', 'view', '--json', prFields],
      ['pr', 'view', '12', '--json', prFields],
      ['pr', 'create', '--title', 'T', '--body', 'B'],
      ['pr', 'comment', '12', '--body', 'hello'],
      ['pr', 'merge', '--squash'],
    ]
    for (const args of shapes) {
      expect(checkVcsArgs('gh', args).ok, JSON.stringify(args)).toBe(true)
    }
  })
})
