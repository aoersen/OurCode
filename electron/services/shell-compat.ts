/**
 * Shell compatibility for `shell:exec` (the run_command tool).
 *
 * The main process runs agent commands through Windows PowerShell 5.1, whose
 * dialect differs from the bash syntax models habitually produce:
 *  - `&&` / `||` are PowerShell 7+ operators; 5.1 rejects them with a
 *    ParserError, and the error arrives as GBK bytes that used to decode into
 *    U+FFFD mojibake — the model could not read it, retried the same command
 *    verbatim, and burned rounds until the failure circuit-breaker killed the
 *    whole task (the 2026-09-29 office-run incident: 3 workers, 8 distinct
 *    failed calls, all `cd X && npm run ...`).
 *  - Console output on Chinese Windows is GBK (cp936), not UTF-8.
 *
 * These two helpers address both: rewrite the operators before execution
 * (Windows only — the caller gates it; bash on macOS/Linux already supports
 * them and rewriting there would change short-circuit semantics) and decode
 * output bytes with a UTF-8-first / GBK-fallback heuristic.
 */
import * as iconv from 'iconv-lite'

/**
 * Decode child-process output bytes. UTF-8 is tried first (correct for most
 * tools); only when that produced replacement characters (invalid UTF-8, i.e.
 * a GBK stream) do we re-decode as GBK.
 */
export function decodeShellOutput(buf: string | Buffer): string {
  if (typeof buf === 'string') return buf
  if (buf.length === 0) return ''
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return iconv.decode(buf, 'gbk')
  } catch {
    return utf8
  }
}

/**
 * Classify a failed shell:exec into one of the marker-prefixed messages the
 * renderer breaker recognizes. Only the first four mean "the command never ran
 * to completion through no fault of its content" and count toward the
 * consecutive-failure circuit breaker; `[命令报错]` means the command executed
 * and reported a non-zero exit (typecheck/test red, git errors) — a
 * verification signal, not a stuck signal.
 */
export function classifyShellFailure(opts: {
  stoppedByUser: boolean
  timedOut: boolean
  spawnFailed: boolean
  errText: string
  errorMessage: string
  timeoutMs: number
}): string {
  const { stoppedByUser, timedOut, spawnFailed, errText, errorMessage, timeoutMs } = opts
  if (stoppedByUser) {
    return '[已终止] 用户停止了任务，这条命令及其子进程已被结束。不要重试它；如需要可先向用户确认。'
  }
  if (timedOut) {
    return `[超时] 命令执行超过 ${Math.round(timeoutMs / 1000)} 秒被终止。若是构建/测试/安装等长命令，请在 run_command 的 timeoutMs 参数中加大超时（如 120000），或改用异步方式等待，不要重复执行同一命令。`
  }
  if (/ParserError|InvalidEndOfLine|无效的语句分隔符/.test(errText)) {
    return `[语法错误] 命令被 PowerShell 解析器拒绝、没有执行（本机是 PowerShell 5.1，语法与 bash 不同）。请改用 ; 串联或分多次调用：${errText}`
  }
  if (spawnFailed) {
    return `[无法执行] 找不到命令或解释器，请检查拼写或是否已安装：${errorMessage}`
  }
  return `[命令报错] ${errText || errorMessage}`
}

/**
 * Rewrite top-level `&&` / `||` to `;` for Windows PowerShell 5.1, which
 * rejects those operators with a ParserError (they exist only in PowerShell
 * 7+). The caller prepends the returned note to the output so the model learns
 * the dialect instead of retrying. Single `&` (background) and `|` (pipe,
 * valid in PowerShell) are preserved, as is `2>&1` (its `&` is followed by a
 * digit, not another `&`). Quoted spans are copied verbatim.
 */
export function rewriteBashSeparators(command: string): { command: string; note?: string } {
  let rewritten = false
  let i = 0
  const n = command.length
  let out = ''
  while (i < n) {
    const ch = command[i]
    if (ch === '"' || ch === "'") {
      // Copy quoted spans verbatim (PowerShell also allows doubling the quote
      // inside a single-quoted string, so the span ends at the closing quote).
      const start = i
      i++
      while (i < n && command[i] !== ch) i++
      i++
      out += command.slice(start, i)
      continue
    }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      out += ';'
      rewritten = true
      i += 2
      continue
    }
    out += ch
    i++
  }
  return rewritten
    ? { command: out, note: '[shell 兼容] 命令中的 && / || 已替换为 ; 顺序执行（Windows PowerShell 5.1 不支持这两个符号，不保证短路语义）。' }
    : { command }
}
