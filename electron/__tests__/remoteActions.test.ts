import { describe, it, expect } from 'vitest'
import { detectRemoteAction, remoteActionNote } from '../services/remoteActions'

/**
 * 远端动作识别只用于"记账"：命中就记一笔并提示，不拦截。
 * 因此这里只校验"确定写远端"的形态被识别、普通本地命令不被误报。
 */
describe('detectRemoteAction', () => {
  it('detects pushes, publishes and deploys', () => {
    const cases: Array<[string, string]> = [
      ['git push', 'git-push'],
      ['git push origin main', 'git-push'],
      ['npm publish', 'publish'],
      ['pnpm -r publish --access public', 'publish'],
      ['cargo publish', 'publish'],
      ['docker push registry.local/img:1', 'registry-push'],
      ['vercel deploy --prod', 'deploy'],
      ['gh release create v1.0.0', 'deploy'],
      ['kubectl apply -f k8s/', 'cluster'],
      ['helm upgrade app ./chart', 'cluster'],
      ['scp dist.tar.gz user@host:/srv', 'remote-shell'],
      ['rsync -az ./dist/ user@host:/srv/app', 'remote-shell'],
    ]
    for (const [command, kind] of cases) {
      expect(detectRemoteAction(command)?.kind, command).toBe(kind)
    }
  })

  it('ignores dry runs and purely local commands', () => {
    for (const command of [
      'git push --dry-run',
      'git status',
      'git commit -m "x"',
      'git reset --hard',
      'npm install',
      'npm run build',
      'npm run format',
      'docker build -t x .',
      'node build.js',
      'rsync -a src/ dist/',
      'ls -la',
      '',
    ]) {
      expect(detectRemoteAction(command), command).toBeNull()
    }
  })

  it('produces a note that says the action is outside local rollback', () => {
    const action = detectRemoteAction('git push')
    expect(action).not.toBeNull()
    const note = remoteActionNote(action!)
    expect(note).toContain('git push')
    expect(note).toContain('不在本地回退范围')
  })
})
