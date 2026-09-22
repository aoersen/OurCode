import { describe, it, expect } from 'vitest'
import {
  buildActScript,
  formatConsoleForModel,
  normalizeBrowserUrl,
  trimConsoleBuffer,
  truncatePageText,
} from '@shared/browser'
import type { BrowserConsoleEntry } from '@shared/types'

const entry = (level: BrowserConsoleEntry['level'], text: string, source?: string): BrowserConsoleEntry => ({
  level,
  text,
  source,
  at: 0,
})

describe('normalizeBrowserUrl', () => {
  it('adds a scheme for typed hosts, http for localhost/IP', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toEqual({ ok: true, url: 'http://localhost:5173/' })
    expect(normalizeBrowserUrl('127.0.0.1:8080/app')).toEqual({ ok: true, url: 'http://127.0.0.1:8080/app' })
    expect(normalizeBrowserUrl('example.com')).toEqual({ ok: true, url: 'https://example.com/' })
  })

  it('keeps an explicit http(s) URL intact', () => {
    expect(normalizeBrowserUrl('http://localhost:3000/x?a=1').ok).toBe(true)
    expect(normalizeBrowserUrl('https://example.com/path')).toEqual({ ok: true, url: 'https://example.com/path' })
  })

  it('refuses schemes that would reach the local filesystem or the app itself', () => {
    expect(normalizeBrowserUrl('file:///etc/passwd').ok).toBe(false)
    expect(normalizeBrowserUrl('ourcode-file://local/E%3A/secret.env').ok).toBe(false)
    expect(normalizeBrowserUrl('javascript:alert(1)').ok).toBe(false)
  })

  it('refuses empty and unparseable input', () => {
    expect(normalizeBrowserUrl('   ').ok).toBe(false)
  })
})

describe('formatConsoleForModel', () => {
  it('leads with an error/warning tally so a truncated tail still says it broke', () => {
    const text = formatConsoleForModel([
      entry('error', 'Uncaught TypeError: x is not a function', 'app.js:10'),
      entry('warning', 'deprecated thing'),
      entry('info', 'ready'),
    ])
    expect(text).toContain('共 3 条（1 错误 / 1 警告）')
    expect(text).toContain('[error] Uncaught TypeError: x is not a function — app.js:10')
    expect(text.indexOf('[error]')).toBeLessThan(text.indexOf('[info]'))
  })

  it('says so when nothing was logged', () => {
    expect(formatConsoleForModel([])).toBe('(控制台无输出)')
  })

  it('keeps the newest lines when the budget is exceeded', () => {
    const many = Array.from({ length: 60 }, (_, i) => entry('info', `line-${i}`))
    const text = formatConsoleForModel(many, 120)
    expect(text).toContain('line-59')
    expect(text).not.toContain('line-0\n')
    expect(text).toContain('前面已省略')
  })
})

describe('trimConsoleBuffer', () => {
  it('drops from the head and keeps the cap', () => {
    const out = trimConsoleBuffer(Array.from({ length: 12 }, (_, i) => entry('info', `${i}`)), 5)
    expect(out.map((e) => e.text)).toEqual(['7', '8', '9', '10', '11'])
  })

  it('is a no-op under the limit', () => {
    const list = [entry('info', 'a')]
    expect(trimConsoleBuffer(list, 5)).toBe(list)
  })
})

describe('truncatePageText', () => {
  it('collapses CRLF and keeps the tail', () => {
    const out = truncatePageText('a\r\nb\r\n' + 'x'.repeat(100), 10)
    expect(out.startsWith('...(前')).toBe(true)
    expect(out.endsWith('x'.repeat(10))).toBe(true)
    expect(out).not.toContain('\r')
  })

  it('trims when under budget', () => {
    expect(truncatePageText('   hello \n')).toBe('hello')
  })
})

describe('buildActScript', () => {
  it('embeds values through JSON, so a selector cannot break out of the string', () => {
    const evil = `'); alert(1); ('`
    const script = buildActScript('click', { selector: evil })!
    expect(script).toContain(JSON.stringify(evil))
    // No raw single-quote injection point left unescaped
    expect(script).not.toContain("querySelector('')")
  })

  it('caps the wait duration and returns null for unknown actions', () => {
    expect(buildActScript('wait', { ms: 999_999 })).toContain('10000')
    expect(buildActScript('nope' as never)).toBeNull()
  })

  it('types through the native value setter for controlled inputs', () => {
    const script = buildActScript('type', { selector: '#email', text: 'a@b.c' })!
    expect(script).toContain('getOwnPropertyDescriptor')
    expect(script).toContain('new InputEvent')
    expect(script).toContain('"a@b.c"')
  })
})
