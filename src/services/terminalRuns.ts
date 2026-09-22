import type { AgentTerminalRun, TerminalRunSnapshot } from '@shared/types'

/**
 * Commands the assistant starts in the integrated terminal's pty layer.
 *
 * A foreground `run_command` waits for the process to exit and is killed at its
 * timeout — right for `git status`, wrong for a dev server, a watcher or an
 * installer that asks a question. Those go through `term:runAgent`, which starts
 * a real pty in the main process: it keeps running after the tool call returns,
 * its output is captured there (so the model can poll it even when no terminal
 * tab is showing it), and `TerminalPanel` attaches a view to it on demand.
 *
 * The main process owns the list — these helpers only read it and announce
 * changes, so a window reload still finds the processes that are running.
 */

/** Output tail the model gets when it doesn't ask for a specific size. */
export const DEFAULT_TAIL_CHARS = 8000

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function listAgentRuns(): Promise<AgentTerminalRun[]> {
  return window.electronAPI.termList()
}

/** The most recently started run, or null when the assistant has none. */
export async function latestAgentRun(): Promise<AgentTerminalRun | null> {
  const runs = await listAgentRuns()
  return runs[runs.length - 1] ?? null
}

/** Subscribe to start/stop of agent runs (the terminal panel renders a tab per run). */
export function onAgentRunsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Start a background run. Throws when the main process refuses (bad path, …). */
export async function startAgentRun(command: string, cwd?: string): Promise<{ id: string; command: string }> {
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await window.electronAPI.termRunAgent(id, command, cwd)
  emit()
  return { id, command }
}

export async function readAgentRun(id: string, tailChars?: number): Promise<TerminalRunSnapshot | null> {
  return window.electronAPI.termOutput(id, tailChars)
}

/** Kill a run. Its tab stays — the view shows the exit banner and the output. */
export async function stopAgentRun(id: string): Promise<boolean> {
  const killed = await window.electronAPI.termKill(id)
  emit()
  return killed
}

// ── pty stream → text the model can read ───────────────────────────────────

/** CSI / OSC / two-char escape sequences. Terminal control codes carry no
 *  meaning for a language model, and cursor addressing would otherwise show up
 *  as punctuation inside the output. */
const ANSI_RE = new RegExp(
  [
    '\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)', // OSC … BEL | ST
    '\\u001b\\[[0-9:;<=>?]*[ -/]*[@-~]', // CSI … final byte
    '\\u001b[@-Z\\\\-_]', // two-character escapes
  ].join('|'),
  'g'
)

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/** Drop C0 control characters (tab and line breaks survive). They arrive with
 *  terminal graphics — beep, bell, incomplete escapes — and mean nothing to a
 *  language model reading the output. */
function dropControlChars(text: string): string {
  let out = ''
  for (const char of text) {
    if (char === '\n' || char === '\t') out += char
    else if ((char.codePointAt(0) ?? 0) >= 0x20) out += char
  }
  return out
}

/**
 * Collapse a raw pty stream into readable lines.
 *
 * A terminal emulates progress bars by rewriting the current line with `\r`;
 * what a user sees is the text after the last `\r` of each line, so that is what
 * a model should read too.
 */
export function flattenPtyOutput(text: string): string {
  // Normalize the line terminator first: pty rows end with `\r\n`, so without
  // this every line would collapse to "text after the last \r" = empty.
  const lines = stripAnsi(text).replace(/\r\n/g, '\n').split('\n')
  const flattened = lines
    .map((line) => {
      const cursor = line.lastIndexOf('\r')
      if (cursor === -1) return line
      // A trailing bare \r means the cursor went home but nothing overwrote the
      // row yet — what is already printed is still on screen.
      return line.slice(cursor + 1) || line.slice(0, cursor)
    })
    .join('\n')
  return dropControlChars(flattened)
}

/** Tail of `lines`, at most `maxLines`, cut on a line boundary. */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (maxLines <= 0 || lines.length <= maxLines) return text
  return lines.slice(lines.length - maxLines).join('\n')
}

/** Render one `read_terminal_output` result. */
export function formatRunOutput(
  run: Pick<AgentTerminalRun, 'id' | 'command'>,
  snapshot: TerminalRunSnapshot,
  options: { maxLines: number }
): string {
  const header = snapshot.running
    ? `终端 ${run.id} 仍在运行（命令：${run.command}）`
    : `终端 ${run.id} 已退出，exit code = ${snapshot.exitCode}`
  const body = tailLines(flattenPtyOutput(snapshot.output), options.maxLines)
  const trimmed = body.trim()
  return `${header}${snapshot.truncated ? '（更早的输出已超出缓冲，被丢弃）' : ''}\n${
    trimmed || '(暂无输出)'
  }${snapshot.running ? '\n\n用 stop_terminal 结束它；需要继续等待时再调用本工具。' : ''}`
}
