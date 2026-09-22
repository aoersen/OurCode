import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'dompurify'
// Light code-block syntax (极简纯净版): chat code blocks are now light panels
// in light mode; the dark theme restores github-dark colors via the
// `:root.dark .code-block .hljs-*` rules in global.css.
import 'highlight.js/styles/github.css'
// Register only the languages this app actually renders (per-language modules
// instead of the full ~190-language bundle). Anything else falls back to
// plaintext in renderer.code below — a missing highlight is a visual degrade,
// never an error.
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import graphql from 'highlight.js/lib/languages/graphql'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import less from 'highlight.js/lib/languages/less'
import makefile from 'highlight.js/lib/languages/makefile'
import markdown from 'highlight.js/lib/languages/markdown'
import objectivec from 'highlight.js/lib/languages/objectivec'
import perl from 'highlight.js/lib/languages/perl'
import php from 'highlight.js/lib/languages/php'
import properties from 'highlight.js/lib/languages/properties'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scala from 'highlight.js/lib/languages/scala'
import scss from 'highlight.js/lib/languages/scss'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import vbnet from 'highlight.js/lib/languages/vbnet'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { t, getLocale } from '@/i18n'
import { MATERIAL_PATHS } from './icons/materialPaths'

const LANGUAGES: Array<[string, Parameters<typeof hljs.registerLanguage>[1]]> = [
  ['bash', bash], ['c', c], ['cpp', cpp], ['csharp', csharp], ['css', css],
  ['diff', diff], ['dockerfile', dockerfile], ['go', go], ['graphql', graphql],
  ['ini', ini], ['java', java], ['javascript', javascript], ['json', json],
  ['kotlin', kotlin], ['less', less], ['makefile', makefile], ['markdown', markdown],
  ['objectivec', objectivec], ['perl', perl], ['php', php], ['properties', properties],
  ['python', python], ['ruby', ruby], ['rust', rust], ['scala', scala], ['scss', scss],
  ['shell', shell], ['sql', sql], ['swift', swift], ['typescript', typescript],
  ['vbnet', vbnet], ['xml', xml], ['yaml', yaml],
]
for (const [name, def] of LANGUAGES) hljs.registerLanguage(name, def)

interface MarkdownRendererProps {
  content: string
  /** Optional: resolve a relative image href into an absolute URL before
   *  rendering. The file preview uses this to point local images at the
   *  ourcode-file:// protocol. Chat passes nothing (no file context). */
  rewriteImageSrc?: (href: string) => string
}

const escapeHtml = (s: string): string => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

/** 连字图标字体的本地替代：把 Material Symbols 轮廓直接内联进 HTML 字符串，
    离线/局域网部署时图标不会退化成 "content_copy" 这样的字面文本。 */
const msIconSvg = (name: string): string =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" focusable="false" data-icon="${name}"><path d="${MATERIAL_PATHS[name] ?? ''}"/></svg>`

// Custom renderer
const renderer = new marked.Renderer()

// Override code block rendering using a generic approach
// (accepts both the newer object form {text, lang} and the legacy (code, infostring) form)
renderer.code = function (...args: any[]) {
  const first = args[0]
  const text = typeof first === 'object' ? first.text : first
  const lang = typeof first === 'object' ? first.lang : args[1]
  const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
  // 'plaintext' is not a registered highlight.js language (it's only an internal
  // auto-detect marker), so hljs.highlight would throw for it. For absent or
  // unknown fence languages, escape the raw text — a missing highlight is a
  // visual degrade, never an error.
  const highlighted = language === 'plaintext'
    ? escapeHtml(text)
    : hljs.highlight(text, { language }).value
  // NOTE: no inline onclick here — blocked by CSP and an injection vector.
  // Copy is handled via event delegation in the container (see useEffect below).
  // mockup「代码块」头部：语言徽章 + 纯图标复制按钮（本地内联 SVG，不再依赖连字图标字体）。
  return `<div class="code-block"><div class="code-header"><span class="code-lang">${language}</span><button class="copy-btn" data-copy title="${t('common.copy')}" aria-label="${t('common.copy')}">${msIconSvg('content_copy')}</button></div><pre><code class="hljs language-${language}">${highlighted}</code></pre></div>`
}

/**
 * A per-call renderer that rewrites relative image hrefs (file preview). The
 * shared chat renderer stays untouched — chat has no file context to resolve
 * against, and its global config must not change per-instance.
 */
function buildImageRewriterRenderer(resolveHref: (href: string) => string): InstanceType<typeof marked.Renderer> {
  const r = new marked.Renderer()
  // Preserve the code-block override (header + copy button) from the shared renderer
  r.code = renderer.code
  // Accepts both the newer object form {href, title, text} and the legacy
  // (href, title, text) form, like the code override above.
  r.image = function (...args: any[]) {
    const first = args[0]
    const href = typeof first === 'object' ? (first.href as string) : (args[0] as string)
    const title = typeof first === 'object' ? (first.title as string | undefined) : (args[1] as string | undefined)
    const text = typeof first === 'object' ? (first.text as string) : (args[2] as string)
    const escapeAttr = (s: string) => s.replace(/"/g, '&quot;')
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : ''
    return `<img src="${escapeAttr(resolveHref(href))}" alt="${escapeAttr(text)}"${titleAttr}>`
  }
  return r
}

marked.use({
  gfm: true,
  breaks: true,
  renderer,
})

// DOMPurify's default URI allowlist (http/https/ftp/mailto/...) drops custom
// schemes. `ourcode-file:` is the app's own local-file protocol (only serves
// files under the user's opened roots), so markdown file previews can reference
// local images through it. Chat never produces such URLs — the extra entry is a
// no-op there.
const ALLOWED_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|ourcode-file):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i

