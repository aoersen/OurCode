/**
 * Readable-page extraction for the renderer.
 *
 * The hosted DeepSeek Fetch returns Markdown directly; the local path needs to
 * approximate it without adding a jsdom/Readability dependency. This runs in
 * the renderer (DOMParser is available), strips chrome, picks the densest
 * content block, and converts a practical HTML subset to Markdown. It is
 * intentionally conservative: when nothing looks like an article it falls back
 * to the whole body rather than returning an empty page.
 */
import { decodeHtmlEntities } from '@shared/webTools'

const MAX_TEXT_CHARS = 40_000

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'template',
  'form', 'nav', 'header', 'footer', 'aside', 'button', 'select', 'textarea',
  'input', 'dialog',
])

const SKIP_SELECTOR = [
  ...SKIP_TAGS,
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[aria-hidden="true"]',
  '.ad', '.ads', '.advert', '.advertisement', '.banner', '.cookie', '.cookies',
  '.sidebar', '.menu', '.modal', '.popup', '.share', '.social', '.breadcrumb',
].join(',')

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'figure', 'figcaption',
  'dl', 'dt', 'dd', 'details', 'summary',
])

export interface ExtractedPage {
  title: string
  text: string
}

function textOf(element: Element): string {
  return (element as HTMLElement).innerText || element.textContent || ''
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/g, ' ')
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
}

