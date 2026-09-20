/**
 * Tool Registry - defines all tools available to the LLM
 */
import { Tool, ToolDefinition } from './types'
import type { SubAgentOptions } from '@/services/subagents/subagentRunner'

export function createToolRegistry(): Tool[] {
  return [
    // ──────────────── Read-only tools ────────────────
    {
      name: 'read_file',
      description: 'Read the contents of a file. Returns the file content with line numbers. Max 2000 lines, 50KB.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          startLine: { type: 'number', description: 'Start line number (1-based, optional)' },
          endLine: { type: 'number', description: 'End line number (1-based, optional)' },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const { readFile } = await import('@/services/tools/helpers')
        return readFile(args.path, args.startLine, args.endLine)
      },
      timeoutMs: 60_000,
    },
    {
      name: 'read_multiple_files',
      description:
        'Read several files at once, returning each one in a "===== path =====" section. ' +
        'Each file is capped independently at 2000 lines / 50KB and the combined output is ' +
        'capped too, so prefer this over repeated read_file calls when you need multiple ' +
        'small files (configs, related sources) in one round-trip.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            description: 'Absolute paths of the files to read',
            items: { type: 'string' },
          },
        },
        required: ['paths'],
      },
      execute: async (args) => {
        const { readMultipleFiles } = await import('@/services/tools/helpers')
        return readMultipleFiles(Array.isArray(args.paths) ? args.paths.map(String) : [])
      },
      timeoutMs: 60_000,
    },
    {
      name: 'list_directory',
      description: 'List files and directories in a given path. Shows file sizes and types.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the directory' },
          maxDepth: { type: 'number', description: 'Max recursion depth (default 1, max 5)' },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const { listDirectory } = await import('@/services/tools/helpers')
        return listDirectory(args.path, args.maxDepth ?? 1)
      },
    },
    {
      name: 'get_directory_tree',
      description: 'Get a tree view of the project directory structure. Useful for understanding project layout.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the root directory' },
          maxDepth: { type: 'number', description: 'Max depth (default 3)' },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const { getDirectoryTree } = await import('@/services/tools/helpers')
        return getDirectoryTree(args.path, args.maxDepth ?? 3)
      },
    },
    {
      name: 'search_files',
      description:
        'Search for files by name. Returns matching file paths. ' +
        'To enumerate the files inside a directory, use list_directory (search_files finds files by name, it does not list a directory). ' +
        'If it returns "No files found" twice for a path you know exists, switch to list_directory.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search in' },
          pattern: { type: 'string', description: 'File name to match: a glob (e.g. "*.ts", "test*.tsx") or a literal name fragment (e.g. "responseCache"). Case-insensitive.' },
        },
        required: ['path', 'pattern'],
      },
      execute: async (args) => {
        const { searchFiles } = await import('@/services/tools/helpers')
        return searchFiles(args.path, args.pattern)
      },
    },
    {
      name: 'search_in_files',
      description:
        'Search for text content within files. Returns matching lines with file paths and line numbers. ' +
        'query 默认按字面文本（大小写不敏感）搜索；搜索带括号/点号等特殊字符的模式时，' +
        '要么不转义直接传原文，要么设置 regex=true 并按正则转义后传入。' +
        'path 可以是目录，也可以是单个文件路径；要缩小范围请用 filePattern（如 "*.ts,*.tsx"），不要传文件路径来当目录。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to search in, or a single file path' },
          query: { type: 'string', description: 'Text to search for (literal substring by default)' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression instead of literal text (default false)' },
          filePattern: { type: 'string', description: 'Optional file pattern filter (e.g. "*.ts,*.tsx")' },
        },
        required: ['path', 'query'],
      },
      execute: async (args) => {
        const { searchInFiles } = await import('@/services/tools/helpers')
        return searchInFiles(args.path, args.query, args.filePattern, !!args.regex)
      },
    },

    // ──────────────── Write tools (require approval) ────────────────
    {
      name: 'write_file',
      description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
      execute: async (args) => {
        const { writeFile } = await import('@/services/tools/helpers')
        return writeFile(args.path, args.content)
      },
      requiresApproval: true,
    },
    {
      name: 'edit_file',
      description:
        'Edit a file by replacing a specific string with new content. The oldText must match exactly ' +
        '(replace the first occurrence by default; set replaceAll=true to replace every occurrence). ' +
        'If oldText appears multiple times, pass context (the text immediately following oldText) to ' +
        'pick the right occurrence. For edits touching several files in one round-trip, prefer multi_edit_file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file' },
          oldText: { type: 'string', description: 'Exact text to find and replace' },
          newText: { type: 'string', description: 'Replacement text' },
          replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldText instead of only the first (default false)' },
          context: { type: 'string', description: 'Optional text immediately following oldText, used to disambiguate when oldText appears multiple times' },
        },
        required: ['path', 'oldText', 'newText'],
      },
      execute: async (args) => {
        const { editFile } = await import('@/services/tools/helpers')
        return editFile(args.path, args.oldText, args.newText, !!args.replaceAll, args.context)
      },
      requiresApproval: true,
    },
    {
      name: 'multi_edit_file',
      description:
        'Apply exact-text replacements across multiple files in one call. ' +
        'Each edit is { path, oldText, newText, replaceAll?, context? } — replaceAll replaces every ' +
        'occurrence; context (text immediately following oldText) disambiguates when oldText appears ' +
        'multiple times. Validation is all-or-nothing: every oldText must match exactly (or uniquely ' +
        'after whitespace/punctuation normalization), otherwise NOTHING is written and the failing ' +
        'edits are reported with their line numbers so you can fix and retry without re-reading. Use ' +
        'it for cross-file refactors instead of a long sequence of edit_file calls.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'Ordered list of edits to apply. Files may appear multiple times; edits to the same file apply sequentially.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute path to the file' },
                oldText: { type: 'string', description: 'Exact text to find and replace' },
                newText: { type: 'string', description: 'Replacement text' },
                replaceAll: { type: 'boolean', description: 'Replace every occurrence of oldText instead of only the first (default false)' },
                context: { type: 'string', description: 'Optional text immediately following oldText, used to disambiguate when oldText appears multiple times' },
              },
              required: ['path', 'oldText', 'newText'],
            },
          },
        },
        required: ['edits'],
      },
      execute: async (args) => {
        const { multiEditFile } = await import('@/services/tools/helpers')
        return multiEditFile(Array.isArray(args.edits) ? args.edits : [])
      },
      requiresApproval: true,
    },
    {
      name: 'create_directory',
      description: 'Create a new directory (and any necessary parent directories).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the directory to create' },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const { createDirectory } = await import('@/services/tools/helpers')
        return createDirectory(args.path)
      },
      requiresApproval: true,
    },
    {
      name: 'delete_file',
      description: 'Delete a file or directory. Use with caution!',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to delete' },
        },
        required: ['path'],
      },
      execute: async (args) => {
        const { deleteFileOrDir } = await import('@/services/tools/helpers')
        return deleteFileOrDir(args.path)
      },
      requiresApproval: true,
    },
    {
      name: 'run_command',
      description:
        'Execute a shell command in the given directory. Returns stdout/stderr. ' +
        '注意：① 有专用工具时不要用它——文件/搜索用 read_file/search_in_files，git 用 git_status/git_diff/git_log/git_add/git_commit/git_split_commit（本工具需要审批，会打断流程）；' +
        '② Windows 环境是 PowerShell（没有 grep/&& 等 Unix 命令），赋值用 $env:NAME=... 而不是 set NAME=...，需要搜索用 search_in_files，需要连续执行分多次调用；' +
        '③ 命令默认 30 秒超时会被中断——构建/测试/安装等长命令必须设置 timeoutMs（如 120000），若仍超时说明它确实需要更长时间，不要重复执行同一命令；' +
        '④ dev server / watch / 需要交互输入这类不会自己退出的命令，必须用 background=true（它在集成终端里跑，随后用 read_terminal_output 读、stop_terminal 停），' +
        '用前台调用只会被超时杀掉。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (optional, defaults to project root)' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (optional, default 30000; build/test commands should set e.g. 120000)' },
          background: {
            type: 'boolean',
            description:
              'Run it in the integrated terminal and return immediately with a terminalId instead of waiting for it to exit. ' +
              'Required for long-running/interactive processes: dev servers, watchers, `npm install` that may prompt.',
          },
        },
        required: ['command'],
      },
      execute: async (args) => {
        const { runCommand, runCommandBackground } = await import('@/services/tools/helpers')
        if (args.background) return runCommandBackground(args.command, args.cwd)
        return runCommand(args.command, args.cwd, args.timeoutMs)
      },
      requiresApproval: true,
    },
    {
      name: 'read_terminal_output',
      description:
        'Read the latest output of a process the assistant started with run_command(background=true). ' +
        'Use it for dev servers / watchers / long builds: start once, read, and if it is not ready yet wait before reading again — do not poll in a tight loop. ' +
        'The result says whether the process is still running and, once finished, its exit code.',
      parameters: {
        type: 'object',
        properties: {
          terminalId: { type: 'string', description: 'Session to read; defaults to the most recently started one' },
          maxLines: { type: 'number', description: 'Maximum trailing lines to return (default 200)' },
        },
        required: [],
      },
      execute: async (args) => {
        const { readTerminalOutput } = await import('@/services/tools/helpers')
        return readTerminalOutput(args.terminalId, args.maxLines)
      },
      requiresApproval: false,
    },
    {
      name: 'stop_terminal',
      description:
        'Stop a background terminal process started by the assistant (it cannot touch terminals the user opened). ' +
        'Call it when a dev server/watcher is no longer needed instead of leaving it running.',
      parameters: {
        type: 'object',
        properties: {
          terminalId: { type: 'string', description: 'Session to stop; defaults to the most recently started one' },
        },
        required: [],
      },
      execute: async (args) => {
        const { stopTerminal } = await import('@/services/tools/helpers')
        return stopTerminal(args.terminalId)
      },
      requiresApproval: false,
    },

    // ──────────────── Browser session (integrated-browser parity) ────────────────
    // What the terminal can't prove: that the page actually renders. These drive
    // the same hidden window the Browser panel shows the user.
    {
      name: 'browser_navigate',
      description:
        'Open a URL in the app\'s browser session (http/https only — localhost dev servers are the main use). ' +
        'Waits for the load and reports the final URL and title. Use it after changing frontend code, then ' +
        'browser_read_console to see whether it broke.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open, e.g. http://localhost:5173' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const { browserNavigateTool } = await import('@/services/tools/helpers')
        return browserNavigateTool(args.url)
      },
      timeoutMs: 45_000,
    },
    {
      name: 'browser_read_console',
      description:
        'Read console output and page errors captured from the browser session (newest last), optionally the ' +
        'visible page text too. This is how you see a runtime JS error or failed request after a frontend change.',
      parameters: {
        type: 'object',
        properties: {
          includePageText: { type: 'boolean', description: 'Also append the page\'s visible text' },
          clear: { type: 'boolean', description: 'Clear the buffer after reading (default false)' },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (args) => {
        const { browserReadConsoleTool } = await import('@/services/tools/helpers')
        return browserReadConsoleTool({ includePageText: args.includePageText, clear: args.clear })
      },
      timeoutMs: 30_000,
    },
    {
      name: 'browser_screenshot',
      description:
        'Screenshot the current page and attach the image to this result, so you can see layout/visual state. ' +
        'Needs a vision-capable model; the result says if the image could not be delivered.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async () => {
        const { browserScreenshotTool } = await import('@/services/tools/helpers')
        return browserScreenshotTool()
      },
      timeoutMs: 30_000,
    },
    {
      name: 'browser_act',
      description:
        'Interact with the page: click / type / press / scroll / wait. `type` sets the value through the native ' +
        'setter so React/Vue controlled inputs update. Approval is required because clicking can change remote state.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['click', 'type', 'press', 'scroll', 'wait'], description: 'What to do' },
          selector: { type: 'string', description: 'CSS selector (required for click/type; empty for press means the focused element)' },
          text: { type: 'string', description: 'Text to type (action=type)' },
          key: { type: 'string', description: 'Key name (action=press), e.g. Enter' },
          ms: { type: 'number', description: 'Delay in ms (action=wait, max 10000)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const { browserActTool } = await import('@/services/tools/helpers')
        return browserActTool(args.action, {
          selector: args.selector,
          text: args.text,
          key: args.key,
          ms: args.ms,
        })
      },
      requiresApproval: true,
      timeoutMs: 45_000,
    },

    // ──────────────── Pull requests (local `gh` CLI) ────────────────
    {
      name: 'read_pull_request',
      description:
        'Read the repository\'s pull requests through the user\'s own gh CLI: action="list" for open PRs, ' +
        'action="view" for one PR (or the current branch\'s) including CI checks and review comments. ' +
        'Use "view" before claiming a PR is ready, and to get reviewer feedback back into the conversation.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'view'], description: 'list | view' },
          number: { type: 'number', description: 'PR number (view; omit for the current branch)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const { githubPrTool } = await import('@/services/tools/helpers')
        return githubPrTool(args.action, { number: args.number })
      },
      requiresApproval: false,
      timeoutMs: 90_000,
    },
    {
      name: 'create_pull_request',
      description:
        'Open a pull request (action="create", needs title; the branch must already be pushed with git_push) or ' +
        'reply on one (action="comment", needs number + comment). Requires the user\'s gh CLI to be installed and ' +
        'signed in; the result names that as the reason if it is not.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'comment'], description: 'create | comment' },
          title: { type: 'string', description: 'PR title (create)' },
          body: { type: 'string', description: 'PR description (create; defaults to the branch\'s commit subjects)' },
          base: { type: 'string', description: 'Target branch (create, default main)' },
          draft: { type: 'boolean', description: 'Open as draft (create)' },
          number: { type: 'number', description: 'PR number (comment)' },
          comment: { type: 'string', description: 'Comment body (comment)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (args) => {
        const { githubPrTool } = await import('@/services/tools/helpers')
        return githubPrTool(args.action, args)
      },
      requiresApproval: true,
      timeoutMs: 90_000,
    },

    // ──────────────── Agent-control tools (handled by the chat store) ────────────────
    {
      name: 'manage_todo',
      description:
        'Maintain the session task list shown to the user. Call with the full updated list of todos. ' +
        'Each todo: { id (optional), content, status: "pending" | "in_progress" | "completed" | "failed" }. ' +
        'At most ONE todo may be "in_progress" at a time — if multiple are sent, only the first ' +
        'stays in_progress and the rest are demoted to pending. ' +
        'Use this at the start of a multi-step task and update it as steps progress.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete updated todo list',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Existing todo id (omit for new items)' },
                content: { type: 'string', description: 'Task description' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      execute: async (args) => `Todo list updated (${Array.isArray(args.todos) ? args.todos.length : 0} items)`,
    },
    {
      name: 'submit_plan',
      description:
        'In plan mode: submit a step-by-step plan for the user to approve before any file changes are made. ' +
        'The plan should break the task into ordered, concrete steps. Do not use this tool in execute mode.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short plan title' },
          steps: {
            type: 'array',
            description: 'Ordered implementation steps',
            items: {
              type: 'object',
              properties: {
                summary: { type: 'string', description: 'One-line step summary' },
                detail: { type: 'string', description: 'Optional longer explanation' },
              },
              required: ['summary'],
            },
          },
        },
        required: ['title', 'steps'],
      },
      execute: async () => 'Plan submitted (awaiting user approval)',
    },
    {
      name: 'ask_user_question',
      description:
        'Ask the user a clarifying question with optional predefined choices. ' +
        'Use this when the task is ambiguous and you need user input to proceed. The user\'s answer is returned. ' +
        'Set multiSelect=true to let the user pick several options (the answer joins them with "；"). ' +
        'Optionally pass preview, an array aligned with options, holding per-choice text ' +
        '(e.g. ASCII mockups) to show under each choice.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask' },
          options: { type: 'array', items: { type: 'string' }, description: 'Optional predefined answer choices' },
          multiSelect: { type: 'boolean', description: 'Allow selecting several options at once (default false)' },
          preview: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional per-option preview text, aligned one-to-one with options (e.g. ASCII mockups to compare)',
          },
        },
        required: ['question'],
      },
      execute: async () => 'Awaiting user answer',
    },
    {
      name: 'remember',
      description:
        'Save an important piece of information to long-term memory. Use it when the user states a ' +
        'preference, makes a decision, or shares something worth remembering for future conversations. ' +
        'Content should be concise and self-contained. Enabled via Settings → 允许 AI 自动记忆.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The concise information to remember (1-2 sentences)' },
          scope: {
            type: 'string',
            enum: ['global', 'project'],
            description: 'Memory scope: "project" (only this workspace) or "global" (all workspaces). Defaults to project when a workspace is open.',
          },
        },
        required: ['content'],
      },
      execute: async (args, context) => {
        const { useMemoryStore } = await import('@/stores/memoryStore')
        const scope = args.scope === 'global' ? 'global' : 'project'
        const projectPath = context?.projectPath || undefined
        const content = String(args.content || '').trim()
        if (!content) return 'Error: 记忆内容不能为空'
        if (scope === 'project' && !projectPath) {
          return '无法保存项目记忆：当前没有打开项目。请改用全局记忆（scope: "global"）。'
        }
        await useMemoryStore.getState().addMemory(content, scope, scope === 'project' ? projectPath : undefined)
        return `已保存到${scope === 'global' ? '全局' : '项目'}长期记忆。`
      },
    },
    {
      name: 'run_subagent',
      description:
        'Spawn a nested sub-agent to complete a bounded, self-contained sub-task (e.g. code review, ' +
        'research, refactor of an isolated module). The sub-agent runs autonomously with the full tool ' +
        'set, records its own usage, and returns a structured report. Use it to parallelize work by ' +
        'delegating independent sub-tasks, then integrate the results yourself.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '子智能体角色名，如 code-reviewer / researcher / refactorer' },
          description: { type: 'string', description: '为什么需要这个子智能体（简短背景）' },
          prompt: { type: 'string', description: '交给子智能体的具体、自包含的任务描述' },
        },
        required: ['name', 'prompt'],
      },
      execute: async (args, context) => {
        const { runSubAgent } = await import('@/services/subagents/subagentRunner')
        const sessionId = context?.sessionId || ''
        const opts: SubAgentOptions = {
          sessionId,
          projectPath: context?.projectPath || '',
          name: String(args.name || 'subagent'),
          task: String(args.prompt || ''),
          description: args.description ? String(args.description) : undefined,
          // Route the sub-agent's live progress to the UI (SubAgentProgressBlock)
          // and let the user's Stop button cancel the run.
          toolCallId: context?.toolCallId,
          abortSignal: context?.abortSignal,
        }
        // Target-mode fork (v2 §13.1): ONLY here is the task text interpreted
        // as a task envelope. Plain run_subagent tasks are never parsed — the
        // shared runner stays a dumb pipe, so normal agent mode is unaffected
        // even when a task happens to start with `---`.
        if (sessionId) {
          const { useChatStore } = await import('@/stores/chatStore')
          const session = useChatStore.getState().sessions.find((s) => s.id === sessionId)
          if (session?.targetMode) {
            const { parseEnvelope, envelopeToOverrides } = await import('@/services/targetMode/envelope')
            const envelope = parseEnvelope(opts.task)
            if (envelope) Object.assign(opts, envelopeToOverrides(envelope))
          }
        }
        return runSubAgent(opts)
      },
      requiresApproval: true,
    },

    // ──────────────── Cross-session messaging tools ────────────────
    // Peer-to-peer messaging between chat sessions (Claude Code's
    // ListAgents / SendMessage equivalent). All sessions live in the same
    // renderer store, so the "registry" is just useChatStore.sessions.
    {
      name: 'list_agents',
      description:
        'List the other chat sessions (agents) currently available, with their id, title, ' +
        'model and run status. Use it to discover a target before calling send_message. ' +
        'Equivalent to Claude Code\'s ListAgents.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional keyword to filter by session title' },
        },
        required: [],
      },
      execute: async (args, context) => {
        const { useChatStore } = await import('@/stores/chatStore')
        const { sessions, runningSessionIds } = useChatStore.getState()
        const selfId = context?.sessionId
        const kw = String(args.search || '').trim().toLowerCase()
        const baseName = (p: string | undefined): string => {
          if (!p) return '—'
          return p.split(/[\\/]/).filter(Boolean).pop() || p
        }
        const peers = sessions
          .filter((s) => s.id !== selfId && !s.archivedAt)
          .filter((s) => !kw || s.title.toLowerCase().includes(kw))
        if (peers.length === 0) {
          return kw
            ? `没有找到标题包含「${args.search}」的其他会话。`
            : '当前没有其他可用的会话。先新建一个会话，再让对方通过 send_message 联系你。'
        }
        const rows = peers.map((s) => {
          const project = baseName(s.projectPath)
          const status = runningSessionIds.includes(s.id) ? '运行中' : '空闲'
          return `| ${s.id} | ${s.title.replace(/\|/g, '\\|')} | ${s.model || '未配置'} | ${project} | ${s.messages.length} | ${status} |`
        })
        return (
          `发现 ${peers.length} 个会话（同进程内可直接互通）：\n\n` +
          '| 会话ID | 标题 | 模型 | 项目 | 消息数 | 状态 |\n' +
          '|---|---|---|---|---|---|\n' +
          rows.join('\n') +
          '\n\n调用 send_message 时传入 targetSessionId（推荐）或 targetTitle。'
        )
      },
    },
    {
      name: 'send_message',
      description:
        'Send a plain-text message to another chat session, which the receiving session\'s ' +
        'agent processes (it appears in the target\'s history and, when idle, triggers its ' +
        'agent loop to reply). Use it to coordinate parallel sessions, hand off findings or ' +
        'ask another session for status. Messages are plain text only — never conversation ' +
        'history or files. Equivalent to Claude Code\'s SendMessage.',
      parameters: {
        type: 'object',
        properties: {
          targetSessionId: { type: 'string', description: '目标会话 ID（来自 list_agents）' },
          targetTitle: { type: 'string', description: '或按标题精确匹配目标会话（targetSessionId 优先）' },
          message: { type: 'string', description: '要发送的纯文本消息内容' },
        },
        required: ['message'],
      },
      execute: async (args, context) => {
        const { useChatStore } = await import('@/stores/chatStore')
        const { useEditorStore } = await import('@/stores/editorStore')
        const { sessions } = useChatStore.getState()
        const selfId = context?.sessionId
        const sender = sessions.find((s) => s.id === selfId)

        const message = String(args.message || '').trim()
        if (!message) return 'Error: 消息内容不能为空'

        let targetId = String(args.targetSessionId || '')
        if (!targetId && args.targetTitle) {
          const byTitle = sessions.find((s) => s.title === String(args.targetTitle))
          targetId = byTitle?.id || ''
        }
        if (!targetId) {
          return 'Error: 找不到目标会话。请先调用 list_agents 获取会话 ID，再传入 targetSessionId 或 targetTitle。'
        }
        if (targetId === selfId) {
          return 'Error: 不能给自己发消息，请选择其他会话。'
        }
        const target = sessions.find((s) => s.id === targetId)
        if (!target) {
          return `Error: 目标会话 ${targetId} 不存在（可能已被删除）。请重新调用 list_agents 确认。`
        }

        const policy = useEditorStore.getState().preferences.crossSessionInbound || 'accept'
        if (policy === 'refuse') {
          return `Error: 会话「${target.title}」已设置为拒绝接收会话间消息（crossSessionInbound: refuse），消息未发送。`
        }

        const senderTitle = sender?.title || '未知会话'
        const status = useChatStore.getState().receiveInboundMessage(senderTitle, targetId, message, policy === 'hold')
        return `已发送给会话「${target.title}」。${status}`
      },
    },

    // ──────────────── Cross-session knowledge (read/search) ────────────────
    {
      name: 'read_session',
      description:
        'Read the most recent messages of another chat session (by id or title). ' +
        'Use it to pick up where another conversation left off, or to check a decision ' +
        'made there. Returns a bounded transcript (oldest of the tail first). ' +
        'List candidates with list_agents or find them with search_sessions.',
      parameters: {
        type: 'object',
        properties: {
          targetSessionId: { type: 'string', description: '目标会话 ID（来自 list_agents / search_sessions，支持唯一前缀）' },
          targetTitle: { type: 'string', description: '或按标题匹配目标会话（targetSessionId 优先）' },
          maxMessages: { type: 'number', description: '最多读取的最近消息条数（默认 20，最大 50）' },
        },
        required: [],
      },
      execute: async (args, context) => {
        const { useChatStore } = await import('@/stores/chatStore')
        const { findSessionByIdOrTitle, formatSessionTranscript } = await import('@/services/sessionKnowledge')
        const { sessions } = useChatStore.getState()
        const maxMessages = Math.min(Math.max(Number(args.maxMessages) || 20, 1), 50)
        const target = findSessionByIdOrTitle(
          sessions,
          String(args.targetSessionId || '').trim(),
          String(args.targetTitle || '').trim(),
        )
        if (!target) {
          return 'Error: 找不到目标会话。请先调用 list_agents 查看会话列表，或调用 search_sessions 按内容查找。'
        }
        const selfNote = target.id === context?.sessionId ? '（这是当前会话）' : ''
        return formatSessionTranscript(target, maxMessages) + selfNote
      },
    },
    {
      name: 'search_sessions',
      description:
        'Search the message history of ALL chat sessions for a keyword (case-insensitive) ' +
        'and return the matching sessions with a context snippet around the first hit. ' +
        'Use it to find where something was decided/discussed before opening it with read_session.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的关键词（消息内容）' },
          limit: { type: 'number', description: '最多返回的会话数（默认 5，最大 10）' },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const { useChatStore } = await import('@/stores/chatStore')
        const { searchSessionsForQuery } = await import('@/services/sessionKnowledge')
        const { sessions } = useChatStore.getState()
        const hits = searchSessionsForQuery(sessions, String(args.query || ''), Number(args.limit) || 5)
        if (hits.length === 0) return `没有会话包含 "${String(args.query || '').trim()}"`
        return hits
          .map((h) => `- 「${h.title}」(${h.sessionId})\n  [${h.role}] ${h.snippet}`)
          .join('\n\n')
      },
    },

    // ──────────────── Web tools (read-only network access) ────────────────
    {
      name: 'web_search',
      description:
        'Search the web for up-to-date information (docs, error messages, APIs, news). ' +
        'Returns a list of result titles, URLs and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
      execute: async (args) => {
        const { webSearch } = await import('@/services/tools/helpers')
        return webSearch(args.query)
      },
      timeoutMs: 45_000,
    },
    {
      name: 'read_url',
      description:
        'Fetch and read the text content of a URL (http/https). ' +
        'Useful for reading documentation pages, API references or the web-search result pages. ' +
        'Pass an optional prompt (a specific question) to have the page answered with an LLM ' +
        'instead of returning the raw text; if extraction fails the raw text is returned instead.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          prompt: { type: 'string', description: 'Optional specific question to answer from the page (LLM extraction)' },
        },
        required: ['url'],
      },
      execute: async (args, context) => {
        const { readUrl } = await import('@/services/tools/helpers')
        // context.sessionId → 提取走会话自己的配置组/模型，避免跨组错配 400
        return readUrl(args.url, typeof args.prompt === 'string' && args.prompt.trim() ? args.prompt : undefined, context?.sessionId)
      },
      timeoutMs: 45_000,
    },

    // ──────────────── Native git tools (Claude Code / Codex style) ─────────
    // 内置、零配置即可用，不依赖 git MCP 服务器是否连接。只读工具在计划
    // 模式下也可用（chatStore 的 PLAN_TOOLS 包含它们）；写操作按审批策略：
    // git_add 可逆、免审批，git_commit / git_push 需要用户确认。
    // execute 优先在 agent 会话的项目根（context.projectPath）执行，兜底
    // 工作区根。命名避开 mcp__ / skill__ 前缀。
    {
      name: 'git_status',
      description:
        'Show the current git repository status (compact porcelain format, with branch). ' +
        'Use this first to see which files changed / are staged before committing.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (_args, context) => {
        const { runGit } = await import('@/services/tools/helpers')
        return runGit(['status', '--porcelain=v1', '--branch'], context?.projectPath)
      },
      timeoutMs: 30_000,
    },
    {
      name: 'git_diff',
      description:
        'Show the unified diff of working-tree changes (or staged changes when staged=true). ' +
        'Limit with path (repo-relative file or dir) or stat=true for a summary. ' +
        'This is the full diff — unlike the built-in git MCP which only returns --stat.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional repo-relative path to limit the diff to' },
          staged: { type: 'boolean', description: 'Show staged changes (git diff --cached) instead of unstaged' },
          stat: { type: 'boolean', description: 'Only show a diffstat summary, not the full diff' },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const { runGit } = await import('@/services/tools/helpers')
        const argv: string[] = ['diff']
        if (args.staged) argv.push('--cached')
        if (args.stat) argv.push('--stat')
        if (typeof args.path === 'string' && args.path.trim()) argv.push('--', args.path.trim())
        let out = await runGit(argv, context?.projectPath)
        // 全量 diff 可能很大——截断到 ~120KB，防止一次性灌爆上下文。
        // 模型需要细节时可以用 path 限定范围。
        const MAX_DIFF_CHARS = 120 * 1024
        if (out.length > MAX_DIFF_CHARS) {
          out = out.slice(0, MAX_DIFF_CHARS) + `\n...(diff 过长已截断，共 ${out.length} 字符；请用 path 参数限定范围)`
        }
        return out
      },
      timeoutMs: 60_000,
    },
    {
      name: 'git_log',
      description: 'Show recent commit history (one line per commit, with decorations).',
      parameters: {
        type: 'object',
        properties: {
          maxCount: { type: 'number', description: 'Max number of commits to show (default 10, max 100)' },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const { runGit } = await import('@/services/tools/helpers')
        const n = Math.min(Math.max(Number(args.maxCount) || 10, 1), 100)
        return runGit(['log', `-${n}`, '--oneline', '--decorate'], context?.projectPath)
      },
      timeoutMs: 30_000,
    },
    {
      name: 'git_branch',
      description: 'List local branches and mark the current one.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      execute: async (_args, context) => {
        const { runGit } = await import('@/services/tools/helpers')
        return runGit(['branch'], context?.projectPath)
      },
      timeoutMs: 30_000,
    },
    {
      name: 'git_add',
      description:
        'Stage changes (git add). With a path, stage only that repo-relative file/dir; ' +
        'without one, stage everything including new/deleted files (git add -A). ' +
        'Reversible via git reset, so no approval is required. ' +
        '按功能拆分提交时：先 git_status 看改动，再对每个功能涉及的路径逐个 git_add，' +
        '确认无误后 git_commit；不要用 run_command 绕过，不要写脚本。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional repo-relative path to stage' },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const { runGit } = await import('@/services/tools/helpers')
        const argv = typeof args.path === 'string' && args.path.trim()
          ? ['add', '--', args.path.trim()]
          : ['add', '-A']
        return runGit(argv, context?.projectPath)
      },
      timeoutMs: 30_000,
    },
    {
      name: 'git_commit',
      description:
        'Commit the staged changes (dangerous: writes to git history — requires approval). ' +
        'Pass all=true to stage everything first (git add -A) before committing. ' +
        'Commit message 遵循仓库风格（feat:/fix:/refactor:/docs:/chore: 前缀 + 中文或英文描述），' +
        '只描述该提交涉及的功能，不要混入无关改动。',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message, 遵循仓库风格（feat:/fix:/refactor: 前缀）' },
          all: { type: 'boolean', description: 'Stage all changes first before committing' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      requiresApproval: true,
      execute: async (args, context) => {
        const { runGit } = await import('@/services/tools/helpers')
        const message = String(args.message || '').trim()
        if (!message) return 'Error: git_commit 需要 message 参数'
        if (args.all) {
          const add = await runGit(['add', '-A'], context?.projectPath)
          if (add.startsWith('Error:')) return add
        }
        return runGit(['commit', '-m', message], context?.projectPath)
      },
      timeoutMs: 60_000,
    },
    {
      name: 'git_push',
      description:
        'Push the current branch to its remote (dangerous: publishes changes — requires approval). ' +
        'Optionally specify remote (default origin) and branch (default current).',
      parameters: {
        type: 'object',
        properties: {
          remote: { type: 'string', description: 'Remote name, default origin' },
          branch: { type: 'string', description: 'Branch name, default current branch' },
        },
        required: [],
        additionalProperties: false,
      },
      requiresApproval: true,
      execute: async (args, context) => {
        const { runGit } = await import('@/services/tools/helpers')
        const argv: string[] = ['push']
        const hasRemote = typeof args.remote === 'string' && args.remote.trim()
        const hasBranch = typeof args.branch === 'string' && args.branch.trim()
        if (hasRemote || hasBranch) {
          const remote = hasRemote ? args.remote.trim() : 'origin'
          const branch = hasBranch ? args.branch.trim() : ''
          // 只传 branch 时必须补默认 remote——否则 `git push main` 会把分支名
          // 当成 remote 解析而报错
          if (hasBranch) argv.push(remote, branch)
          else argv.push(remote)
        }
        return runGit(argv, context?.projectPath)
      },
      timeoutMs: 60_000,
    },
    {
      name: 'git_split_commit',
      description:
        '按功能分组提交（危险：写 git 历史 — 需要审批）。给定若干组 {message, files}，' +
        '依次对每组 git add 指定文件并 commit。适合「按功能拆分提交」任务：先用 git_status + ' +
        'git_diff 看清改动，再一次性把分组方案交给本工具执行，避免逐个 add/commit 的轮次开销，' +
        '也避免手写脚本。规则：每个文件只能属于一个分组；files 用 repo 相对路径；' +
        'commit message 遵循仓库风格（feat:/fix:/refactor: 前缀）。某组 add 或 commit 失败会立即停止，' +
        '前面已提交的分组保留（可用 git reset 撤销）。',
      parameters: {
        type: 'object',
        properties: {
          groups: {
            type: 'array',
            description: '按功能划分的提交分组，按提交顺序排列；每个文件只能属于一个分组',
            items: {
              type: 'object',
              properties: {
                message: { type: 'string', description: '该功能的 commit message（feat:/fix:/refactor: 前缀）' },
                files: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '该功能涉及的 repo 相对路径（文件或目录）；留空则该组暂存全部剩余改动（谨慎）',
                },
              },
              required: ['message'],
              additionalProperties: false,
            },
          },
        },
        required: ['groups'],
        additionalProperties: false,
      },
      requiresApproval: true,
      execute: async (args, context) => {
        const { runGit } = await import('@/services/tools/helpers')
        const groups: Array<{ message?: string; files?: string[] }> = Array.isArray(args.groups) ? args.groups : []
        if (groups.length === 0) return 'Error: git_split_commit 需要 groups 参数'
        const lines: string[] = []
        for (const g of groups) {
          const message = String(g.message || '').trim()
          if (!message) {
            return `Error: 第 ${lines.length + 1} 组缺少 commit message（前面 ${lines.length} 组已提交，可用 git reset 撤销后重试）`
          }
          const files = Array.isArray(g.files) ? g.files.map((f) => String(f)).filter(Boolean) : []
          const addArgs = files.length > 0 ? ['add', '--', ...files] : ['add', '-A']
          const add = await runGit(addArgs, context?.projectPath)
          if (add.startsWith('Error:')) {
            return `Error: 第 ${lines.length + 1} 组 add 失败：${add}\n（前面 ${lines.length} 组已提交）`
          }
          const commit = await runGit(['commit', '-m', message], context?.projectPath)
          if (commit.startsWith('Error:')) {
            return `Error: 第 ${lines.length + 1} 组 commit 失败：${commit}\n（前面 ${lines.length} 组已提交；若为"nothing to commit"多半是该组文件已在之前分组提交过）`
          }
          const summary = commit.split('\n').slice(0, 3).join('\n  ')
          lines.push(`[${lines.length + 1}] ${message}\n  ${summary}`)
        }
        return `已按功能提交 ${lines.length} 组：\n${lines.join('\n')}`
      },
      timeoutMs: 120_000,
    },
  ]
}

/** Convert tools to OpenAI function calling format */
export function toToolDefinitions(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}
