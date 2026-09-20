/**
 * Tool helper functions - actual implementations called by tools
 * These use window.electronAPI to communicate with the main process
 */
import { loadIgnorePatterns, isIgnoredPath } from './context'
import { useUIStore } from '@/stores/uiStore'
import type { ToolImageResult } from './types'
import { parseImageDataUrl } from '@/utils/imageAttach'
import {
  branchPushState,
  buildPrBody,
  commentPullRequest,
  createPullRequest,
  fetchGhAvailability,
  formatPullRequestForModel,
  listPullRequests,
  viewPullRequest,
} from '@/services/github'
import {
  DEFAULT_TAIL_CHARS,
  formatRunOutput,
  latestAgentRun,
  listAgentRuns,
  readAgentRun,
  startAgentRun,
  stopAgentRun,
} from '@/services/terminalRuns'

const EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', 'vendor', '.vscode', '.idea']

/** Current workspace root — the file tree's data attribute when mounted,
 *  falling back to the selected project (the tree only mounts in tree view). */
function workspaceRoot(): string {
  return document.getElementById('file-tree-root')?.getAttribute('data-root-path') || useUIStore.getState().rootPath || ''
}

/** Load .ourcodeignore patterns once per workspace root */
async function ensureIgnoreLoaded(): Promise<void> {
  const rootPath = workspaceRoot()
  if (rootPath) {
    try { await loadIgnorePatterns(rootPath) } catch { /* ignore */ }
  }
}

// The read_file tool advertises "Max 2000 lines, 50KB" — enforce both so a
// huge file can't flood the model's context window with the full content.
const READ_FILE_MAX_LINES = 2000
const READ_FILE_MAX_BYTES = 50 * 1024

/** Read a file with line numbers */
export async function readFile(path: string, startLine?: number, endLine?: number): Promise<string> {
  const { content } = await window.electronAPI.readFile(path)
  const lines = content.split('\n')
  // Apply the tool's advertised cap when the caller didn't pick an explicit
  // window: start at 1, cap the end at 2000 lines and ~50KB of text.
  const start = Math.max(1, startLine || 1) - 1
  const effectiveEnd = endLine ?? Math.min(lines.length, start + READ_FILE_MAX_LINES)
  const end = Math.min(lines.length, effectiveEnd)
  const selected = lines.slice(start, end)
  let out = selected.map((line, i) => `${start + i + 1}: ${line}`).join('\n')
  if (out.length > READ_FILE_MAX_BYTES) {
    out = out.slice(0, READ_FILE_MAX_BYTES) + '\n...(truncated)'
  }
  return out
}

/** Combined cap for read_multiple_files — wide batches must not flood the
 *  model's context window even though each file is already capped at 50KB. */
const READ_MULTI_MAX_TOTAL_BYTES = 200 * 1024

/** Read several files at once. Each file is capped independently at the same
 *  2000 lines / 50KB as read_file; the combined output is capped too, and the
 *  remaining files are named when the cap is hit so the model can decide. A
 *  failing file is reported inline without interrupting the others. */
export async function readMultipleFiles(paths: string[]): Promise<string> {
  const clean = Array.from(new Set((Array.isArray(paths) ? paths : []).map((p) => String(p || '').trim()).filter(Boolean)))
  if (clean.length === 0) return 'Error: paths 不能为空'

  const sections: string[] = []
  let totalBytes = 0
  let shown = 0
  for (const p of clean) {
    const header = `===== ${p} =====`
    let body = ''
    try {
      const { content } = await window.electronAPI.readFile(p)
      const lines = content.split('\n')
      const end = Math.min(lines.length, READ_FILE_MAX_LINES)
      body = lines.slice(0, end).map((line, i) => `${i + 1}: ${line}`).join('\n')
      if (body.length > READ_FILE_MAX_BYTES) {
        body = body.slice(0, READ_FILE_MAX_BYTES) + '\n...(truncated)'
      }
    } catch (error: any) {
      body = `(读取失败: ${error?.message || String(error)})`
    }
    if (totalBytes + header.length + body.length > READ_MULTI_MAX_TOTAL_BYTES && sections.length > 0) {
      sections.push(`...(总输出已达上限，剩余 ${clean.length - shown} 个文件未展示：${clean.slice(shown).join(', ')})`)
      break
    }
    sections.push(`${header}\n${body}`)
    totalBytes += header.length + body.length
    shown++
  }
  return sections.join('\n\n')
}

/** List directory contents (recursive up to maxDepth) */
export async function listDirectory(path: string, maxDepth: number = 1): Promise<string> {
  await ensureIgnoreLoaded()
  const lines: string[] = []
  await walkListing(path, '', 0, Math.min(maxDepth, 5), lines)
  return lines.join('\n')
}

