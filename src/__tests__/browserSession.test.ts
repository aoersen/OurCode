import { describe, it, expect } from 'vitest'
import {
  buildActScript,
  buildScrollProbeScript,
  buildScrollSettleScript,
  formatConsoleForModel,
  normalizeBrowserUrl,
  parseKeyChord,
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

  it('uses elementFromPoint for coordinate clicks and dispatches the pointer sequence', () => {
    const script = buildActScript('click', { x: 10, y: 20 })!
    expect(script).toContain('elementFromPoint')
    expect(script).toContain("new PointerEvent('pointerdown'")
    expect(script).toContain("new MouseEvent('mousedown'")
    expect(script).toContain("new MouseEvent('mouseup'")
  })

  it('supports hover and drag scripts', () => {
    const hover = buildActScript('hover', { selector: '#menu' })!
    expect(hover).toContain("new MouseEvent('mouseover'")
    expect(hover).toContain("new MouseEvent('mousemove'")
    const drag = buildActScript('drag', { x: 1, y: 2, toX: 30, toY: 40 })!
    expect(drag).toContain("new MouseEvent('mousedown'")
    expect(drag).toContain("new MouseEvent('mousemove'")
    expect(drag).toContain("new MouseEvent('mouseup'")
    // 缺终点时返回可读错误，而不是生成一个会乱拖的脚本
    expect(buildActScript('drag', { x: 1, y: 2 })).toContain('拖拽需要起点')
  })

  it('scrolls by an explicit delta or a direction', () => {
    expect(buildActScript('scroll', { deltaY: -300 })).toContain('scrollBy')
    expect(buildActScript('scroll', { deltaY: -300 })).toContain('-300')
    expect(buildActScript('scroll', { direction: 'up' })).toContain("dir === 'up'")
  })

  it('parses a chord for the press fallback', () => {
    const script = buildActScript('press', { key: 'Control+a' })!
    expect(script).toContain('ctrlKey: true')
    expect(script).toContain('"a"')
    expect(buildActScript('press', { key: 'NoSuchKey' })).toContain('未知按键')
  })
})

describe('scroll probe/settle scripts', () => {
  it('probes the element under the point and remembers the scroll target', () => {
    const script = buildScrollProbeScript(10, 20)
    expect(script).toContain('elementFromPoint')
    expect(script).toContain('deep(10, 20)')
    expect(script).toContain('__ourcodeScrollInfo')
    expect(script).toContain("addEventListener('wheel'")
  })

  it('falls back once when the compositor swallowed the wheel, unless prevented', () => {
    const script = buildScrollSettleScript(0, 400)
    expect(script).toContain('scrollBy')
    expect(script).toContain("prevented !== true")
    expect(script).toContain('400')
    // Coordinates/deltas are clamped before they reach the page
    expect(buildScrollSettleScript(0, 999999)).toContain('10000')
  })
})

describe('parseKeyChord', () => {
  it('maps named keys and aliases to CDP payload fields', () => {
    const enter = parseKeyChord('Enter')
    expect(enter.ok).toBe(true)
    if (enter.ok) expect(enter.chord).toMatchObject({ key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', modifiers: 0 })

    const up = parseKeyChord('Up')
    expect(up.ok && up.chord).toMatchObject({ key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 })

    const f5 = parseKeyChord('F5')
    expect(f5.ok && f5.chord).toMatchObject({ key: 'F5', code: 'F5', keyCode: 116 })
  })

  it('parses modifier chords; shortcut keys do not insert text', () => {
    const ctrlA = parseKeyChord('Control+a')
    expect(ctrlA.ok).toBe(true)
    if (ctrlA.ok) {
      expect(ctrlA.chord).toMatchObject({ key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 })
      expect(ctrlA.chord.text).toBeUndefined()
    }

    const ctrlShiftA = parseKeyChord('Ctrl+Shift+A')
    expect(ctrlShiftA.ok && ctrlShiftA.chord).toMatchObject({ key: 'A', modifiers: 10 })

    const shiftEnter = parseKeyChord('Shift+Enter')
    expect(shiftEnter.ok && shiftEnter.chord).toMatchObject({ key: 'Enter', text: '\r', modifiers: 8 })
  })

  it('handles a literal plus and shifted symbols', () => {
    const plus = parseKeyChord('+')
    expect(plus.ok && plus.chord).toMatchObject({ key: '+', code: 'Equal', keyCode: 187, text: '+', modifiers: 8 })

    const ctrlPlus = parseKeyChord('Control++')
    expect(ctrlPlus.ok && ctrlPlus.chord).toMatchObject({ key: '+', code: 'Equal', modifiers: 10 })

    const bang = parseKeyChord('!')
    expect(bang.ok && bang.chord).toMatchObject({ key: '!', code: 'Digit1', keyCode: 49, modifiers: 8 })
  })

  it('uppercase letters imply Shift; X11 modifier names work', () => {
    const upper = parseKeyChord('A')
    expect(upper.ok && upper.chord).toMatchObject({ key: 'A', text: 'A', modifiers: 8 })

    const x11 = parseKeyChord('Control_L+a')
    expect(x11.ok && x11.chord).toMatchObject({ key: 'a', code: 'KeyA', modifiers: 2 })
  })

  it('rejects empty and unknown keys', () => {
    expect(parseKeyChord('').ok).toBe(false)
    expect(parseKeyChord('NoSuchKey').ok).toBe(false)
    expect(parseKeyChord('Control+Nope').ok).toBe(false)
  })
})
