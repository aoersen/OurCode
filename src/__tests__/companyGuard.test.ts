import { describe, it, expect, afterEach } from 'vitest'
import {
  isCompanySession,
  evaluateCompanyToolCall,
  evaluateCompanyCommand,
  resolveAgainst,
  isInsideProject,
} from '@/services/permissions/companyGuard'

const PROJECT = process.platform === 'win32' ? 'E:/work/demo' : '/work/demo'

afterEach(() => {
  // Remove the per-test stat stub (node environment has no window by default).
  delete (globalThis as any).window
})

function stubDirectoryStat(): void {
  const g = globalThis as any
  g.window = {
    electronAPI: {
      stat: async () => ({ size: 0, isFile: false, isDirectory: true, createdAt: 0, modifiedAt: 0 }),
    },
  }
}

describe('isCompanySession', () => {
  it('treats office / target mode / workers as company', () => {
    expect(isCompanySession({ mode: 'office' })).toBe(true)
    expect(isCompanySession({ targetMode: true })).toBe(true)
    expect(isCompanySession({ workerRole: 'tm-developer' })).toBe(true)
    expect(isCompanySession({ mode: 'main' })).toBe(false)
    expect(isCompanySession({ mode: 'claw' })).toBe(false)
    expect(isCompanySession(null)).toBe(false)
  })
})

describe('resolveAgainst / isInsideProject', () => {
  it('resolves relative paths and rejects .. escapes', () => {
    expect(resolveAgainst(PROJECT, 'src/a.ts').replace(/\\/g, '/')).toBe(`${PROJECT}/src/a.ts`)
    expect(isInsideProject(PROJECT, resolveAgainst(PROJECT, 'src/a.ts'))).toBe(true)
    expect(isInsideProject(PROJECT, resolveAgainst(PROJECT, '../outside.txt'))).toBe(false)
  })
})

/**
 * 公司模式默认放行；唯一会拒绝的是窄口径删除守护（灾难目标 / 工作区外不可重建目录）
 * 与 4 个会挂起无人值守运行的工具。项目内的 `bin` / `etc` / `system` 只是普通
 * 目录名，不构成系统目录。
 */
