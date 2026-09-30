import { describe, it, expect } from 'vitest'
import * as iconv from 'iconv-lite'
import { decodeShellOutput, rewriteBashSeparators, classifyShellFailure } from '../services/shell-compat'

describe('decodeShellOutput', () => {
  it('passes UTF-8 bytes through unchanged', () => {
    expect(decodeShellOutput(Buffer.from('npm run typecheck — ok ✓', 'utf8'))).toBe('npm run typecheck — ok ✓')
  })

  it('decodes GBK console output (Chinese Windows) into readable text', () => {
    const text = '所在位置 行:1 字符: 50：标记“&&”不是此版本中的有效语句分隔符'
    const gbk = iconv.encode(text, 'gbk')
    // UTF-8 decoding of GBK bytes yields replacement characters…
    expect(gbk.toString('utf8')).toContain('\uFFFD')
    // …and the helper recovers the original text.
    expect(decodeShellOutput(gbk)).toBe(text)
  })

  it('handles empty buffers and string passthrough', () => {
    expect(decodeShellOutput(Buffer.alloc(0))).toBe('')
    expect(decodeShellOutput('plain')).toBe('plain')
  })
})

describe('rewriteBashSeparators', () => {
  it('rewrites a bash chain into PowerShell-legal sequential form', () => {
    const r = rewriteBashSeparators('cd E:\\x\\aurora-wallpaper && npm run typecheck')
    expect(r.command).toBe('cd E:\\x\\aurora-wallpaper ; npm run typecheck')
    expect(r.note).toBeTruthy()
  })

  it('rewrites || and handles several operators', () => {
    const r = rewriteBashSeparators('npm install || npm ci && npm test')
    expect(r.command).toBe('npm install ; npm ci ; npm test')
  })

  it('leaves 2>&1 and single pipes/background operators alone', () => {
    for (const cmd of [
      'cd E:\\x ; npm run typecheck 2>&1',
      'git log --oneline | head',
      'npm run build &',
    ]) {
      const r = rewriteBashSeparators(cmd)
      expect(r.command).toBe(cmd)
      expect(r.note).toBeUndefined()
    }
  })

  it('does not touch && / || inside quoted spans', () => {
    const cmd = `node -e "console.log('a&&b || c')"`
    const r = rewriteBashSeparators(cmd)
    expect(r.command).toBe(cmd)
    expect(r.note).toBeUndefined()
  })

  it('returns no note when there is nothing to rewrite', () => {
    const r = rewriteBashSeparators('npm run typecheck')
    expect(r).toEqual({ command: 'npm run typecheck' })
  })
})

describe('classifyShellFailure', () => {
  const base = { stoppedByUser: false, timedOut: false, spawnFailed: false, errText: '', errorMessage: '', timeoutMs: 30000 }

  it('marks user stop and timeout with their own prefixes', () => {
    expect(classifyShellFailure({ ...base, stoppedByUser: true })).toMatch(/^\[已终止\]/)
    expect(classifyShellFailure({ ...base, timedOut: true, timeoutMs: 90000 })).toMatch(/^\[超时\].*90 秒/)
  })

  it('classifies PowerShell parser errors as 语法错误', () => {
    const msg = classifyShellFailure({ ...base, errText: "标记'&&'不是此版本中的有效语句分隔符。\nParserError: InvalidEndOfLine" })
    expect(msg).toMatch(/^\[语法错误\]/)
    expect(msg).toContain('不是此版本中的有效语句分隔符')
  })

  it('classifies spawn failures as 无法执行', () => {
    const msg = classifyShellFailure({ ...base, spawnFailed: true, errorMessage: 'spawn powershell.exe ENOENT' })
    expect(msg).toMatch(/^\[无法执行\]/)
    expect(msg).toContain('ENOENT')
  })

  it('classifies a plain non-zero exit as 命令报错 (verification signal)', () => {
    const msg = classifyShellFailure({ ...base, errText: 'src/ipc.ts(21,3): error TS6196: ...' })
    expect(msg).toMatch(/^\[命令报错\] src\/ipc\.ts\(21,3\): error TS6196/)
  })

  it('keeps stop/timeout precedence over everything else', () => {
    expect(classifyShellFailure({ ...base, stoppedByUser: true, timedOut: true, spawnFailed: true })).toMatch(/^\[已终止\]/)
    expect(classifyShellFailure({ ...base, timedOut: true, errText: 'ParserError: x' })).toMatch(/^\[超时\]/)
  })
})
