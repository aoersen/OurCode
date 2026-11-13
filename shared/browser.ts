/**
 * Pure helpers for the agent browser session — URL policy, page scripts, and
 * how captured output gets rendered for a model. Kept free of Electron imports
 * so the main process, the renderer panel and the unit tests all see one copy.
 */

import type { BrowserActOptions, BrowserAction, BrowserConsoleEntry } from './types'

/** Keep the console buffer bounded: a chatty dev server would otherwise grow
 *  without limit for the lifetime of the window. */
export const BROWSER_CONSOLE_LIMIT = 400

/** Character budget for extracted page text / console output handed to a model. */
export const BROWSER_PAGE_TEXT_LIMIT = 8_000
export const BROWSER_CONSOLE_MODEL_LIMIT = 4_000

export type BrowserUrlResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * Turn whatever the user or model typed into a URL the browsed page may load.
 *
 * Only http(s) is allowed. `file://` and the app's own `ourcode-file://` are
 * refused on purpose: a remote page fetched into this session must not be able
 * to read the workspace through the preview protocol or open the app's renderer.
 */
export function normalizeBrowserUrl(raw: string): BrowserUrlResult {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return { ok: false, error: '地址为空' }
  // "localhost:5173" also matches a scheme prefix, so a bare host is detected
  // first and a scheme only counts in its full `scheme://` form.
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const bareLocalHost = /^(\d{1,3}(\.\d{1,3}){3}|localhost)(:\d+)?([/?]|$)/i.test(trimmed)
  let candidate: string
  if (schemeMatch) candidate = trimmed
  else if (bareLocalHost) candidate = `http://${trimmed}`
  else if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    // `file:/x`, `javascript:alert(1)` — a scheme we will not load, stated rather
    // than silently rewritten into https://file/x.
    return { ok: false, error: `浏览器只允许 http/https，收到 ${trimmed.slice(0, 40)}` }
  } else candidate = `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, error: `无法解析地址：${trimmed}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `浏览器只允许 http/https，收到 ${url.protocol}` }
  }
  if (!url.hostname) return { ok: false, error: `地址缺少主机名：${trimmed}` }
  return { ok: true, url: url.href }
}

/** Drop oldest entries past the cap (the buffer is append-ordered). */
export function trimConsoleBuffer(entries: BrowserConsoleEntry[], limit = BROWSER_CONSOLE_LIMIT): BrowserConsoleEntry[] {
  return entries.length > limit ? entries.slice(entries.length - limit) : entries
}

const LEVEL_LABEL: Record<BrowserConsoleEntry['level'], string> = {
  verbose: 'log',
  info: 'info',
  warning: 'warn',
  error: 'error',
}

/**
 * Render captured console output for a model: newest lines last, with an
 * error/warning count up front so a truncated tail still conveys "it broke".
 */
export function formatConsoleForModel(entries: BrowserConsoleEntry[], maxChars = BROWSER_CONSOLE_MODEL_LIMIT): string {
  if (!entries.length) return '(控制台无输出)'
  const errors = entries.filter((e) => e.level === 'error').length
  const warnings = entries.filter((e) => e.level === 'warning').length
  const lines = entries.map((e) => {
    const where = e.source ? ` — ${e.source}` : ''
    return `[${LEVEL_LABEL[e.level]}] ${e.text}${where}`
  })
  const header = `共 ${entries.length} 条（${errors} 错误 / ${warnings} 警告）`
  const body = lines.join('\n')
  const tail = body.length > maxChars ? `...(前面已省略)\n${body.slice(body.length - maxChars)}` : body
  return `${header}\n${tail}`
}

/** Trailing slice of page text — the end of a document is where "did it
 *  render / what error is on screen" usually lives. */
export function truncatePageText(text: string, maxChars = BROWSER_PAGE_TEXT_LIMIT): string {
  const clean = String(text ?? '').replace(/\r/g, '').trim()
  if (clean.length <= maxChars) return clean
  return `...(前 ${clean.length - maxChars} 字符已省略)\n${clean.slice(clean.length - maxChars)}`
}

// ── ARIA snapshot (CDP Accessibility.getFullAXTree → compact model text) ─────