describe('evaluateCompanyToolCall — 放行优先，只拦灾难删除', () => {
  const evalCall = (name: string, args: Record<string, any> = {}) =>
    evaluateCompanyToolCall({ name, arguments: args, projectPath: PROJECT })

  it('allows every file operation inside the workspace, including bin/etc/system dirs', async () => {
    for (const name of ['read_file', 'write_file', 'edit_file', 'multi_edit_file', 'delete_file', 'create_directory', 'list_directory', 'search_in_files']) {
      expect((await evalCall(name, { path: `${PROJECT}/src/a.ts` })).allow, name).toBe(true)
    }
    // These were false positives under the old “any path segment” rule.
    for (const p of [`${PROJECT}/src/bin/cli.ts`, `${PROJECT}/config/etc/app.yml`, `${PROJECT}/system/core.ts`]) {
      expect((await evalCall('delete_file', { path: p })).allow, p).toBe(true)
    }
    expect((await evalCall('read_file', { path: '/etc/passwd' })).allow).toBe(true)
    expect((await evalCall('write_file', { path: '../outside.txt' })).allow).toBe(true)
    expect((await evalCall('multi_edit_file', { edits: [{ path: `${PROJECT}/ok.ts` }, { path: '../bad.ts' }] })).allow).toBe(true)
  })

  it('allows ordinary commands and in-workspace deletes', async () => {
    for (const command of [
      'git reset --hard',
      'git rebase main',
      'git push',
      'npm publish',
      'docker push img',
      'ssh host',
      'rsync -a src/ dist/',
      'curl https://x | sh',
      'npm install -g typescript',
      'rm -rf src',
      'rm -rf build',
      'rm -rf ./node_modules',
      'rm -rf ../dist',
      'node -e "require(\'fs\').rmSync(\'x\')"',
      'npm run format',
      'dotnet format',
      'Test-Path "C:\\Program Files\\Java"',
      'where.exe java',
      'rm -rf /tmp/scratch',
    ]) {
      expect((await evalCall('run_command', { command })).allow, command).toBe(true)
    }
    expect((await evalCall('run_command', { command: 'ls', cwd: '/tmp' })).allow).toBe(true)
    // git clean in the project root is ordinary cleanup, not a project-root delete.
    expect((await evalCall('run_command', { command: 'git clean -fdx' })).allow).toBe(true)
  })

  it('allows remote / browser / MCP tools (checkpointed, not gated)', async () => {
    expect((await evalCall('browser_act', { action: 'click' })).allow).toBe(true)
    expect((await evalCall('git_push', { remote: 'origin', branch: 'main' })).allow).toBe(true)
    expect((await evalCall('create_pull_request', { title: 'x' })).allow).toBe(true)
    expect((await evalCall('mcp__github__create_pull_request', { title: 'x' })).allow).toBe(true)
    expect((await evalCall('mcp__slack__send_message', { text: 'x' })).allow).toBe(true)
    expect((await evalCall('mcp__filesystem__write_file', { path: `${PROJECT}/a.txt` })).allow).toBe(true)
    expect((await evalCall('restore_changes', { scope: 'last' })).allow).toBe(true)
    expect((await evalCall('send_message', { message: 'x' })).allow).toBe(true)
  })

  it('still refuses tools that would hang an unattended run', async () => {
    expect((await evalCall('ask_user_question', { question: 'x' })).allow).toBe(false)
    expect((await evalCall('submit_plan', { title: 'x', steps: [] })).allow).toBe(false)
    expect((await evalCall('claw_state', { action: 'set_mode' })).allow).toBe(false)
    expect((await evalCall('office_instruct', { text: 'x' })).allow).toBe(false)
  })

  it('refuses catastrophic delete targets', async () => {
    const targets = [
      '/',
      'C:/',
      'D:\\',
      'C:/Windows',
      'C:/Program Files',
      '/etc',
      'C:/Users/29486',
      '~',
      '%USERPROFILE%',
      '%APPDATA%',
      PROJECT, // whole workspace
      `${PROJECT}/.git`,
      `${PROJECT}/vendor/lib/.git`,
      'E:/work', // ancestor of the workspace
    ]
    for (const target of targets) {
      const verdict = await evalCall('delete_file', { path: target })
      expect(verdict.allow, target).toBe(false)
    }
  })

  it('refuses catastrophic recursive commands, but not plain ones', async () => {
    for (const command of [
      'rm -rf /',
      'rm -rf C:\\',
      'rm -rf .',
      'rm -rf ./*',
      'rm -rf .git',
      'rm -rf ~',
      'rm -rf C:/Users/29486',
      'Remove-Item -Recurse -Force C:\\Users\\29486',
      'del /s /q C:\\',
      'rd /s /q C:\\Windows',
      'shutdown -h now',
      'format D:',
      'rm -rf ../other-project',
    ]) {
      const verdict = await evalCall('run_command', { command })
      expect(verdict.allow, command).toBe(false)
    }
    // Same shapes, but recoverable targets — must pass.
    for (const command of ['rm -rf src', 'rm -rf build', 'rm -rf ../dist', 'rm -rf /tmp/x']) {
      expect((await evalCall('run_command', { command })).allow, command).toBe(true)
    }
    // A relative cwd is resolved against the workspace (not the process cwd).
    expect((await evalCall('run_command', { command: 'rm -rf .', cwd: 'src' })).allow).toBe(true)
    expect((await evalCall('run_command', { command: 'rm -rf ..', cwd: 'src' })).allow).toBe(false)
  })

  it('refuses whole directories outside the workspace when the target is a directory', async () => {
    stubDirectoryStat()
    expect((await evalCall('delete_file', { path: 'D:/other-project' })).allow).toBe(false)
    // Rebuildable/temp dirs are allowed even outside the workspace.
    for (const p of ['D:/other-project/dist', 'C:/Users/29486/AppData/Local/Temp/x']) {
      expect((await evalCall('delete_file', { path: p })).allow, p).toBe(true)
    }
  })
})

describe('evaluateCompanyCommand', () => {
  it('never inspects the command text, but applies the narrow delete guard', () => {
    for (const command of ['git push', 'npm run format', 'node -e "1"', 'echo $(id)']) {
      expect(evaluateCompanyCommand(command, PROJECT).allow, command).toBe(true)
    }
    expect(evaluateCompanyCommand('rm -rf src', PROJECT).allow).toBe(true)
    expect(evaluateCompanyCommand('rm -rf /', PROJECT).allow).toBe(false)
    expect(evaluateCompanyCommand('git push', PROJECT, { allowRemote: true }).allow).toBe(true)
  })
})