async function walkListing(dirPath: string, prefix: string, depth: number, maxDepth: number, lines: string[]): Promise<void> {
  if (depth > maxDepth) return
  const entries: any[] = await window.electronAPI.listDir(dirPath)
  if (!entries || entries.length === 0) {
    if (depth === 0) lines.push('(empty directory)')
    return
  }

  for (const entry of entries) {
    if (EXCLUDED_DIRS.includes(entry.name)) continue
    if (isIgnoredPath(entry.path)) continue
    const icon = entry.isDirectory ? '[DIR]' : '[FILE]'
    const size = entry.size != null ? ` (${formatSize(entry.size)})` : ''
    lines.push(`${prefix}${icon} ${entry.name}${size}`)
    if (entry.isDirectory && depth < maxDepth) {
      await walkListing(entry.path, prefix + '  ', depth + 1, maxDepth, lines)
    }
  }
}

/** Get directory tree structure */
export async function getDirectoryTree(rootPath: string, maxDepth: number = 3): Promise<string> {
  await ensureIgnoreLoaded()
  const lines: string[] = []
  await walkTree(rootPath, '', 0, maxDepth, lines)
  return lines.join('\n')
}

async function walkTree(dirPath: string, prefix: string, depth: number, maxDepth: number, lines: string[]): Promise<void> {
  if (depth >= maxDepth) return
  const entries: any[] = await window.electronAPI.listDir(dirPath)
  if (!entries) return

  const filtered = entries.filter((e) => !EXCLUDED_DIRS.includes(e.name) && !isIgnoredPath(e.path))
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]
    const isLast = i === filtered.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '
    lines.push(`${prefix}${connector}${entry.name}`)
    if (entry.isDirectory) {
      await walkTree(entry.path, prefix + childPrefix, depth + 1, maxDepth, lines)
    }
  }
}

/** Search files by name pattern */
export async function searchFiles(rootPath: string, pattern: string): Promise<string> {
  await ensureIgnoreLoaded()
  const results: string[] = await window.electronAPI.searchFiles(rootPath, pattern)
  if (!results || results.length === 0) return 'No files found'
  return results.filter((p) => !isIgnoredPath(p)).slice(0, 50).join('\n')
}

/** Search text content in files (literal substring by default; regex when useRegex) */
export async function searchInFiles(rootPath: string, query: string, filePattern?: string, useRegex = false): Promise<string> {
  await ensureIgnoreLoaded()
  const options: any = { caseSensitive: false }
  if (useRegex) options.regex = true
  if (filePattern) options.filePattern = filePattern
  const results: any[] = await window.electronAPI.searchInFiles(rootPath, query, options)
  if (!results || results.length === 0) return 'No matches found'
  return results.filter((r) => !isIgnoredPath(r.filePath)).slice(0, 50).map((r: any) => `${r.filePath}:${r.lineNumber}: ${r.lineContent}`).join('\n')
}

/** Write content to a file */
export async function writeFile(path: string, content: string): Promise<string> {
  await window.electronAPI.writeFile(path, content, 'utf-8')
  return `File written: ${path}`
}

/* ═══════════════ Text-match engine (anchor self-healing) ═══════════════
 * The edit tools are exact-text find/replace, but LLMs routinely emit oldText
 * that no longer byte-matches the file (trailing whitespace, CRLF, smart
 * quotes/dashes/NBSP, or a block that drifted). Instead of just failing:
 *   - a normalized (fuzzy) match is applied only when UNIQUE, and reported;
 *   - an ambiguous oldText (several matches, no context/replaceAll) is refused
 *     with every occurrence listed — never a silent "first hit wins";
 *   - a total miss reports the closest lines (near-miss hints) so the model
 *     can retry with a corrected oldText without re-reading the whole file.
 * multi_edit_file stays all-or-nothing: nothing is written unless every edit
 * resolves (exact or unique fuzzy).
 */

/** Punctuation/whitespace variants folded during fuzzy matching: NBSP and
 *  friends become plain spaces, smart quotes/dashes/ellipsis become ASCII. */
const NORMALIZE_PUNCT: Record<string, string> = {
  '\u00a0': ' ',
  '\u2007': ' ',
  '\u202f': ' ',
  '\u3000': ' ',
  '\u2018': "'",
  '\u2019': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2026': '...',
}

/** Dominant line ending of `content` ('\n' for no-newline files). */
function detectLineEnding(content: string): '\n' | '\r\n' {
  const totalLf = content.split('\n').length - 1
  if (totalLf === 0) return '\n'
  const crlf = (content.match(/\r\n/g) || []).length
  return crlf * 2 >= totalLf ? '\r\n' : '\n'
}

/** Re-write `text`'s line endings to match the file's dominant style, so
 *  replacing inside a CRLF file never leaves mixed endings. No-op when the
 *  file is LF or `text` has no newlines. */
function adaptLineEnding(content: string, text: string): string {
  if (!text.includes('\n')) return text
  return detectLineEnding(content) === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text
}

/** Single-pass normalization with a position map: the i-th normalized char
 *  originates from original index map[i]. Per line: CRLF→LF, the leading
 *  whitespace run is kept verbatim (indentation is significant), other runs
 *  collapse to one space, trailing whitespace drops, punctuation variants are
 *  substituted. The map lets a match found in the normalized text be spliced
 *  back into the original file exactly. */
