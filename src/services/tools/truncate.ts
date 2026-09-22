/**
 * Unified tool-output truncation — a safety net for tool results that have no
 * upper bound of their own (MCP results, run_command output, skill content).
 *
 * Built-in tools already self-cap BELOW these defaults (read_file 2000 lines /
 * 50KB, git_diff 120KB, readUrl 8KB), so the defaults change nothing for
 * existing paths — only the currently unbounded ones get capped. When capped,
 * the result keeps a head + tail preview and points the model at read_file's
 * startLine/endLine paging so it can fetch the middle on demand.
 */

export interface ToolOutputLimits {
  maxChars?: number
  maxLines?: number
}

// Must stay above the highest built-in tool cap (git_diff 120KB) so the
// default is a pure safety net and never alters existing tool behavior.
export const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 150_000
export const DEFAULT_TOOL_OUTPUT_MAX_LINES = 3000

/** Fraction of the budget given to the head preview (the rest goes to the tail). */
const HEAD_FRACTION = 0.6

/**
 * Cut the head/tail without splitting a surrogate pair.
 *
 * Emoji and CJK-extension characters are two UTF-16 units; a budget-aligned
 * `slice` can end on the high surrogate and leave a lone half behind, which
 * serializes to U+FFFD — visible corruption in the middle of a tool result.
 */
function headSlice(text: string, n: number): string {
  if (n >= text.length) return text
  const last = text.charCodeAt(n - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, n - 1) : text.slice(0, n)
}

function tailSlice(text: string, n: number): string {
  const from = text.length - n
  if (from <= 0) return text
  const first = text.charCodeAt(from)
  return text.slice(first >= 0xdc00 && first <= 0xdfff ? from + 1 : from)
}

/** True when the output exceeds the inline budget and should be spilled to
 *  disk (full text saved; preview + locator returned) instead of truncated. */
export function shouldSpill(text: string, limits?: ToolOutputLimits): boolean {
  return text.length > (limits?.maxChars ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS)
}

/** Build the inline preview for a spilled output: a bounded head plus a notice
 *  carrying the locator, so the model can read the full text back with
 *  read_file (the locator lives under userData, which is in the allowlist). */
export function buildSpillPreview(text: string, locator: string, limits?: ToolOutputLimits): string {
  const maxChars = limits?.maxChars ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS
  const headChars = Math.floor(maxChars * HEAD_FRACTION)
  const head = headSlice(text, headChars)
  const lines = countLines(text)
  return `${head}\n${buildSpillNotice(text.length, lines, locator)}`
}

function buildSpillNotice(chars: number, lines: number, locator: string): string {
  return `[…输出过大（共 ${chars} 字符 / ${lines} 行），完整内容已保存到:\n${locator}\n可用 read_file 读取该路径分页查看完整输出。]`
}

export function truncateToolOutput(text: string, limits?: ToolOutputLimits): string {
  const maxChars = limits?.maxChars ?? DEFAULT_TOOL_OUTPUT_MAX_CHARS
  const maxLines = limits?.maxLines ?? DEFAULT_TOOL_OUTPUT_MAX_LINES

  if (text.length > maxChars) {
    const headChars = Math.floor(maxChars * HEAD_FRACTION)
    const tailChars = maxChars - headChars
    const head = headSlice(text, headChars)
    const tail = tailSlice(text, tailChars)
    const lines = countLines(text)
    return `${head}\n${buildNotice(text.length, lines)}\n${tail}`
  }

  // Line check only when the text is big enough to plausibly exceed it
  // (N lines need ≥ N chars, so a short text can't be over the line cap).
  if (maxLines > 0 && text.length >= maxLines) {
    const lines = countLines(text)
    if (lines > maxLines) {
      const headLines = Math.max(1, Math.floor(maxLines * HEAD_FRACTION))
      const tailLines = maxLines - headLines
      const split = text.split('\n')
      const head = split.slice(0, headLines).join('\n')
      const tail = split.slice(split.length - tailLines).join('\n')
      return `${head}\n${buildNotice(text.length, lines)}\n${tail}`
    }
  }

  return text
}

function countLines(text: string): number {
  // '\n' count + 1 — cheap enough at the sizes we care about.
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) count++
  }
  return count
}

function buildNotice(chars: number, lines: number): string {
  return `[…输出过长（共 ${chars} 字符 / ${lines} 行），已省略中间部分。需要完整内容可调用 read_file（startLine/endLine 分页读取）或 grep 定向检索。]`
}