/** What the main process hands to the formatter, after resolving CDP AX nodes. */
export interface AxInputNode {
  role?: string
  name?: string
  value?: string
  backendDOMNodeId?: number
  ignored?: boolean
  children?: AxInputNode[]
}

export interface FormattedAxTree {
  text: string
  /** ref → backendDOMNodeId, used by browser_act {ref}. */
  refs: Record<string, number>
  nodes: number
}

/** Container roles that carry no information on their own. */
const AX_NOISE_ROLES = new Set(['none', 'generic', 'rootwebarea', 'inlinetextbox', 'presentation'])
/** Container roles worth printing even without a name (they organise the tree). */
const AX_KEEP_ROLES = new Set([
  'document', 'main', 'navigation', 'region', 'article', 'form', 'dialog', 'alertdialog',
  'toolbar', 'tablist', 'list', 'table', 'grid', 'menu', 'menubar', 'tree', 'group', 'status',
])

/**
 * Render a CDP accessibility tree as the compact text the model reads.
 *
 * - `ignored` nodes are dropped but their children are hoisted (CDP marks plain
 *   `<div>` wrappers ignored; losing their children would hide the page).
 * - Every node that has a backend DOM id gets a ref (`e0`, `e1`, …) that is valid
 *   only for this snapshot, so click/type can address it without CSS selectors.
 *   The tree comes from the top frame's AX tree; iframe subtrees are not merged.
 * - Output is node- and character-capped: a real page's AX tree is thousands of
 *   nodes and would drown the conversation.
 */
export function formatAxTree(
  roots: AxInputNode[] | AxInputNode,
  opts: { maxNodes?: number; maxChars?: number } = {},
): FormattedAxTree {
  const maxNodes = opts.maxNodes ?? 500
  const maxChars = opts.maxChars ?? 8_000
  const refs: Record<string, number> = {}
  const lines: string[] = []
  let seq = 0
  let nodes = 0
  let truncated = false

  const walk = (node: AxInputNode, depth: number): void => {
    if (truncated) return
    if (nodes >= maxNodes) {
      truncated = true
      return
    }
    const children = node.children ?? []
    if (node.ignored) {
      for (const child of children) walk(child, depth)
      return
    }
    const role = String(node.role ?? '').toLowerCase() || 'unknown'
    const name = String(node.name ?? '').replace(/\s+/g, ' ').trim()
    const value = String(node.value ?? '').replace(/\s+/g, ' ').trim()
    const hasBackendId = typeof node.backendDOMNodeId === 'number' && node.backendDOMNodeId > 0
    const printable = !!name || !!value || AX_KEEP_ROLES.has(role) || hasBackendId || depth === 0
    if (!printable && AX_NOISE_ROLES.has(role)) {
      for (const child of children) walk(child, depth)
      return
    }
    if (printable) {
      let ref = ''
      if (hasBackendId) {
        ref = `e${seq++}`
        refs[ref] = node.backendDOMNodeId as number
      }
      nodes += 1
      const label = name ? ` "${name.slice(0, 80)}"` : ''
      const valueText = value && value !== name ? ` value="${value.slice(0, 60)}"` : ''
      const refText = ref ? ` [ref=${ref}]` : ''
      lines.push(`${'  '.repeat(Math.min(depth, 12))}- ${role}${label}${valueText}${refText}`)
      if (lines.join('\n').length > maxChars) truncated = true
    }
    for (const child of children) walk(child, printable ? depth + 1 : depth)
  }

  for (const root of Array.isArray(roots) ? roots : [roots]) walk(root, 0)
  if (truncated) lines.push('…（可访问性树已截断：节点/字符上限。用已列出的 ref 操作，或先滚动/导航缩小范围）')
  return { text: lines.join('\n'), refs, nodes }
}

// ── Keyboard chords (used by real CDP input and the DOM fallback) ───────────

export const KEY_MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const

