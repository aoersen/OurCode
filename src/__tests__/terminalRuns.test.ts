import { describe, it, expect } from 'vitest'
import { flattenPtyOutput, formatRunOutput, stripAnsi, tailLines } from '@/services/terminalRuns'
import { createToolRegistry } from '@/services/tools/ToolRegistry'
import type { TerminalRunSnapshot } from '@shared/types'

/**
 * 后台终端命令里的纯函数部分：把 pty 原始字节流转成模型能读的文本。
 * pty 生命周期本身（term:runAgent / term:output / term:kill）由
 * e2e/agent-terminal.spec.ts 在真实 Electron 里验证。
 */

/** ESC without a literal escape sequence in this file. */
const E = String.fromCodePoint(27)

const snapshot = (over: Partial<TerminalRunSnapshot> = {}): TerminalRunSnapshot => ({
  output: '',
  truncated: false,
  running: true,
  exitCode: null,
  command: 'npm run dev',
  ...over,
})

const run = { id: 'agent-1', command: 'npm run dev' }

describe('stripAnsi', () => {
  it('drops colour codes, cursor controls and OSC window titles', () => {
    expect(stripAnsi(E + '[31mred' + E + '[0m')).toBe('red')
    expect(stripAnsi(E + '[?25l' + E + '[2Jready')).toBe('ready')
    expect(stripAnsi(E + ']0;my title' + String.fromCodePoint(7) + 'prompt$ ')).toBe('prompt$ ')
  })

  it('leaves ordinary text (including brackets) alone', () => {
    expect(stripAnsi('a[1;2m]b')).toBe('a[1;2m]b')
  })
})

describe('flattenPtyOutput', () => {
  it('keeps the last write of a self-overwriting progress line', () => {
    expect(flattenPtyOutput('  |  25%\r  | 100%\r\ndone\r\n')).toBe('  | 100%\ndone\n')
  })

  it('treats a bare trailing CR as "cursor home, row still showing"', () => {
    expect(flattenPtyOutput('partial\rmore\r\n')).toBe('more\n')
  })

  it('drops control bytes that carry no meaning for a model', () => {
    expect(flattenPtyOutput('a' + String.fromCodePoint(7) + 'b\n')).toBe('ab\n')
  })
})

describe('tailLines', () => {
  it('returns the trailing lines, cut on a line boundary', () => {
    expect(tailLines('one\ntwo\nthree', 2)).toBe('two\nthree')
  })

  it('returns everything when it already fits', () => {
    expect(tailLines('one\ntwo', 10)).toBe('one\ntwo')
  })
})

describe('formatRunOutput', () => {
  it('labels a live process and points at the follow-up tools', () => {
    const text = formatRunOutput(run, snapshot({ output: 'ready in 2s\r\n' }), { maxLines: 50 })
    expect(text).toContain('agent-1 仍在运行')
    expect(text).toContain('ready in 2s')
    expect(text).toContain('stop_terminal')
  })

  it('reports the exit code once the process is gone', () => {
    const text = formatRunOutput(
      run,
      snapshot({ output: 'FAIL\r\n', running: false, exitCode: 3 }),
      { maxLines: 50 }
    )
    expect(text).toContain('已退出，exit code = 3')
    expect(text).toContain('FAIL')
    expect(text).not.toContain('stop_terminal')
  })

  it('says so when there is nothing to show, and when the head was dropped', () => {
    expect(formatRunOutput(run, snapshot({ output: '' }), { maxLines: 50 })).toContain('(暂无输出)')
    expect(
      formatRunOutput(run, snapshot({ output: 'x', truncated: true }), { maxLines: 50 })
    ).toContain('超出缓冲')
  })
})

describe('terminal tools are registered', () => {
  const tools = createToolRegistry()

  it('exposes read_terminal_output and stop_terminal without an approval gate', () => {
    const read = tools.find((t) => t.name === 'read_terminal_output')
    const stop = tools.find((t) => t.name === 'stop_terminal')
    expect(read?.requiresApproval).toBe(false)
    expect(stop?.requiresApproval).toBe(false)
  })

  it('lets run_command start in the background but still needs approval', () => {
    const runCmd = tools.find((t) => t.name === 'run_command')
    expect(runCmd?.requiresApproval).toBe(true)
    expect(runCmd?.parameters.properties.background).toEqual({
      type: 'boolean',
      description: expect.any(String),
    })
  })
})