function normalizeWithMap(s: string): { text: string; map: number[] } {
  const chars: string[] = []
  const map: number[] = []
  const n = s.length
  let i = 0
  let atLineStart = true
  while (i < n) {
    const ch = s[i]
    if (ch === '\r' && s[i + 1] === '\n') { i += 1; continue } // CR of a CRLF pair (LF below)
    if (ch === '\n') {
      chars.push('\n'); map.push(i); i += 1; atLineStart = true; continue
    }
    if (ch === ' ' || ch === '\t') {
      let run = i
      while (run < n && (s[run] === ' ' || s[run] === '\t')) run += 1
      if (atLineStart) {
        // Leading indentation — keep exactly as-is.
        for (let k = i; k < run; k++) { chars.push(s[k]); map.push(k) }
      } else if (run < n && s[run] !== '\n') {
        // Interior run → one space; a trailing run before '\n' drops.
        chars.push(' '); map.push(i)
      }
      i = run
      continue
    }
    const sub = NORMALIZE_PUNCT[ch]
    if (sub !== undefined) {
      for (let k = 0; k < sub.length; k++) { chars.push(sub[k]); map.push(i) }
    } else {
      chars.push(ch); map.push(i)
    }
    atLineStart = false
    i += 1
  }
  return { text: chars.join(''), map }
}