export interface KeyChord {
  /** KeyboardEvent.key value. */
  key: string
  /** KeyboardEvent.code value (physical key). */
  code: string
  /** Legacy virtual key code CDP wants for default actions. */
  keyCode: number
  /** Text a char event should insert; absent for control/shortcut keys. */
  text?: string
  /** CDP Input modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
  modifiers: number
}

export type KeyChordResult = { ok: true; chord: KeyChord } | { ok: false; error: string }

const KEY_ALIASES: Record<string, string> = {
  return: 'enter',
  esc: 'escape',
  spacebar: 'space',
  del: 'delete',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  pgup: 'pageup',
  pgdn: 'pagedown',
}

/** Named keys: key / code / legacy keyCode / char text. */
const NAMED_KEYS: Record<string, Omit<KeyChord, 'modifiers'>> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  capslock: { key: 'CapsLock', code: 'CapsLock', keyCode: 20 },
  contextmenu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
}
for (let i = 1; i <= 12; i += 1) {
  NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i }
}

/** Physical key + legacy code for punctuation (unshifted character). */
const PUNCTUATION_KEYS: Record<string, { code: string; keyCode: number }> = {
  ';': { code: 'Semicolon', keyCode: 186 },
  '=': { code: 'Equal', keyCode: 187 },
  ',': { code: 'Comma', keyCode: 188 },
  '-': { code: 'Minus', keyCode: 189 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  '`': { code: 'Backquote', keyCode: 192 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ']': { code: 'BracketRight', keyCode: 221 },
  "'": { code: 'Quote', keyCode: 222 },
}

/** Shifted symbols → the physical key that produces them. */
const SHIFTED_SYMBOLS: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
}

const MODIFIER_ALIASES: Record<string, keyof typeof KEY_MODIFIER> = {
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  alt_l: 'alt',
  alt_r: 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  control_l: 'ctrl',
  control_r: 'ctrl',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  super_l: 'meta',
  super_r: 'meta',
  shift: 'shift',
  shift_l: 'shift',
  shift_r: 'shift',
}

function singleCharChord(char: string, modifiers: number): KeyChord | null {
  const shift = (modifiers & KEY_MODIFIER.shift) !== 0
  const shortcut = (modifiers & (KEY_MODIFIER.ctrl | KEY_MODIFIER.meta | KEY_MODIFIER.alt)) !== 0
  if (/^[a-z]$/i.test(char)) {
    const upper = char.toUpperCase()
    const wantsShift = shift || (char === upper && modifiers === 0)
    const key = wantsShift ? upper : char.toLowerCase()
    return {
      key,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
      text: shortcut ? undefined : key,
      modifiers: wantsShift ? modifiers | KEY_MODIFIER.shift : modifiers,
    }
  }
  if (/^[0-9]$/.test(char)) {
    return { key: char, code: `Digit${char}`, keyCode: char.charCodeAt(0), text: shortcut ? undefined : char, modifiers }
  }
  if (PUNCTUATION_KEYS[char]) {
    return { key: char, code: PUNCTUATION_KEYS[char].code, keyCode: PUNCTUATION_KEYS[char].keyCode, text: shortcut ? undefined : char, modifiers }
  }
  const base = SHIFTED_SYMBOLS[char]
  if (base) {
    const physical = /^[0-9]$/.test(base)
      ? { code: `Digit${base}`, keyCode: base.charCodeAt(0) }
      : PUNCTUATION_KEYS[base]
    if (physical) {
      return {
        key: char,
        code: physical.code,
        keyCode: physical.keyCode,
        text: shortcut ? undefined : char,
        modifiers: modifiers | KEY_MODIFIER.shift,
      }
    }
  }
  return null
}

/**
 * Parse "Enter", "Control+a", "Shift+Tab", "Meta+ArrowLeft", "=", "+" into the
 * payload CDP's Input.dispatchKeyEvent needs. X11-style aliases (Control_L) and
 * the common key aliases (Esc, Up, PgDn) are accepted because models emit both.
 */
export function parseKeyChord(raw: string): KeyChordResult {
  const input = String(raw ?? '').trim()
  if (!input) return { ok: false, error: '按键为空' }

  // The LAST '+' separates modifiers from the key, so "Control++" is Ctrl + "+".
  const lastPlus = input.lastIndexOf('+')
  let modPart = ''
  let keyPart = input
  if (lastPlus >= 0) {
    keyPart = input.slice(lastPlus + 1)
    modPart = input.slice(0, lastPlus)
    if (!keyPart) keyPart = '+'
    if (modPart.endsWith('+')) modPart = modPart.slice(0, -1)
  }
  if (!keyPart) return { ok: false, error: `无法解析按键：${input}` }

  let modifiers = 0
  if (modPart) {
    for (const rawMod of modPart.split('+')) {
      const mod = rawMod.trim()
      if (!mod) continue
      const kind = MODIFIER_ALIASES[mod.toLowerCase()]
      if (!kind) return { ok: false, error: `未知修饰键：${mod}` }
      modifiers |= KEY_MODIFIER[kind]
    }
  }

  const lower = keyPart.toLowerCase()
  const alias = KEY_ALIASES[lower] ?? lower
  const named = NAMED_KEYS[alias]
  if (named) {
    const shortcut = (modifiers & (KEY_MODIFIER.ctrl | KEY_MODIFIER.meta | KEY_MODIFIER.alt)) !== 0
    return {
      ok: true,
      chord: { ...named, text: shortcut ? undefined : named.text, modifiers },
    }
  }

  if (keyPart.length === 1) {
    const chord = singleCharChord(keyPart, modifiers)
    if (chord) return { ok: true, chord }
  }
  return { ok: false, error: `未知按键：${keyPart}` }
}

// ── Page scripts ────────────────────────────────────────────────────────────

/** Script that reads back the page's visible text. Whitespace-collapsed so the
 *  budget buys content instead of indentation. */
export function pageTextScript(): string {
  return `(() => {
  const body = document.body;
  const text = body ? (body.innerText || body.textContent || '') : '';
  return JSON.stringify({
    title: document.title || '',
    url: location.href,
    text: text.replace(/\\n{3,}/g, '\\n\\n').replace(/[ \\t]{2,}/g, ' '),
  });
})()`
}

function clampMs(ms: unknown): number {
  return Math.max(0, Math.min(Number(ms) || 0, 10_000))
}

function clampClickCount(count: unknown): number {
  const n = Math.round(Number(count) || 1)
  return Math.max(1, Math.min(3, n))
}

function clampDelta(delta: unknown): number {
  const n = Number(delta)
  if (!Number.isFinite(n)) return 0
  return Math.max(-10_000, Math.min(10_000, Math.round(n)))
}

/** elementFromPoint that descends into same-origin iframes, so a coordinate
 *  target inside an iframe resolves to the inner node rather than the frame. */
function deepPickScript(xJson: string, yJson: string): string {
  return `(() => {
    const deep = (x, y) => {
      let el = document.elementFromPoint(x, y);
      let ox = x, oy = y;
      for (let i = 0; i < 8 && el && el.tagName === 'IFRAME'; i++) {
        try {
          const r = el.getBoundingClientRect();
          const cx = ox - r.left - (el.clientLeft || 0);
          const cy = oy - r.top - (el.clientTop || 0);
          const inner = el.contentDocument && el.contentDocument.elementFromPoint(cx, cy);
          if (!inner) break;
          el = inner; ox = cx; oy = cy;
        } catch (e) { break; }
      }
      return el;
    };
    return deep(${xJson}, ${yJson});
  })()`
}

/**
 * Probe the scroll target under a point before dispatching a wheel event.
 *
 * A hidden Chromium window can swallow the first wheel after a click: the
 * event reaches the page but the compositor never applies the scroll. This
 * probe remembers the native scroll position (and the owner window for a
 * same-origin iframe) so the settle script can tell whether the wheel worked.
 * It also installs a one-shot wheel listener, so a page that preventDefault()s
 * the gesture is never scrolled a second time.
 */
export function buildScrollProbeScript(x: number, y: number): string {
  const xJson = JSON.stringify(Math.round(Number(x) || 0))
  const yJson = JSON.stringify(Math.round(Number(y) || 0))
  return `(() => {
  const deep = (x, y) => {
    let el = document.elementFromPoint(x, y);
    let ox = x, oy = y;
    for (let i = 0; i < 8 && el && el.tagName === 'IFRAME'; i++) {
      try {
        const r = el.getBoundingClientRect();
        const cx = ox - r.left - (el.clientLeft || 0);
        const cy = oy - r.top - (el.clientTop || 0);
        const inner = el.contentDocument && el.contentDocument.elementFromPoint(cx, cy);
        if (!inner) break;
        el = inner; ox = cx; oy = cy;
      } catch (e) { break; }
    }
    return el;
  };
  const el = deep(${xJson}, ${yJson});
  const doc = el ? el.ownerDocument : document;
  const win = doc.defaultView || window;
  let node = el;
  let target = null;
  while (node && node !== doc.body && node !== doc.documentElement) {
    const cs = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) { target = node; break; }
    node = node.parentElement;
  }
  const crossFrame = !!(el && el.tagName === 'IFRAME' && !el.contentDocument);
  if (!target) target = doc.scrollingElement || doc.documentElement;
  window.__ourcodeScrollTarget = target;
  window.__ourcodeScrollWin = win;
  window.__ourcodeWheelPrevented = null;
  try {
    // Capture phase + a deferred read: defaultPrevented is only final after the
    // page's own handlers ran, and a handler may stop propagation before the
    // bubble listener would see the event.
    win.addEventListener('wheel', (e) => {
      const event = e;
      setTimeout(() => { window.__ourcodeWheelPrevented = event.defaultPrevented }, 0);
    }, { once: true, capture: true, passive: true });
  } catch (e) {}
  window.__ourcodeScrollInfo = { top: target.scrollTop, left: target.scrollLeft, crossFrame: crossFrame };
  return JSON.stringify(window.__ourcodeScrollInfo);
})()`
}

/** Verify the wheel moved something; if it was swallowed and the page did not
 *  preventDefault, apply the same delta natively so the visible result matches
 *  the requested scroll. Never touches the target twice. */
export function buildScrollSettleScript(deltaX: number, deltaY: number): string {
  const dx = JSON.stringify(clampDelta(deltaX))
  const dy = JSON.stringify(clampDelta(deltaY))
  return `(() => {
  const info = window.__ourcodeScrollInfo;
  const target = window.__ourcodeScrollTarget;
  const win = window.__ourcodeScrollWin;
  const prevented = window.__ourcodeWheelPrevented;
  window.__ourcodeScrollTarget = null;
  window.__ourcodeScrollWin = null;
  window.__ourcodeScrollInfo = null;
  window.__ourcodeWheelPrevented = null;
  if (!info || !target || !win) return JSON.stringify({ ok: false, error: '滚动目标已失效' });
  if (info.crossFrame) return JSON.stringify({ ok: true, changed: false, fallback: false, crossFrame: true, prevented: prevented === true });
  const beforeTop = target.scrollTop, beforeLeft = target.scrollLeft;
  const changed = beforeTop !== info.top || beforeLeft !== info.left;
  let fallback = false;
  if (!changed && prevented !== true) {
    const doc = win.document;
    const isDoc = target === doc.scrollingElement || target === doc.documentElement || target === doc.body;
    try {
      if (isDoc) win.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' });
      else target.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' });
      fallback = true;
    } catch (e) {}
  }
  const afterTop = target.scrollTop, afterLeft = target.scrollLeft;
  return JSON.stringify({
    ok: true,
    changed: afterTop !== info.top || afterLeft !== info.left,
    fallback: fallback,
    prevented: prevented === true,
    top: afterTop,
    left: afterLeft,
  });
})()`
}

/**
 * Build the in-page script for one interaction.
 *
 * This is the synthetic fallback used when CDP input is unavailable or forced
 * with strategy="dom". The real path in the main process sends trusted browser
 * input events; these scripts still dispatch the full pointer/mouse sequence so
 * frameworks that listen to pointerdown/mousedown behave better than a bare
 * `element.click()`.
 *
 * Values reach the page through JSON.stringify only, so a selector can never
 * break out of the expression it is embedded in. The result is a JSON string
 * the main process parses back into a BrowserActResult.
 */
export function buildActScript(action: BrowserAction, opts: BrowserActOptions = {}): string | null {
  const sel = JSON.stringify(opts.selector ?? '')
  const value = JSON.stringify(opts.text ?? '')
  const ms = JSON.stringify(clampMs(opts.ms))
  const xNum = Math.round(Number(opts.x) || 0)
  const yNum = Math.round(Number(opts.y) || 0)
  const hasPoint = Number.isFinite(Number(opts.x)) && Number.isFinite(Number(opts.y))
  const px = JSON.stringify(xNum)
  const py = JSON.stringify(yNum)
  // A malformed selector THROWS in querySelector rather than returning null, and
  // the model gets a raw SyntaxError back. Wrap the lookup so it always comes
  // back as a readable "no match" it can correct.
  const find = `(() => { try { return document.querySelector(${sel}); } catch (e) { return '__invalid__' + e.message; } })()`
  const lookup = hasPoint
    ? `const el = ${deepPickScript(px, py)};
  if (!el) return JSON.stringify({ ok: false, error: '坐标处没有元素：(${xNum}, ${yNum})' });`
    : `const el = ${find};
  if (typeof el === 'string' && el.indexOf('__invalid__') === 0) return JSON.stringify({ ok: false, error: '选择器不合法：' + ${sel} + ' — ' + el.slice(11) });
  if (!el) return JSON.stringify({ ok: false, error: '选择器没有匹配到元素：' + ${sel} });`
  const hasSelectorOrPoint = String(opts.selector ?? '').trim() !== '' || hasPoint

  switch (action) {
    case 'click': {
      const button = JSON.stringify(opts.button ?? 'left')
      const count = JSON.stringify(clampClickCount(opts.clickCount))
      return `(() => {${lookup}
  const button = ${button};
  const count = ${count};
  if (el.disabled) return JSON.stringify({ ok: false, error: '目标元素处于 disabled 状态' });
  try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  try { if (el.focus) el.focus({ preventScroll: true }); } catch (e) {}
  const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const buttonIndex = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: buttonIndex, buttons, detail: count };
  try { el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mousedown', base));
  try { el.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0 })); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
  if (button === 'right') {
    el.dispatchEvent(new MouseEvent('contextmenu', { ...base, buttons: 0 }));
  } else if (button === 'middle') {
    el.dispatchEvent(new MouseEvent('auxclick', { ...base, buttons: 0 }));
  } else {
    el.click();
    if (count > 1) {
      el.click();
      el.dispatchEvent(new MouseEvent('dblclick', { ...base, buttons: 0 }));
    }
    if (count > 2) el.click();
  }
  return JSON.stringify({ ok: true, detail: el.tagName.toLowerCase() + ' 已点击' + (count > 1 ? ' ×' + count : '') });
})()`
    }
    case 'hover':
      return `(() => {${lookup}
  try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
  const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 0 };
  try { el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mouseover', base));
  try { el.dispatchEvent(new PointerEvent('pointerenter', { ...base, bubbles: false })); } catch (e) {}
  el.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
  el.dispatchEvent(new MouseEvent('mousemove', base));
  return JSON.stringify({ ok: true, detail: el.tagName.toLowerCase() + ' 已悬停' });
})()`
    case 'drag': {
      const toX = Math.round(Number(opts.toX) || 0)
      const toY = Math.round(Number(opts.toY) || 0)
      if (!hasPoint || !Number.isFinite(Number(opts.toX)) || !Number.isFinite(Number(opts.toY))) {
        return `(() => JSON.stringify({ ok: false, error: '拖拽需要起点 x/y 和终点 toX/toY' }))()`
      }
      return `(() => {
  const sx = ${px}, sy = ${py}, ex = ${JSON.stringify(toX)}, ey = ${JSON.stringify(toY)};
  const pick = (x, y) => ${deepPickScript('x', 'y')};
  const start = pick(sx, sy) || document.body;
  const end = pick(ex, ey) || start;
  const button = ${JSON.stringify(opts.button ?? 'left')};
  const buttonIndex = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  const base = { bubbles: true, cancelable: true, view: window, clientX: sx, clientY: sy, button: buttonIndex, buttons };
  try { start.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
  start.dispatchEvent(new MouseEvent('mousedown', base));
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const cx = sx + (ex - sx) * i / steps;
    const cy = sy + (ey - sy) * i / steps;
    const node = pick(cx, cy) || end;
    const move = { ...base, clientX: cx, clientY: cy };
    try { node.dispatchEvent(new PointerEvent('pointermove', { ...move, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
    node.dispatchEvent(new MouseEvent('mousemove', move));
  }
  const up = { ...base, clientX: ex, clientY: ey, buttons: 0 };
  try { end.dispatchEvent(new PointerEvent('pointerup', { ...up, pointerId: 1, pointerType: 'mouse', isPrimary: true })); } catch (e) {}
  end.dispatchEvent(new MouseEvent('mouseup', up));
  return JSON.stringify({ ok: true, detail: '已拖拽 (' + sx + ',' + sy + ') → (' + ex + ',' + ey + ')' });
})()`
    }
    case 'type': {
      // Native value setter + input event: React/Vue track the value through the
      // setter, so assigning el.value alone leaves controlled inputs at "". The
      // setter belongs to HTMLInputElement/HTMLTextAreaElement — calling it on
      // anything else throws "Illegal invocation", so check the element first.
      return `(() => {${lookup}
  try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (e) {}
  const isTextControl = (el instanceof HTMLInputElement) || (el instanceof HTMLTextAreaElement);
  if (!isTextControl && !(el.isContentEditable)) return JSON.stringify({ ok: false, error: '该元素不能输入文字：' + el.tagName.toLowerCase() });
  if (el.isContentEditable) {
    try { el.focus(); } catch (e) {}
    el.textContent = ${value};
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value} }));
    return JSON.stringify({ ok: true, detail: '已向 contenteditable 输入 ' + ${value}.length + ' 个字符' });
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
  if (setter && setter.set) setter.call(el, ${value}); else el.value = ${value};
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value} }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ ok: true, detail: '已输入 ' + ${value}.length + ' 个字符' });
})()`
    }
    case 'press': {
      const parsed = parseKeyChord(String(opts.key ?? ''))
      if (!parsed.ok) {
        return `(() => JSON.stringify({ ok: false, error: ${JSON.stringify(parsed.error)} }))()`
      }
      const chord = parsed.chord
      const target = hasSelectorOrPoint
        ? `${lookup}
  const target = el || document.activeElement || document.body;`
        : `const target = document.activeElement || document.body;`
      return `(() => {${target}
  if (!target) return JSON.stringify({ ok: false, error: '找不到接收按键的元素' });
  try { if (target.focus) target.focus({ preventScroll: true }); } catch (e) {}
  const init = {
    bubbles: true,
    cancelable: true,
    key: ${JSON.stringify(chord.key)},
    code: ${JSON.stringify(chord.code)},
    keyCode: ${JSON.stringify(chord.keyCode)},
    which: ${JSON.stringify(chord.keyCode)},
    altKey: ${JSON.stringify((chord.modifiers & KEY_MODIFIER.alt) !== 0)},
    ctrlKey: ${JSON.stringify((chord.modifiers & KEY_MODIFIER.ctrl) !== 0)},
    metaKey: ${JSON.stringify((chord.modifiers & KEY_MODIFIER.meta) !== 0)},
    shiftKey: ${JSON.stringify((chord.modifiers & KEY_MODIFIER.shift) !== 0)},
  };
  for (const type of ['keydown', 'keypress', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, init));
  return JSON.stringify({ ok: true, detail: '已按下 ' + ${JSON.stringify(chord.key)} });
})()`
    }
    case 'scroll': {
      const dx = JSON.stringify(clampDelta(opts.deltaX))
      const dy = JSON.stringify(clampDelta(opts.deltaY))
      const direction = opts.direction === 'up' || opts.direction === 'left' || opts.direction === 'right'
        ? opts.direction
        : 'down'
      const dir = JSON.stringify(direction)
      const under = hasPoint ? `const under = ${deepPickScript(px, py)};` : `const under = null;`
      return `(() => {
  const dx0 = ${dx}, dy0 = ${dy}, dir = ${dir};
  const vw = window.innerWidth || 800, vh = window.innerHeight || 600;
  const dx = dx0 || ((dir === 'left' ? -1 : dir === 'right' ? 1 : 0) * vw * 0.8);
  const dy = dy0 || ((dir === 'up' ? -1 : dir === 'down' ? 1 : 0) * vh * 0.8);
  ${under}
  let node = under;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight) break;
    node = node.parentElement;
  }
  const target = node && node !== document.body && node !== document.documentElement ? node : null;
  if (target) target.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  else window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return JSON.stringify({ ok: true, detail: '已滚动 ' + Math.round(dx) + ',' + Math.round(dy) });
})()`
    }
    case 'wait':
      // The caller awaits the promise, so the delay happens page-side and the
      // tool result still arrives in one round trip.
      return `new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({ ok: true, detail: '已等待 ' + ${ms} + 'ms' })), ${ms}))`
    default:
      return null
  }
}
