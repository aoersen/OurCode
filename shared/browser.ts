/**
 * Pure helpers for the agent browser session — URL policy, page scripts, and
 * how captured output gets rendered for a model. Kept free of Electron imports
 * so the main process, the renderer panel and the unit tests all see one copy.
 */

import type { BrowserAction, BrowserConsoleEntry } from './types'

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

/**
 * Build the in-page script for one interaction.
 *
 * Values reach the page through JSON.stringify only, so a selector can never
 * break out of the expression it is embedded in. The result is a JSON string
 * the main process parses back into a BrowserActResult.
 */
export function buildActScript(
  action: BrowserAction,
  opts: { selector?: string; text?: string; key?: string; ms?: number } = {},
): string | null {
  const sel = JSON.stringify(opts.selector ?? '')
  const value = JSON.stringify(opts.text ?? '')
  const key = JSON.stringify(opts.key ?? '')
  const ms = JSON.stringify(Math.max(0, Math.min(Number(opts.ms) || 0, 10_000)))
  // A malformed selector THROWS in querySelector rather than returning null, and
  // the model gets a raw SyntaxError back. Wrap the lookup so it always comes
  // back as a readable "no match" it can correct.
  const find = `(() => { try { return document.querySelector(${sel}); } catch (e) { return '__invalid__' + e.message; } })()`
  const resolve = `
  const el = ${find};
  if (typeof el === 'string' && el.indexOf('__invalid__') === 0) return JSON.stringify({ ok: false, error: '选择器不合法：' + ${sel} + ' — ' + el.slice(11) });
  if (!el) return JSON.stringify({ ok: false, error: '选择器没有匹配到元素：' + ${sel} });`

  switch (action) {
    case 'click':
      return `(() => {${resolve}
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  el.click();
  return JSON.stringify({ ok: true, detail: el.tagName.toLowerCase() + ' 已点击' });
})()`
    case 'type':
      // Native value setter + input event: React/Vue track the value through the
      // setter, so assigning el.value alone leaves controlled inputs at "". The
      // setter belongs to HTMLInputElement/HTMLTextAreaElement — calling it on
      // anything else throws "Illegal invocation", so check the element first.
      return `(() => {${resolve}
  const isTextControl = (el instanceof HTMLInputElement) || (el instanceof HTMLTextAreaElement);
  if (!isTextControl && !(el.isContentEditable)) return JSON.stringify({ ok: false, error: '该元素不能输入文字：' + el.tagName.toLowerCase() });
  if (el.isContentEditable) {
    el.focus();
    el.textContent = ${value};
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value} }));
    return JSON.stringify({ ok: true, detail: '已向 contenteditable 输入 ' + ${value}.length + ' 个字符' });
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value');
  if (setter && setter.set) setter.set.call(el, ${value}); else el.value = ${value};
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${value} }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return JSON.stringify({ ok: true, detail: '已输入 ' + ${value}.length + ' 个字符' });
})()`
    case 'press': {
      const withSelector = String(opts.selector ?? '').trim() !== ''
      return `(() => {${withSelector ? `
  const el = ${find};
  if (typeof el === 'string' && el.indexOf('__invalid__') === 0) return JSON.stringify({ ok: false, error: '选择器不合法：' + ${sel} });
  const target = el || document.activeElement || document.body;` : `
  const target = document.activeElement || document.body;`}
  if (!target) return JSON.stringify({ ok: false, error: '找不到接收按键的元素' });
  const k = ${key};
  // Named keys are not "Key"+upper: code for Enter is 'Enter', for 'a' is 'KeyA'.
  const code = k.length === 1 ? 'Key' + k.toUpperCase() : k.toUpperCase();
  for (const type of ['keydown', 'keypress', 'keyup']) {
    target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: k, code }));
  }
  return JSON.stringify({ ok: true, detail: '已按下 ' + k });
})()`
    }
    case 'scroll':
      return `(() => {
  window.scrollBy(0, document.body ? document.body.clientHeight * 0.8 : 600);
  return JSON.stringify({ ok: true, detail: '已向下滚动' });
})()`
    case 'wait':
      // The caller awaits the promise, so the delay happens page-side and the
      // tool result still arrives in one round trip.
      return `new Promise((resolve) => setTimeout(() => resolve(JSON.stringify({ ok: true, detail: '已等待 ' + ${ms} + 'ms' })), ${ms}))`
    default:
      return null
  }
}