/** Offsets of each line's start in `content` (for 1-based line lookups). */
function buildLineStarts(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 1-based line number of the line containing `offset`. */
function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** Trimmed, capped line text for error messages. */
function lineSnippet(content: string, lineStarts: number[], line: number): string {
  const start = lineStarts[line - 1]
  const end = lineStarts[line] ?? content.length
  return content.slice(start, end).trim().slice(0, 80)
}

interface MatchCandidate {
  /** Start index of the match in the ORIGINAL content. */
  index: number
  /** Position of the match in the searched haystack (normalized space for fuzzy). */
  norm: number
  /** 1-based line number in the original file. */
  line: number
  snippet: string
}

/** All non-overlapping occurrences of `needle` in `haystack`. With `map`
 *  (normalized→original), `index` is translated back to the original file;
 *  `snippetSource` is always the original content for readable excerpts. */
function findOccurrences(
  haystack: string,
  needle: string,
  snippetSource: string,
  lineStarts: number[],
  map?: number[],
): MatchCandidate[] {
  const out: MatchCandidate[] = []
  if (!needle) return out
  let from = 0
  let at = haystack.indexOf(needle, from)
  while (at !== -1) {
    const orig = map ? map[at] : at
    const line = lineAt(lineStarts, orig)
    out.push({ index: orig, norm: at, line, snippet: lineSnippet(snippetSource, lineStarts, line) })
    from = at + Math.max(1, needle.length)
    at = haystack.indexOf(needle, from)
  }
  return out
}

/** True when `context` immediately follows `start` in `haystack` (exact or
 *  normalized text). Comparison is leading-whitespace-insensitive so a context
 *  of "= 2" still matches file text " = 2" — the model usually omits the space. */
function contextFollows(haystack: string, start: number, context: string): boolean {
  const normCtx = normalizeWithMap(context).text.trim()
  if (!normCtx) return true
  const window = normalizeWithMap(haystack.slice(start, start + normCtx.length + 64)).text
  return window.trimStart().startsWith(normCtx)
}

type EditOutcome =
  | { kind: 'ok'; index: number; length: number; fuzzy: boolean }
  | { kind: 'ok_all'; occurrences: MatchCandidate[] }
  | { kind: 'ambiguous'; fuzzy: boolean; contextMiss: boolean; candidates: MatchCandidate[]; total: number }
  | { kind: 'notfound'; nearMisses: Array<{ line: number; snippet: string }> }

/** Resolve one exact-text edit against `content`: returns where to splice, or
 *  a structured reason the caller renders into a self-healing error message. */
function resolveMatch(opts: {
  content: string
  oldText: string
  context?: string
  replaceAll: boolean
}): EditOutcome {
  const { content, oldText, context, replaceAll } = opts
  const lineStarts = buildLineStarts(content)

  // ── Exact pass ──
  const exact = findOccurrences(content, oldText, content, lineStarts)
  const exactCtx = context ? exact.filter((c) => contextFollows(content, c.index + oldText.length, context)) : exact
  if (exactCtx.length > 0) {
    if (exactCtx.length === 1) return { kind: 'ok', index: exactCtx[0].index, length: oldText.length, fuzzy: false }
    if (replaceAll) return { kind: 'ok_all', occurrences: exactCtx }
    return { kind: 'ambiguous', fuzzy: false, contextMiss: false, candidates: exactCtx, total: exactCtx.length }
  }
  if (context && exact.length > 0) {
    // oldText exists but context follows none of them — the model should fix context.
    return { kind: 'ambiguous', fuzzy: false, contextMiss: true, candidates: exact, total: exact.length }
  }

  // ── Normalized (fuzzy) pass — applied only when unique ──
  const { text: normText, map } = normalizeWithMap(content)
  const normNeedle = normalizeWithMap(oldText).text
  if (!normNeedle) return { kind: 'notfound', nearMisses: [] }
  const fuzzy = findOccurrences(normText, normNeedle, content, lineStarts, map)
  const fuzzyCtx = context
    ? fuzzy.filter((c) => contextFollows(normText, c.norm + normNeedle.length, context))
    : fuzzy
  if (fuzzyCtx.length > 0) {
    if (fuzzyCtx.length === 1) {
      const c = fuzzyCtx[0]
      const spanStart = c.index
      const spanEnd = map[c.norm + normNeedle.length - 1] + 1
      // Fail-safe: only splice when the span really re-normalizes to the needle.
      if (normalizeWithMap(content.slice(spanStart, spanEnd)).text === normNeedle) {
        return { kind: 'ok', index: spanStart, length: spanEnd - spanStart, fuzzy: true }
      }
      return { kind: 'notfound', nearMisses: findNearMisses(content, lineStarts, oldText) }
    }
    return { kind: 'ambiguous', fuzzy: true, contextMiss: false, candidates: fuzzyCtx, total: fuzzyCtx.length }
  }
  if (context && fuzzy.length > 0) {
    return { kind: 'ambiguous', fuzzy: true, contextMiss: true, candidates: fuzzy, total: fuzzy.length }
  }
  return { kind: 'notfound', nearMisses: findNearMisses(content, lineStarts, oldText) }
}

/** Up to 3 lines whose normalized text contains the needle's most distinctive
 *  fragment — hints for the model when the oldText drifted or changed. */
function findNearMisses(content: string, lineStarts: number[], oldText: string): Array<{ line: number; snippet: string }> {
  const needleLines = normalizeWithMap(oldText).text.split('\n').map((l) => l.trim())
  const first = needleLines.find((l) => l.length > 0)
  if (!first) return []
  const words = first.split(/[^A-Za-z0-9_$]+/).filter((w) => w.length >= 4)
  const firstWords = words.slice(0, 2).join(' ')
  const anchors = Array.from(new Set([first, firstWords, words[0] ?? ''].filter((a) => a && a.length >= 4)))
  const normLines = normalizeWithMap(content).text.split('\n')
  const hits: Array<{ line: number; snippet: string }> = []
  for (const anchor of anchors) {
    for (let i = 0; i < normLines.length && hits.length < 3; i++) {
      if (normLines[i].includes(anchor)) {
        const line = i + 1
        hits.push({ line, snippet: lineSnippet(content, lineStarts, line) })
      }
    }
    if (hits.length > 0) return hits
  }
  return hits
}

/** Multi-line detail for an ambiguous / context-missed edit failure. */
function buildAmbiguousDetail(path: string, o: Extract<EditOutcome, { kind: 'ambiguous' }>, bullet = '- '): string {
  const reason = o.contextMiss
    ? `匹配到 ${o.total} 处，但提供的 context 未紧跟任何一处；请修正 context 以锁定目标`
    : `匹配到 ${o.total} 处（replaceAll=false 且未提供可消歧的 context）；请补充 context（紧跟 oldText 的文本）或改用 replaceAll`
  const fuzzyNote = o.fuzzy ? '（该文本经空白/标点归一化后仍匹配多处）' : ''
  const lines = o.candidates.slice(0, 10).map((c) => `    line ${c.line}: ${c.snippet}`)
  const more = o.candidates.length > 10 ? `\n    …等 ${o.candidates.length} 处` : ''
  return `${bullet}${path}: ${reason}${fuzzyNote}：\n${lines.join('\n')}${more}`
}

/** Multi-line detail for a not-found edit failure, with near-miss hints. */
function buildNotFoundDetail(path: string, o: Extract<EditOutcome, { kind: 'notfound' }>, bullet = '- '): string {
  if (o.nearMisses.length === 0) {
    return `${bullet}${path}: 未找到 oldText。请用 read_file 查看文件当前内容后以新的 oldText 重试。`
  }
  return (
    `${bullet}${path}: 未找到精确文本。相近位置（文本可能已变化）：\n` +
    o.nearMisses.map((n) => `    line ${n.line}: ${n.snippet}`).join('\n') +
    `\n  请用 read_file 确认实际内容后，以新的 oldText（可带 context）重试。`
  )
}

/** Edit a file by replacing exact text — first occurrence by default, all
 *  occurrences when replaceAll is true (split/join, never a regex, so the
 *  replacement text can't be misinterpreted as a pattern). `context` (text
 *  immediately following oldText) disambiguates when oldText appears several
 *  times; on a miss the error reports the closest lines instead of leaving
 *  the model to re-read the whole file. */
export async function editFile(path: string, oldText: string, newText: string, replaceAll = false, context?: string): Promise<string> {
  if (!oldText) return 'Error: edit_file 的 oldText 不能为空'
  const { content } = await window.electronAPI.readFile(path)
  const replacement = adaptLineEnding(content, newText)
  const outcome = resolveMatch({ content, oldText, context: context || undefined, replaceAll })
  if (outcome.kind === 'ok') {
    const next = content.slice(0, outcome.index) + replacement + content.slice(outcome.index + outcome.length)
    await window.electronAPI.writeFile(path, next, 'utf-8')
    return `File edited: ${path}${outcome.fuzzy ? ' (fuzzy match: 空白/标点归一化后唯一命中)' : ''}`
  }
  if (outcome.kind === 'ok_all') {
    let out = ''
    let last = 0
    for (const c of outcome.occurrences) {
      out += content.slice(last, c.index) + replacement
      last = c.index + oldText.length
    }
    await window.electronAPI.writeFile(path, out + content.slice(last), 'utf-8')
    return `File edited: ${path} (all ${outcome.occurrences.length} occurrences)`
  }
  if (outcome.kind === 'ambiguous' && !outcome.contextMiss && !outcome.fuzzy && !context) {
    // Backward-compatible default: no context given + several matches → first hit.
    const first = outcome.candidates[0]
    const next = content.slice(0, first.index) + replacement + content.slice(first.index + oldText.length)
    await window.electronAPI.writeFile(path, next, 'utf-8')
    return `File edited: ${path} (first occurrence)`
  }
  if (outcome.kind === 'ambiguous') {
    return `Error: ${buildAmbiguousDetail(path, outcome, '')}`
  }
  return `Error: ${buildNotFoundDetail(path, outcome, '')}`
}

interface EditSpec {
  path?: string
  oldText?: string
  newText?: string
  replaceAll?: boolean
  /** Optional text immediately following oldText, used to disambiguate when
   *  oldText appears multiple times. */
  context?: string
}

/** Apply exact-text edits across multiple files in one call. Two-phase:
 *  1) read every target, then validate + apply each edit against in-memory
 *     buffers — edits to the same file validate against the result of the
 *     previous edits (sequential), edits to different files stay independent;
 *  2) only if ALL edits validate, persist every buffer to disk.
 *  A failing edit therefore writes nothing — no half-applied refactor. Failing
 *  edits are reported with their line numbers (and near-miss hints) so the
 *  model can self-heal without re-reading. A write error reports exactly how
 *  many files landed. */
export async function multiEditFile(edits: EditSpec[]): Promise<string> {
  const specs = (Array.isArray(edits) ? edits : [])
    .map((e) => ({
      path: String(e?.path || '').trim(),
      oldText: String(e?.oldText ?? ''),
      newText: String(e?.newText ?? ''),
      replaceAll: !!e?.replaceAll,
      context: e?.context ? String(e.context) : undefined,
    }))
    .filter((e) => e.path && e.oldText)
  if (specs.length === 0) return 'Error: multi_edit_file 需要非空的 edits 数组'

  // Phase 1 — read + resolve + buffer-apply everything before touching disk
  const contents = new Map<string, string>()
  const failures: string[] = []
  let fuzzyCount = 0
  for (const e of specs) {
    if (!contents.has(e.path)) {
      try {
        const { content } = await window.electronAPI.readFile(e.path)
        contents.set(e.path, content)
      } catch (error: any) {
        failures.push(`- ${e.path}: 无法读取文件 (${error?.message || String(error)})`)
        continue
      }
    }
    const content = contents.get(e.path)!
    const outcome = resolveMatch({ content, oldText: e.oldText, context: e.context, replaceAll: e.replaceAll })
    const replacement = adaptLineEnding(content, e.newText)
    if (outcome.kind === 'ok') {
      contents.set(e.path, content.slice(0, outcome.index) + replacement + content.slice(outcome.index + outcome.length))
      if (outcome.fuzzy) fuzzyCount += 1
    } else if (outcome.kind === 'ok_all') {
      let out = ''
      let last = 0
      for (const c of outcome.occurrences) {
        out += content.slice(last, c.index) + replacement
        last = c.index + e.oldText.length
      }
      contents.set(e.path, out + content.slice(last))
    } else if (outcome.kind === 'ambiguous') {
      failures.push(buildAmbiguousDetail(e.path, outcome))
    } else {
      failures.push(buildNotFoundDetail(e.path, outcome))
    }
  }
  if (failures.length > 0) {
    return `Error: multi_edit_file 校验失败，未写入任何文件（${failures.length} 处不匹配）：\n${failures.join('\n')}`
  }

  // Phase 2 — persist the validated buffers
  const written: string[] = []
  for (const [path, content] of contents) {
    try {
      await window.electronAPI.writeFile(path, content, 'utf-8')
      written.push(path)
    } catch (error: any) {
      return `Error: multi_edit_file 写入 ${path} 失败 (${error?.message || String(error)})；已完成 ${written.length}/${contents.size} 个文件，其余未写入。`
    }
  }
  const fuzzyNote = fuzzyCount > 0 ? `；其中 ${fuzzyCount} 处为模糊匹配（空白/标点归一化后唯一命中）` : ''
  return `已批量编辑 ${specs.length} 处（${contents.size} 个文件）${fuzzyNote}。`
}

/** Create a directory */
export async function createDirectory(path: string): Promise<string> {
  await window.electronAPI.createDir(path)
  return `Directory created: ${path}`
}

/** Delete a file or directory */
export async function deleteFileOrDir(path: string): Promise<string> {
  await window.electronAPI.delete(path)
  return `Deleted: ${path}`
}

/** Run a shell command. timeoutMs 可选（默认主进程 30s）——构建/测试等长命令
 *  传更大值（如 120000），避免被默认超时中断后误判成命令失败。 */
export async function runCommand(command: string, cwd?: string, timeoutMs?: number): Promise<string> {
  const rootPath = workspaceRoot()
  const workDir = cwd || rootPath
  const result = await window.electronAPI.shellExec(command, workDir, { timeoutMs })
  if (result.success) {
    return result.output
  }
  return `Error: ${result.error}${result.output ? '\n' + result.output : ''}`
}

/**
 * 后台命令：在集成终端的 pty 层里启动，工具立即返回 terminalId。
 *
 * 前台 run_command 会等进程退出、并在超时后把它杀掉——dev server、watch、需要
 * 交互输入的 Installer 必须走这里。进程由主进程持有，终端标签关掉也不影响它。
 */
export async function runCommandBackground(command: string, cwd?: string): Promise<string> {
  const workDir = cwd || workspaceRoot()
  try {
    const run = await startAgentRun(command, workDir || undefined)
    return (
      `已在集成终端后台启动：${command}\n` +
      `terminalId = ${run.id}\n` +
      '进程仍在运行——用 read_terminal_output 读取输出，用 stop_terminal 结束它。'
    )
  } catch (error) {
    return `Error: 后台命令启动失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 读取某个后台终端会话最近的输出（不传 id 时取最近启动的那个）。 */
export async function readTerminalOutput(terminalId?: string, maxLines = 200): Promise<string> {
  const wanted = String(terminalId ?? '').trim()
  const id = wanted || (await latestAgentRun())?.id
  if (!id) return 'Error: 没有后台终端会话。先用 run_command 的 background=true 启动一个。'
  const snapshot = await readAgentRun(id, DEFAULT_TAIL_CHARS)
  if (!snapshot) {
    const known = (await listAgentRuns()).map((run) => run.id)
    return `Error: 找不到终端会话 ${id}（进程可能已被回收，或 id 写错）。当前后台会话：${known.join('、') || '(无)'}`
  }
  return formatRunOutput({ id, command: snapshot.command }, snapshot, { maxLines })
}

/** 结束一个后台终端会话——只限助手自己启动的，用户手动开的终端不受影响。 */
export async function stopTerminal(terminalId?: string): Promise<string> {
  const id = String(terminalId ?? '').trim() || (await latestAgentRun())?.id
  if (!id) return 'Error: 没有可结束的后台终端会话。'
  const killed = await stopAgentRun(id)
  if (!killed) {
    return `Error: ${id} 不是由助手启动的终端会话，无法停止（用户自己打开的终端不受本工具影响）。`
  }
  return `已结束后台终端会话 ${id}`
}

/**
 * Run a git command in the given repo root (defaults to the workspace root).
 * 走主进程 git:exec：已带路径白名单校验 + 15s 超时 + 5MB 上限。cwd 优先用
 * agent 会话的项目根（context.projectPath），与 agent 视角一致——浏览侧
 * workspaceRoot() 只是兜底。
 */
export async function runGit(args: string[], cwd?: string): Promise<string> {
  const workDir = cwd || workspaceRoot()
  if (!workDir) return 'Error: 未打开项目，无法执行 git 命令'
  const result = await window.electronAPI.gitExec(workDir, args)
  if (result.success) {
    return result.output || '(无输出)'
  }
  return `Error: ${result.error || 'git 命令失败'}`
}

/** Web search via DuckDuckGo HTML (no API key required) */
export async function webSearch(query: string): Promise<string> {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
  const res = await window.electronAPI.webFetch(url, { timeoutMs: 20000 })
  if (!res.ok || !res.text) {
    return `Web search failed: ${res.error || `HTTP ${res.status}`}`
  }
  const blocks = res.text.split(/<div[^>]*class="[^"]*result[^"]*"/i)
  const results: string[] = []
  for (const block of blocks.slice(1, 9)) {
    const hrefMatch = /href="([^"]+)"/.exec(block)
    const titleMatch = /class="result__a"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    const href = hrefMatch ? stripHtml(decodeEntities(hrefMatch[1])) : ''
    const title = titleMatch ? stripHtml(titleMatch[1]) : ''
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : ''
    if (title) {
      results.push(`- ${title}${href ? `\n  URL: ${href}` : ''}${snippet ? `\n  ${snippet}` : ''}`)
    }
  }
  return results.length > 0
    ? `Web search results for "${query}":\n${results.join('\n')}`
    : `No results found for "${query}"`
}

/** Fetch a URL and return its readable text content. With an optional `prompt`
 *  the page is answered by an LLM instead (bounded input/output); on any
 *  failure — no API config, no default model, empty or errored answer — it
 *  degrades to the raw text, so read_url never breaks on a missing key.
 *  `sessionId` 用于把配置组/模型解析到「发起调用的那个会话」——用全局活动组
 *  会把会话组 B 的模型名发到活动组 A 的端点 → 400 "Unsupported model"。 */
export async function readUrl(url: string, prompt?: string, sessionId?: string): Promise<string> {
  const res = await window.electronAPI.webFetch(url, { timeoutMs: 20000, maxBytes: 2 * 1024 * 1024 })
  if (!res.ok || !res.text) {
    return `Failed to fetch ${url}: ${res.error || `HTTP ${res.status}`}`
  }
  const text = stripHtml(res.text)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!prompt) {
    return `Content of ${url}:\n\n${text.slice(0, 8000)}`
  }
  return extractWithLLM(url, prompt, text, sessionId)
}

/** LLM extraction for read_url with a prompt — same non-streaming pattern as
 *  memory condensation. Pure client-side call: it cannot re-enter the agent
 *  loop, so there is no recursion risk. */
async function extractWithLLM(url: string, prompt: string, pageText: string, sessionId?: string): Promise<string> {
  // No page text — nothing to extract from; skip the LLM call entirely rather
  // than risk a hallucinated answer from an empty source.
  if (!pageText.trim()) {
    return `Content of ${url}:\n\n${pageText}`
  }
  const { sendLLMRequest } = await import('@/services/llm/LLMClient')
  const { useConfigStore } = await import('@/stores/configStore')
  // 组与模型同一来源：有会话时取会话绑定的配置组与其模型（tools 调用必然
  // 属于某个 agent/子智能体循环）；无会话上下文时才回退到全局活动组。
  let group = useConfigStore.getState().getActiveConfigGroup()
  let model = (group?.defaultModel || '').trim()
  if (sessionId) {
    const { useChatStore } = await import('@/stores/chatStore')
    const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
    const own = useConfigStore.getState().getConfigGroupFor(session?.configGroupId)
    if (own) {
      group = own
      model = (session?.model || own.defaultModel || '').trim()
    }
  }
  if (!group || !model) {
    return `Content of ${url}:\n\n${pageText.slice(0, 8000)}`
  }

  const INPUT_MAX = 15 * 1024
  const system =
    '你是网页内容提取助手。只根据提供的网页原文回答用户的具体问题，不要编造原文中没有的信息；' +
    '原文中找不到答案时如实说明。用中文回答，保持简洁。'
  let extracted = ''
  try {
    for await (const chunk of sendLLMRequest(
      {
        model,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `网页 URL: ${url}\n问题: ${prompt}\n\n网页原文（前 ${INPUT_MAX} 字符）:\n${pageText.slice(0, INPUT_MAX)}`,
          },
        ],
        stream: false,
        temperature: 0,
        maxTokens: 600,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
      },
      group,
      60_000,
    )) {
      if (chunk.content) extracted += chunk.content
      if (chunk.done) break
    }
  } catch {
    // fall through to the raw-text fallback below
  }
  const answer = extracted.trim()
  if (!answer) {
    return `Content of ${url}:\n\n${pageText.slice(0, 8000)}`
  }
  return `回答（由 AI 从 ${url} 提取）:\n\n${answer}`
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// ── 浏览器会话（对标 Cursor 的 integrated browser）────────────────────────────
// 主进程持有一个隐藏 http(s) 页面，助手通过这四个工具完成「改完代码 → 打开页面
// → 看控制台/截图 → 再改」的闭环。终端只能证明进程活着，证明不了页面渲染对了。

/** 打开（或跳转）页面并回读关键信息——省掉一次「navigate 后再读控制台」的往返。 */
export async function browserNavigateTool(url: string): Promise<string> {
  const res = await window.electronAPI.browserNavigate(String(url ?? ''))
  const s = res.state
  const head = `URL: ${s.url || '(未知)'}\n标题: ${s.title || '(无)'}${s.loading ? '\n（加载超时，可能仍在加载）' : ''}`
  if (!res.ok) return `Error: ${res.error || '导航失败'}\n${head}`
  return `${head}\n下一步用 browser_read_console 看有没有报错，必要时 browser_screenshot 看图。`
}

/** 控制台/页面错误。默认只读不清空——反复轮询不该把错误记录抹掉。 */
export async function browserReadConsoleTool(opts: { clear?: boolean; includePageText?: boolean } = {}): Promise<string> {
  const dump = await window.electronAPI.browserConsole(opts.clear === true)
  const parts = [dump.entries.length ? dump.text : '(控制台无输出)']
  if (opts.includePageText) {
    const page = await window.electronAPI.browserPageText()
    parts.push(page.ok ? `页面可见文本:\n${page.text}` : `读取页面文本失败：${page.error}`)
  }
  return parts.join('\n')
}

/** 截图——图片走 ToolImageResult，由 chatStore 作为紧随其后的 user 图片消息交给模型。 */
export async function browserScreenshotTool(): Promise<string | ToolImageResult> {
  const res = await window.electronAPI.browserScreenshot()
  if (!res.ok || !res.dataUrl) return `Error: ${res.error || '截图失败'}`
  const image = parseImageDataUrl(res.dataUrl, res.mimeType || 'image/png')
  return {
    text: `已截取当前页面（${res.url || '未知地址'}），图片随本结果附上。`,
    images: [image],
  }
}

/** 页面交互：点击 / 输入 / 按键 / 滚动 / 等待。 */
export async function browserActTool(
  action: string,
  opts: { selector?: string; text?: string; key?: string; ms?: number } = {},
): Promise<string> {
  const allowed = ['click', 'type', 'press', 'scroll', 'wait']
  if (!allowed.includes(action)) return `Error: 不支持的 action：${action}（可用：${allowed.join('、')}）`
  if ((action === 'click' || action === 'type') && !String(opts.selector ?? '').trim()) {
    return `Error: ${action} 需要 selector`
  }
  const res = await window.electronAPI.browserAct(action as never, opts)
  if (!res.ok) return `Error: ${res.error || '操作失败'}`
  const loaded = res.state.loading ? '（页面仍在加载，稍后用 browser_read_console 确认结果）' : ''
  return `${res.detail || '已执行'}\nURL: ${res.state.url}${loaded}`
}

// ── GitHub PR（gh CLI）───────────────────────────────────────────────────────

/** One tool for the whole PR lifecycle, action-switched — the model needs the
 *  verbs, not five tool slots. */
export async function githubPrTool(
  action: string,
  args: { number?: number; title?: string; body?: string; base?: string; draft?: boolean; comment?: string },
): Promise<string> {
  const availability = await fetchGhAvailability()
  if (!availability.installed) {
    return 'Error: 未安装 GitHub CLI（gh）。PR 功能依赖本机的 gh，安装后重试；不要用 run_command 猜其它命令。'
  }
  if (!availability.authed) {
    return 'Error: gh 未登录。请让用户在终端执行 gh auth login（交互式，助手无法代做）。'
  }
  switch (action) {
    case 'list': {
      const list = await listPullRequests(15)
      if (!list.ok) return `Error: ${list.error}`
      if (!list.data.length) return '该仓库没有打开中的 PR'
      return list.data
        .map((pr) => `#${pr.number} [${pr.isDraft ? 'draft' : pr.state}] ${pr.title} (${pr.headRefName} → ${pr.baseRefName}) ${pr.url}`)
        .join('\n')
    }
    case 'view': {
      const viewed = await viewPullRequest(args.number)
      if (!viewed.ok) return viewed.notFound ? `当前分支没有 PR。可用 create 建一个（先用 git_push 推送分支）。` : `Error: ${viewed.error}`
      return formatPullRequestForModel(viewed.data)
    }
    case 'create': {
      if (!String(args.title ?? '').trim()) return 'Error: create 需要 title'
      // Upstream state is only a hint: `git push origin x` (no -u) leaves no
      // upstream while the branch IS on the remote, and gh would then be
      // refused a create it could have done. gh's own error is the authority.
      const push = await branchPushState()
      const pushHint = push.hasUpstream
        ? (push.ahead > 0 ? `（提醒：${push.branch} 还有 ${push.ahead} 个提交未推送）` : '')
        : `（提醒：${push.branch} 没有跟踪上游，若远端没有该分支需先 git_push）`
      let body = String(args.body ?? '').trim()
      if (!body) {
        // Same default the panel uses: the branch's own commit subjects, so a
        // model that skips writing a description still opens a reviewable PR.
        const subjects = await runGit(['log', '-8', '--format=%s'])
        const stat = await runGit(['diff', 'HEAD', '--stat'])
        body = buildPrBody(subjects.split('\n').filter(Boolean), stat.startsWith('Error') ? '' : stat)
      }
      const created = await createPullRequest({
        title: args.title!.trim(),
        body,
        base: args.base,
        draft: args.draft === true,
      })
      return created.ok ? `PR 已创建：${created.data.url}${pushHint}` : `Error: ${created.error}${pushHint}`
    }
    case 'comment': {
      if (!args.number) return 'Error: comment 需要 number'
      const comment = String(args.comment ?? '').trim()
      if (!comment) return 'Error: comment 需要 comment 文本'
      const res = await commentPullRequest(args.number, comment)
      return res.ok ? `已在 PR #${args.number} 发表评论` : `Error: ${res.error}`
    }
    default:
      return `Error: 不支持的 action：${action}（可用：list、view、create、comment）`
  }
}