function normalizePlain(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function absoluteUrl(value: string, baseUrl: string): string {
  if (!value) return ''
  try {
    const url = new URL(value, baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function pickTitle(doc: Document): string {
  const og = doc.querySelector('meta[property="og:title"], meta[name="twitter:title"]')?.getAttribute('content')
  const raw = og || doc.querySelector('title')?.textContent || doc.querySelector('h1')?.textContent || ''
  return normalizeInline(raw).trim().slice(0, 300)
}

/** Choose the densest content block, preferring article-ish containers. */
function pickMain(doc: Document): Element | null {
  const body = doc.body
  if (!body) return doc.documentElement
  const selectors = [
    'article', 'main', '[role="main"]', '.article', '.post', '.entry-content',
    '.article-content', '.post-content', '.markdown-body', '#content', '#main', '.content',
  ]
  let best: Element | null = null
  let bestScore = -1
  for (const selector of selectors) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      const text = textOf(el)
      if (text.length < 200) continue
      const linkChars = Array.from(el.querySelectorAll('a'))
        .reduce((sum, link) => sum + textOf(link).length, 0)
      const score = text.length - linkChars * 0.9
      if (score > bestScore) {
        best = el
        bestScore = score
      }
    }
  }
  const bodyLength = textOf(body).length
  if (!best || bestScore < Math.min(400, bodyLength * 0.25)) return body
  return best
}

function renderTable(table: Element, baseUrl: string): string {
  const rows = Array.from(table.querySelectorAll('tr'))
    .map((tr) => Array.from(tr.children)
      .filter((cell) => /^(td|th)$/i.test(cell.tagName))
      .map((cell) => renderChildren(cell, baseUrl).trim().replace(/\|/g, '\\|').replace(/\s+/g, ' ')))
    .filter((cells) => cells.length > 0)
  if (rows.length === 0) return ''
  const width = Math.max(...rows.map((row) => row.length))
  const padded = rows.map((row) => [...row, ...Array(width - row.length).fill('')])
  const header = padded[0]
  const body = padded.slice(1)
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ]
  return `\n\n${lines.join('\n')}\n\n`
}

function renderChildren(element: Element, baseUrl: string): string {
  return Array.from(element.childNodes)
    .map((node) => renderNode(node, baseUrl))
    .join('')
}

function renderNode(node: Node, baseUrl: string): string {
  if (node.nodeType === 3) return normalizeInline(node.nodeValue || '')
  if (node.nodeType !== 1) return ''
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (SKIP_TAGS.has(tag)) return ''
  if (tag === 'br') return '\n'
  if (tag === 'hr') return '\n\n---\n\n'

  if (tag === 'pre') {
    const code = (el.textContent || '').replace(/\n+$/, '')
    return code ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : ''
  }
  if (tag === 'code') {
    const code = normalizeInline(el.textContent || '').trim()
    return code ? `\`${code}\`` : ''
  }
  if (tag === 'img') {
    const src = absoluteUrl(el.getAttribute('src') || el.getAttribute('data-src') || '', baseUrl)
    const alt = normalizeInline(el.getAttribute('alt') || '').trim()
    return src ? `![${alt}](${src})` : ''
  }
  if (tag === 'a') {
    const inner = renderChildren(el, baseUrl).trim()
    if (!inner) return ''
    const href = absoluteUrl(el.getAttribute('href') || '', baseUrl)
    return href ? `[${inner}](${href})` : inner
  }
  if (/^h[1-6]$/.test(tag)) {
    const inner = renderChildren(el, baseUrl).trim()
    return inner ? `\n\n${'#'.repeat(Number(tag[1]))} ${inner}\n\n` : ''
  }
  if (tag === 'blockquote') {
    const inner = renderChildren(el, baseUrl).trim()
    return inner ? `\n\n${inner.split('\n').map((line) => `> ${line}`).join('\n')}\n\n` : ''
  }
  if (tag === 'ul' || tag === 'ol') {
    const ordered = tag === 'ol'
    const items = Array.from(el.children).filter((child) => child.tagName.toLowerCase() === 'li')
    const lines = items.map((li, index) => {
      const content = renderChildren(li, baseUrl).trim().replace(/\n{2,}/g, '\n')
      return `${ordered ? `${index + 1}.` : '-'} ${content.replace(/\n/g, '\n  ')}`
    })
    return lines.length ? `\n\n${lines.join('\n')}\n\n` : ''
  }
  if (tag === 'table') return renderTable(el, baseUrl)
  if (tag === 'strong' || tag === 'b') {
    const inner = renderChildren(el, baseUrl).trim()
    return inner ? `**${inner}**` : ''
  }
  if (tag === 'em' || tag === 'i') {
    const inner = renderChildren(el, baseUrl).trim()
    return inner ? `*${inner}*` : ''
  }
  if (BLOCK_TAGS.has(tag)) {
    const inner = renderChildren(el, baseUrl).trim()
    return inner ? `\n\n${inner}\n\n` : ''
  }
  return renderChildren(el, baseUrl)
}

function toMarkdown(root: Element, baseUrl: string): string {
  return renderNode(root, baseUrl)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS)
}

export function extractReadable(html: string, baseUrl: string, contentType = ''): ExtractedPage {
  const source = String(html || '')
  if (!source.trim()) return { title: '', text: '' }

  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  if (mediaType && !/html|xml/.test(mediaType)) {
    return { title: '', text: normalizePlain(source).slice(0, MAX_TEXT_CHARS) }
  }

  if (typeof DOMParser === 'undefined') {
    return { title: '', text: normalizePlain(stripTags(source)).slice(0, MAX_TEXT_CHARS) }
  }

  let doc: Document
  try {
    doc = new DOMParser().parseFromString(source, 'text/html')
  } catch {
    return { title: '', text: normalizePlain(stripTags(source)).slice(0, MAX_TEXT_CHARS) }
  }

  for (const el of Array.from(doc.querySelectorAll(SKIP_SELECTOR))) el.remove()
  const title = pickTitle(doc)
  const candidate = pickMain(doc)
  let text = candidate ? toMarkdown(candidate, baseUrl) : ''

  // A JS shell or a tiny article container can leave almost nothing; widen to
  // the whole body before giving up (the caller may then try hosted Fetch).
  if (text.length < 200 && doc.body && candidate !== doc.body) {
    const fallback = toMarkdown(doc.body, baseUrl)
    if (fallback.length > text.length) text = fallback
  }

  return { title, text }
}