export default function MarkdownRenderer({ content, rewriteImageSrc }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  const html = useMemo(() => {
    try {
      // Sanitize the rendered HTML to prevent XSS from AI/tool output
      // (marked >= v5 no longer sanitizes; DOMPurify strips scripts/event handlers)
      // Whitelist a few rich-typography tags so AI answers can emit <mark>
      // highlights, <kbd> keys and <details>/<summary> collapsible panels —
      // nothing executable slips through (no onclick/onerror/script allowed).
      const parsed = rewriteImageSrc
        ? marked.parse(content, { renderer: buildImageRewriterRenderer(rewriteImageSrc) })
        : marked.parse(content)
      return DOMPurify.sanitize(parsed as string, {
        ADD_TAGS: ['mark', 'kbd', 'details', 'summary'],
        ADD_ATTR: ['open'],
        ALLOWED_URI_REGEXP,
      })
    } catch {
      return DOMPurify.sanitize(`<p>${content}</p>`)
    }
    // Re-render the code-block Copy label when the language changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, rewriteImageSrc, getLocale()])

  // Event-delegated copy button (works under CSP, no inline handlers)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleClick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('.copy-btn')
      if (!btn) return
      const codeEl = btn.closest('.code-block')?.querySelector('code')
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent || '').catch(() => { /* ignore */ })
      }
    }

    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [])

  return (
    <div
      ref={containerRef}
      className="markdown-body text-sm leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

/** 流式 markdown 的尾随节流渲染。Agent 循环每 50ms 冲刷一次 store（见
 *  chatStore 的 STREAM_FLUSH_MS），而 marked + highlight.js + DOMPurify 对
 *  整段渐增回答的同步解析依然是每次冲刷最重的开销（O(n²) 总量）。这里把
 *  解析频率进一步限制到 STREAM_MARKDOWN_THROTTLE_MS —— 文本刷新约 8fps，
 *  对聊天肉眼无感，但大幅降低主线程阻塞；尾随定时器保证结束后必然收敛到
 *  最终 content（不会丢尾巴）。 */
const STREAM_MARKDOWN_THROTTLE_MS = 120

/** 流式阶段的轻量渲染器：marked + DOMPurify，但不做代码块语法高亮、也不
 *  透传模型输出的原始 HTML（后者改为转义成文本，而不是只依赖 DOMPurify）。
 *  流式期间每 ~120ms 都要重解析整段渐增回答，`hljs.highlight`（对不断变长的
 *  代码块整块重高亮）是其中最重的一项；去掉后单次解析从几十~上百 ms 降到个
 *  位数 ms。该轮 commit 后由已提交消息的完整 MarkdownRenderer 接管渲染，
 *  语法高亮会在消息落定那一刻一次性出现 —— 这里永远只是预览。 */
const streamRenderer = new marked.Renderer()
streamRenderer.code = function (...args: any[]) {
  const first = args[0]
  const text = typeof first === 'object' ? first.text : first
  const lang = typeof first === 'object' ? first.lang : args[1]
  const language = lang || 'plaintext'
  return `<div class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(language)}</span></div><pre><code class="hljs language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre></div>`
}
streamRenderer.html = function (...args: any[]) {
  // Raw HTML in a live stream must render as TEXT — escaping here (instead of
  // relying on DOMPurify alone) keeps the light path safe by construction.
  const first = args[0]
  const raw = typeof first === 'object' ? first.text : first
  return escapeHtml(raw)
}

export function StreamingMarkdown({ content }: { content: string }) {
  const [display, setDisplay] = useState(content)
  const lastRenderAtRef = useRef(0)

  useEffect(() => {
    if (content === display) return
    const wait = Math.max(0, STREAM_MARKDOWN_THROTTLE_MS - (Date.now() - lastRenderAtRef.current))
    const id = setTimeout(() => {
      lastRenderAtRef.current = Date.now()
      setDisplay(content)
    }, wait)
    return () => clearTimeout(id)
    // Only react to new content — `display` is intentionally read from the
    // closure (the value at the time content last changed), so the timer always
    // targets the newest chunk and converges when the stream ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content])

  const html = useMemo(() => {
    try {
      const parsed = marked.parse(display, { renderer: streamRenderer })
      return DOMPurify.sanitize(parsed as string, {
        ADD_TAGS: ['mark', 'kbd', 'details', 'summary'],
        ADD_ATTR: ['open'],
        ALLOWED_URI_REGEXP,
      })
    } catch {
      // Never block the stream on a parse failure — show the raw text escaped
      return escapeHtml(display).replace(/\n/g, '<br>')
    }
  }, [display])

  return (
    <div
      className="markdown-body text-sm leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
