/**
 * Tool system types for Agent Loop
 */

/** A tool that the LLM can call */
export interface Tool {
  name: string
  description: string
  parameters: Record<string, any> // JSON Schema format
  execute: (args: Record<string, any>, context?: ToolExecutionContext) => Promise<string | ToolImageResult>
  requiresApproval?: boolean // Write operations need user confirmation
  /** Wall-clock budget for one call (ms). When set, the executor runs the tool
   *  with a deadline AbortSignal (cooperative abort) plus a hard race fallback,
   *  so a hung tool returns a structured TOOL_TIMEOUT error instead of stalling
   *  the whole agent loop. Tools with their own timeout (run_command, MCP) stay
   *  unset — wrapping them would double-timeout. */
  timeoutMs?: number
}

/** Runtime context passed to tools (used by run_subagent for usage attribution) */
export interface ToolExecutionContext {
  sessionId?: string
  projectPath?: string
  /** The id of the tool call being executed — run_subagent routes its live
   *  progress to the UI keyed by this id (SubAgentProgressBlock). */
  toolCallId?: string
  /** Abort signal of the enclosing agent run — lets the user's Stop button
   *  cancel long-running tools like run_subagent. */
  abortSignal?: AbortSignal
}

/** A tool call from the LLM */
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

/** An image a tool wants the model to actually look at (a browser screenshot).
 *  Text alone cannot convey "the layout is broken", and every vision adapter
 *  already accepts image parts, so this is the one escape hatch from strings. */
export interface ToolImageResult {
  text: string
  images: Array<{ mimeType: string; dataBase64: string }>
}

/** Result of executing a tool */
export interface ToolResult {
  toolCallId: string
  name: string
  result: string
  isError?: boolean
  /** True when the call was DENIED by the user (approval) rather than failed —
   *  the trace shows 'rejected' instead of 'error'. */
  rejected?: boolean
  /** Set from a ToolImageResult. chatStore strips it before the result is
   *  persisted (base64 screenshots in every chat message would bloat SQLite and
   *  be re-read on every session load) and flushes it to the model as one user
   *  message at the END of the tool batch — a tool_call_id must be answered
   *  before any other role appears. */
  images?: Array<{ mimeType: string; dataBase64: string }>
}

/** Tool definition sent to LLM (OpenAI format) */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

/** Raw tool call from LLM response */
export interface LLMToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
}
