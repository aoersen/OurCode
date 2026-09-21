import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { CryptoService } from './crypto'
import { ApiConfigGroup, ChatSession, ChatMessage, ChatBranch, UserPreferences, Memory, Checkpoint, RevertedFileRecord, TodoItem, Workflow, AgentRun, UsageEvent, UsageSummary, UsageRankRow } from '../../shared/types'
import { DEFAULT_PREFERENCES } from '../../shared/constants'

/** Parse a JSON column safely ('' / null / invalid → fallback) */
function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (value === undefined || value === null || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export class SQLiteStore {
  private db: Database.Database
  private crypto: CryptoService
  private encryptChat: boolean = false

  constructor(userDataPath: string) {
    const dbDir = join(userDataPath, 'data')
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    const dbPath = join(dbDir, 'ourcode.db')
    this.db = new Database(dbPath)
    // WAL: better concurrency for the frequent session saves (agent runs write
    // on every round / tool result) and lighter write amplification than the
    // default rollback journal.
    this.db.pragma('journal_mode = WAL')
    this.crypto = new CryptoService()

    this.initTables()
    this.migrateTables()
    this.loadEncryptFlag()
  }

  private loadEncryptFlag(): void {
    const row = this.db.prepare("SELECT value FROM user_preferences WHERE key = 'encryptChatData'").get() as any
    if (row) {
      try {
        this.encryptChat = JSON.parse(row.value) === true
      } catch { this.encryptChat = false }
    }
  }

  setEncryptChat(value: boolean): void {
    this.encryptChat = value
  }

  /** True when chat-data at-rest encryption is enabled — the wire log gates
   *  on this (a plaintext log must never bypass the encryption feature). */
  get isChatEncrypted(): boolean {
    return this.encryptChat
  }

  getCrypto(): CryptoService {
    return this.crypto
  }

  private migrateTables(): void {
    // Add color column if missing
    const columns = this.db.prepare("PRAGMA table_info(api_config_groups)").all() as any[]
    const hasColor = columns.some((c: any) => c.name === 'color')
    if (!hasColor) {
      this.db.exec("ALTER TABLE api_config_groups ADD COLUMN color TEXT DEFAULT ''")
    }
    // Add sort_order column if missing (for drag-reorder persistence)
    if (!columns.some((c: any) => c.name === 'sort_order')) {
      this.db.exec("ALTER TABLE api_config_groups ADD COLUMN sort_order INTEGER DEFAULT 0")
    }
    // Add skip_tls_verify column if missing (per-group intranet cert bypass)
    if (!columns.some((c: any) => c.name === 'skip_tls_verify')) {
      this.db.exec("ALTER TABLE api_config_groups ADD COLUMN skip_tls_verify INTEGER DEFAULT 0")
    }
    // Add edited_at column to chat_messages if missing
    const msgColumns = this.db.prepare("PRAGMA table_info(chat_messages)").all() as any[]
    const hasEditedAt = msgColumns.some((c: any) => c.name === 'edited_at')
    if (!hasEditedAt) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN edited_at INTEGER DEFAULT 0")
    }
    // Add branch_id column to chat_messages if missing
    const hasBranchId = msgColumns.some((c: any) => c.name === 'branch_id')
    if (!hasBranchId) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN branch_id TEXT DEFAULT ''")
    }
    // Add tool_calls / tool_results columns to chat_messages if missing
    if (!msgColumns.some((c: any) => c.name === 'tool_calls')) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN tool_calls TEXT DEFAULT '[]'")
    }
    if (!msgColumns.some((c: any) => c.name === 'tool_results')) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN tool_results TEXT DEFAULT '[]'")
    }
    // Add per-round LLM request timing/usage columns if missing (trajectory view:
    // one assistant message = one LLM round; these persist the round's wall-clock
    // timing and provider-reported tokens so the trace tab doesn't re-derive them)
    if (!msgColumns.some((c: any) => c.name === 'request_started_at')) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN request_started_at INTEGER DEFAULT 0")
    }
    if (!msgColumns.some((c: any) => c.name === 'request_duration_ms')) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN request_duration_ms INTEGER DEFAULT 0")
    }
    if (!msgColumns.some((c: any) => c.name === 'request_tokens_in')) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN request_tokens_in INTEGER DEFAULT 0")
    }
    if (!msgColumns.some((c: any) => c.name === 'request_tokens_out')) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN request_tokens_out INTEGER DEFAULT 0")
    }
    if (!msgColumns.some((c: any) => c.name === 'ttft_ms')) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN ttft_ms INTEGER DEFAULT 0")
    }
    // Image attachments (base64) on user messages. Stored on the message rather
    // than as a side table so a session load picks them up with the rows they
    // belong to; the renderer only ships the payload once (see
    // stripDurableAttachments in chatStore) and the UPSERT below keeps the
    // stored copy when a later save arrives without it.
    if (!msgColumns.some((c: any) => c.name === 'attachments')) {
      this.db.exec("ALTER TABLE chat_messages ADD COLUMN attachments TEXT DEFAULT '[]'")
    }
    // Reverted files carry the AI-written forward snapshot (restore_content /
    // restore_existed) and the source message id so a revert can be undone
    // (恢复) and the re-created checkpoint re-attaches to its message.
    // Legacy rows (reverted before this feature) get has_snapshot = 0 and are
    // never restored — there is no content to restore.
    const revertedColumns = this.db.prepare("PRAGMA table_info(reverted_files)").all() as any[]
    if (!revertedColumns.some((c: any) => c.name === 'restore_content')) {
      this.db.exec("ALTER TABLE reverted_files ADD COLUMN restore_content TEXT DEFAULT ''")
    }
    if (!revertedColumns.some((c: any) => c.name === 'restore_existed')) {
      this.db.exec("ALTER TABLE reverted_files ADD COLUMN restore_existed INTEGER DEFAULT 1")
    }
    if (!revertedColumns.some((c: any) => c.name === 'message_id')) {
      this.db.exec("ALTER TABLE reverted_files ADD COLUMN message_id TEXT DEFAULT ''")
    }
    if (!revertedColumns.some((c: any) => c.name === 'has_snapshot')) {
      this.db.exec("ALTER TABLE reverted_files ADD COLUMN has_snapshot INTEGER DEFAULT 0")
    }
    // Add branch/pin/archive columns to chat_sessions if missing
    const sessColumns = this.db.prepare("PRAGMA table_info(chat_sessions)").all() as any[]
    if (!sessColumns.some((c: any) => c.name === 'active_branch_id')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN active_branch_id TEXT DEFAULT ''")
    }
    if (!sessColumns.some((c: any) => c.name === 'branches')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN branches TEXT DEFAULT '[]'")
    }
    if (!sessColumns.some((c: any) => c.name === 'pinned_at')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN pinned_at INTEGER DEFAULT 0")
    }
    if (!sessColumns.some((c: any) => c.name === 'archived_at')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN archived_at INTEGER DEFAULT 0")
    }
    // Add agent-mode / todo / plan columns to chat_sessions if missing
    if (!sessColumns.some((c: any) => c.name === 'agent_mode')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN agent_mode TEXT DEFAULT 'chat'")
    }
    if (!sessColumns.some((c: any) => c.name === 'todos')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN todos TEXT DEFAULT '[]'")
    }
    if (!sessColumns.some((c: any) => c.name === 'plan_content')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN plan_content TEXT DEFAULT ''")
    }
    if (!sessColumns.some((c: any) => c.name === 'plan_status')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN plan_status TEXT DEFAULT 'none'")
    }
    // Add agent_runs column to chat_sessions if missing (persisted agent task records)
    if (!sessColumns.some((c: any) => c.name === 'agent_runs')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN agent_runs TEXT DEFAULT '[]'")
    }
    // Add project_path column to chat_sessions if missing (session ↔ workspace association)
    if (!sessColumns.some((c: any) => c.name === 'project_path')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN project_path TEXT DEFAULT ''")
    }
    // Add context-compaction columns to chat_sessions if missing (LLM summary
    // of the pre-boundary history — a request-time view; original messages are
    // never deleted)
    if (!sessColumns.some((c: any) => c.name === 'summary')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN summary TEXT DEFAULT ''")
    }
    if (!sessColumns.some((c: any) => c.name === 'summary_message_count')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN summary_message_count INTEGER DEFAULT 0")
    }
    // Add per-session project edit mode (手动确认/完全访问/自动编辑/计划) if
    // missing — persisting it lets a restored session (new window / restart)
    // keep the mode the user last chose, matching agent_mode persistence.
    if (!sessColumns.some((c: any) => c.name === 'project_edit_mode')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN project_edit_mode TEXT DEFAULT 'confirm_before_change'")
    }
    // Add the "last user message time" sort anchor if missing. The session list
    // sorts by this (not updatedAt, which agent activity refreshes constantly);
    // persisting it keeps the anchor correct even if history is later trimmed.
    if (!sessColumns.some((c: any) => c.name === 'last_user_message_at')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN last_user_message_at INTEGER DEFAULT 0")
    }
    // Durable compaction lock: 1 while an LLM summarizer is mid-flight for this
    // session. Persisted so a crash mid-compaction is detectable on the next
    // load (the lock is cleared then — the old summary stays valid, so nothing
    // is lost; the lock only prevents a half-finished compaction from being
    // treated as complete).
    if (!sessColumns.some((c: any) => c.name === 'compaction_in_progress')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN compaction_in_progress INTEGER DEFAULT 0")
    }
    // Add the session window "mode" column if missing. 'main' = 对话窗口（默认），
    // 'office' = 一人公司独立窗口 —— 两个窗口的会话完全隔离，互不显示。
    if (!sessColumns.some((c: any) => c.name === 'mode')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN mode TEXT DEFAULT 'main'")
    }
    // Persist the per-session target-mode flag（一人公司会话跨重启保持目标模式）。
    // 此前 targetMode 只在内存里，重启后所有办公室会话回退成普通 agent 对话——
    // 在办公室切到项目看到的又是「普通 agent 模式的对话」。
    if (!sessColumns.some((c: any) => c.name === 'target_mode')) {
      this.db.exec("ALTER TABLE chat_sessions ADD COLUMN target_mode INTEGER DEFAULT 0")
      // 一次性回填：既有 office 会话本来就是目标模式跑出来的（监管+子 Agent 派发），
      // 升级后应保持公司形态，而不是退化成普通对话。
      this.db.exec("UPDATE chat_sessions SET target_mode = 1 WHERE mode = 'office'")
    }
    // Add project_path column to memories if missing (project-scoped memories)
    const memColumns = this.db.prepare("PRAGMA table_info(memories)").all() as any[]
    if (!memColumns.some((c: any) => c.name === 'project_path')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN project_path TEXT DEFAULT ''")
    }
    // Add last_accessed_at column to llm_response_cache if missing (LRU eviction)
    const cacheColumns = this.db.prepare("PRAGMA table_info(llm_response_cache)").all() as any[]
    if (!cacheColumns.some((c: any) => c.name === 'last_accessed_at')) {
      this.db.exec("ALTER TABLE llm_response_cache ADD COLUMN last_accessed_at INTEGER DEFAULT 0")
      // Populate existing rows with created_at so they have a usable access time
      this.db.exec("UPDATE llm_response_cache SET last_accessed_at = created_at WHERE last_accessed_at = 0")
    }
    // Always ensure the LRU index exists. Must run AFTER the column above is
    // guaranteed present (old DBs lack it, and CREATE INDEX would otherwise
    // throw "no such column" before this migration ever runs).
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_cache_last_accessed ON llm_response_cache(last_accessed_at)")
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_config_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key_encrypted BLOB NOT NULL,
        system_prompt TEXT DEFAULT '',
        default_model TEXT DEFAULT '',
        provider TEXT DEFAULT 'openai',
        custom_headers TEXT DEFAULT '{}',
        color TEXT DEFAULT '',
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '新对话',
        config_group_id TEXT NOT NULL,
        model TEXT DEFAULT '',
        model_params TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (config_group_id) REFERENCES api_config_groups(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        context_files TEXT DEFAULT '[]',
        token_count INTEGER DEFAULT 0,
        thinking TEXT DEFAULT '',
        tool_calls TEXT DEFAULT '[]',
        tool_results TEXT DEFAULT '[]',
        attachments TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS user_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        scope TEXT DEFAULT 'global',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        label TEXT DEFAULT '',
        message_id TEXT DEFAULT '',
        files TEXT DEFAULT '[]',
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
      );

      -- Lightweight record of files whose changes were reverted, so the file-
      -- changes summary can still show them as「已回退」after the checkpoint
      -- snapshot itself is deleted (and after restart / session re-entry).
      -- restore_content / restore_existed keep the AI-written state captured at
      -- revert time so the revert can be undone (恢复), and message_id points
      -- back at the source assistant message to rebuild a re-revertable
      -- checkpoint on restore. has_snapshot marks records that really carry a
      -- forward snapshot — legacy rows (reverted before this feature) don't,
      -- and restoring them must be refused instead of writing empty content.
      CREATE TABLE IF NOT EXISTS reverted_files (
        session_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        reverted_at INTEGER NOT NULL,
        restore_content TEXT DEFAULT '',
        restore_existed INTEGER DEFAULT 1,
        message_id TEXT DEFAULT '',
        has_snapshot INTEGER DEFAULT 0,
        PRIMARY KEY (session_id, file_path)
      );

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        prompt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        name TEXT NOT NULL,
        sub TEXT DEFAULT '',
        session_id TEXT DEFAULT '',
        project_path TEXT DEFAULT '',
        started_at INTEGER NOT NULL,
        finished_at INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        ok INTEGER DEFAULT 1,
        error TEXT DEFAULT '',
        payload TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS llm_response_cache (
        key TEXT PRIMARY KEY,
        provider TEXT DEFAULT '',
        model TEXT DEFAULT '',
        response TEXT NOT NULL,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER DEFAULT 0,
        hits INTEGER DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON chat_messages(session_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_sessions_config ON chat_sessions(config_group_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reverted_files_session ON reverted_files(session_id, reverted_at);
      CREATE INDEX IF NOT EXISTS idx_usage_category_time ON usage_events(category, started_at);
      CREATE INDEX IF NOT EXISTS idx_usage_name ON usage_events(name);
      CREATE INDEX IF NOT EXISTS idx_usage_started ON usage_events(started_at);
      CREATE INDEX IF NOT EXISTS idx_cache_created ON llm_response_cache(created_at);
    `)
  }

  // Config Groups
  getConfigGroups(): ApiConfigGroup[] {
    const rows = this.db.prepare('SELECT * FROM api_config_groups ORDER BY sort_order ASC, created_at DESC').all() as any[]

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      apiKey: this.crypto.decrypt(row.api_key_encrypted),
      systemPrompt: row.system_prompt,
      defaultModel: row.default_model,
      provider: row.provider,
        customHeaders: JSON.parse(row.custom_headers || '{}'),
        color: row.color || undefined,
        sortOrder: row.sort_order || 0,
        skipTlsVerify: !!row.skip_tls_verify,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }))
  }

  saveConfigGroup(group: Omit<ApiConfigGroup, 'createdAt' | 'updatedAt'> & { id?: string }): ApiConfigGroup {
    const id = group.id || uuidv4()
    const now = Date.now()
    const encryptedKey = this.crypto.encrypt(group.apiKey)

    const existing = this.db.prepare('SELECT id FROM api_config_groups WHERE id = ?').get(id)

    if (existing) {
      this.db.prepare(`
        UPDATE api_config_groups
        SET name = ?, base_url = ?, api_key_encrypted = ?, system_prompt = ?,
            default_model = ?, provider = ?, custom_headers = ?, color = ?, sort_order = ?,
            skip_tls_verify = ?, updated_at = ?
        WHERE id = ?
      `).run(
        group.name,
        group.baseUrl,
        encryptedKey,
        group.systemPrompt,
        group.defaultModel,
        group.provider,
        JSON.stringify(group.customHeaders || {}),
        group.color || '',
        group.sortOrder || 0,
        group.skipTlsVerify ? 1 : 0,
        now,
        id
      )
    } else {
      this.db.prepare(`
        INSERT INTO api_config_groups (id, name, base_url, api_key_encrypted, system_prompt,
          default_model, provider, custom_headers, color, sort_order, skip_tls_verify, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        group.name,
        group.baseUrl,
        encryptedKey,
        group.systemPrompt,
        group.defaultModel,
        group.provider,
        JSON.stringify(group.customHeaders || {}),
        group.color || '',
        group.sortOrder || 0,
        group.skipTlsVerify ? 1 : 0,
        now,
        now
      )
    }

    return {
      ...group,
      id,
      createdAt: existing ? (this.db.prepare('SELECT created_at FROM api_config_groups WHERE id = ?').get(id) as any).created_at : now,
      updatedAt: now,
    }
  }

  deleteConfigGroup(id: string): void {
    this.db.prepare('DELETE FROM api_config_groups WHERE id = ?').run(id)
  }

  // Chat Sessions
  getSessions(mode?: 'main' | 'office'): ChatSession[] {
    // 一人公司与对话模式完全隔离:office 窗口只看到 mode='office' 的会话,
    // main 窗口只看到 mode='main' / 无模式(升级前的旧会话)的会话。
    // 开公司不会把普通 agent 模式的对话带过来;反之 main 窗口也看不到公司会话。
    const sessions = !mode
      ? (this.db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC').all() as any[])
      : mode === 'office'
        ? (this.db.prepare(
            `SELECT * FROM chat_sessions
               WHERE mode = 'office'
               ORDER BY updated_at DESC`
          ).all() as any[])
        : (this.db.prepare(
            `SELECT * FROM chat_sessions
               WHERE mode = 'main' OR mode IS NULL OR mode = ''
               ORDER BY updated_at DESC`
          ).all() as any[])

    // Load all messages in one query and bucket by session, instead of one
    // query per session (N+1) — opening the sidebar with many sessions used to
    // run a SELECT per session on the main process.
    const allMessages = this.db.prepare('SELECT * FROM chat_messages ORDER BY session_id, sort_order ASC').all() as any[]
    const messagesBySession = new Map<string, any[]>()
    for (const msg of allMessages) {
      const bucket = messagesBySession.get(msg.session_id)
      if (bucket) bucket.push(msg)
      else messagesBySession.set(msg.session_id, [msg])
    }

    return sessions.map(session => {
      const messages = messagesBySession.get(session.id) || []

      // Parse branches JSON, decrypting message content in each branch
      let branches: ChatBranch[] = []
      try {
        const rawBranches = JSON.parse(session.branches || '[]')
        branches = rawBranches.map((b: any) => ({
          id: b.id,
          name: b.name,
          forkedFromMessageId: b.forkedFromMessageId || '',
          createdAt: b.createdAt,
          messages: (b.messages || []).map((msg: any) => ({
            id: msg.id,
            role: msg.role,
            content: this.maybeDecrypt(msg.content),
            sortOrder: msg.sortOrder,
            contextFiles: msg.contextFiles || [],
            tokenCount: msg.tokenCount || 0,
            thinking: msg.thinking ? this.maybeDecrypt(msg.thinking) : undefined,
            editedAt: msg.editedAt || undefined,
            toolCalls: msg.toolCalls?.length ? msg.toolCalls : undefined,
            toolResults: msg.toolResults?.length ? msg.toolResults : undefined,
            toolCallId: msg.toolCallId || undefined,
            createdAt: msg.createdAt,
          })),
        }))
      } catch { branches = [] }

    // Crash recovery: a durable lock left at 1 means the app died while the
    // summarizer was running. The pre-crash summary (if any) is still valid —
    // clear the lock so a future run can compact again. (Sessions are never
    // saved while the lock is held with a half-written summary — summary only
    // lands after the summarizer returns.)
    if (session.compaction_in_progress) {
      this.db.prepare('UPDATE chat_sessions SET compaction_in_progress = 0 WHERE id = ?').run(session.id)
    }

    return {
      id: session.id,
      title: session.title,
      configGroupId: session.config_group_id,
      model: session.model,
      modelParams: JSON.parse(session.model_params || '{}'),
      compactionInProgress: false,
        messages: messages.map(msg => {
          const toolResults = parseJsonField<ChatMessage['toolResults']>(msg.tool_results, undefined)
          const attachments = parseJsonField<ChatMessage['attachments']>(
            msg.attachments ? this.maybeDecrypt(msg.attachments) : '', undefined
          )
          return {
            id: msg.id,
            role: msg.role,
            content: this.maybeDecrypt(msg.content),
            sortOrder: msg.sort_order,
            contextFiles: parseJsonField<string[]>(msg.context_files, []),
            tokenCount: msg.token_count,
            attachments: attachments?.length ? attachments : undefined,
            thinking: msg.thinking ? this.maybeDecrypt(msg.thinking) : undefined,
            editedAt: msg.edited_at || undefined,
            toolCalls: parseJsonField<ChatMessage['toolCalls']>(msg.tool_calls, undefined)?.length
              ? parseJsonField<ChatMessage['toolCalls']>(msg.tool_calls, undefined)
              : undefined,
            toolResults: toolResults?.length ? toolResults : undefined,
            toolCallId: msg.tool_call_id || (toolResults?.[0]?.toolCallId) || undefined,
            requestStartedAt: msg.request_started_at || undefined,
            requestDurationMs: msg.request_duration_ms || undefined,
            ttftMs: msg.ttft_ms || undefined,
            requestTokensIn: msg.request_tokens_in || undefined,
            requestTokensOut: msg.request_tokens_out || undefined,
            createdAt: msg.created_at,
          }
        }),
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        activeBranchId: session.active_branch_id || undefined,
        branches: branches.length > 0 ? branches : undefined,
        pinnedAt: session.pinned_at || undefined,
        archivedAt: session.archived_at || undefined,
        // Legacy 'plan' mode was merged into 'agent' — map old sessions on load
        agentMode: (session.agent_mode === 'plan' ? 'agent' : session.agent_mode || 'chat') as 'chat' | 'agent',
        // Per-session edit mode (手动确认/完全访问/自动编辑/计划) — persisted so
        // a restored session keeps the user's choice across windows/restarts.
        projectEditMode: (['confirm_before_change', 'auto_edit', 'plan', 'full_access'].includes(session.project_edit_mode)
          ? session.project_edit_mode
          : undefined) as ChatSession['projectEditMode'],
        // Sort anchor: last time the user sent a message. 0 = unset (renderer
        // backfills from messages / falls back to updatedAt).
        lastUserMessageAt: session.last_user_message_at > 0 ? session.last_user_message_at : undefined,
        todos: parseJsonField<TodoItem[]>(session.todos, []),
        planContent: session.plan_content || undefined,
        planStatus: (session.plan_status || 'none') as 'none' | 'pending_approval' | 'approved' | 'canceled',
        projectPath: session.project_path || undefined,
        agentRuns: parseJsonField<AgentRun[]>(session.agent_runs, []).length
          ? parseJsonField<AgentRun[]>(session.agent_runs, [])
          : undefined,
        summary: session.summary || undefined,
        summaryMessageCount: session.summary_message_count || undefined,
        mode: (session.mode === 'office' ? 'office' : 'main') as 'main' | 'office',
        targetMode: session.target_mode ? true : undefined,
      }
    })
  }

  saveSession(session: Omit<ChatSession, 'createdAt' | 'updatedAt'> & { id?: string }): ChatSession {
    const id = session.id || uuidv4()
    const now = Date.now()

    const existing = this.db.prepare('SELECT id FROM chat_sessions WHERE id = ?').get(id)

    if (existing) {
      this.db.prepare(`
        UPDATE chat_sessions
        SET title = ?, config_group_id = ?, model = ?, model_params = ?, updated_at = ?,
            active_branch_id = ?, branches = ?, pinned_at = ?, archived_at = ?,
            agent_mode = ?, todos = ?, plan_content = ?, plan_status = ?, agent_runs = ?, project_path = ?,
            summary = ?, summary_message_count = ?, project_edit_mode = ?, last_user_message_at = ?,
            compaction_in_progress = ?, mode = ?, target_mode = ?
        WHERE id = ?
      `).run(
        session.title,
        session.configGroupId,
        session.model,
        JSON.stringify(session.modelParams),
        now,
        (session as any).activeBranchId || '',
        JSON.stringify((session as any).branches || []),
        (session as any).pinnedAt || 0,
        (session as any).archivedAt || 0,
        (session as any).agentMode || 'chat',
        JSON.stringify((session as any).todos || []),
        (session as any).planContent || '',
        (session as any).planStatus || 'none',
        JSON.stringify((session as any).agentRuns || []),
        (session as any).projectPath || '',
        (session as any).summary || '',
        (session as any).summaryMessageCount || 0,
        (session as any).projectEditMode || 'confirm_before_change',
        (session as any).lastUserMessageAt || 0,
        (session as any).compactionInProgress ? 1 : 0,
        (session as any).mode === 'office' ? 'office' : 'main',
        (session as any).targetMode ? 1 : 0,
        id
      )
    } else {
      this.db.prepare(`
        INSERT INTO chat_sessions (id, title, config_group_id, model, model_params, created_at, updated_at,
          active_branch_id, branches, pinned_at, archived_at, agent_mode, todos, plan_content, plan_status, agent_runs, project_path,
          summary, summary_message_count, project_edit_mode, last_user_message_at, compaction_in_progress, mode, target_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        session.title,
        session.configGroupId,
        session.model,
        JSON.stringify(session.modelParams),
        now,
        now,
        (session as any).activeBranchId || '',
        JSON.stringify((session as any).branches || []),
        (session as any).pinnedAt || 0,
        (session as any).archivedAt || 0,
        (session as any).agentMode || 'chat',
        JSON.stringify((session as any).todos || []),
        (session as any).planContent || '',
        (session as any).planStatus || 'none',
        JSON.stringify((session as any).agentRuns || []),
        (session as any).projectPath || '',
        (session as any).summary || '',
        (session as any).summaryMessageCount || 0,
        (session as any).projectEditMode || 'confirm_before_change',
        (session as any).lastUserMessageAt || 0,
        (session as any).compactionInProgress ? 1 : 0,
        (session as any).mode === 'office' ? 'office' : 'main',
        (session as any).targetMode ? 1 : 0
      )
    }

    // Upsert messages in place instead of DELETE-all + re-INSERT-all. Agent runs
    // persist the whole session on every round / tool result; the old path
    // rewrote the entire message table each time (O(messages) DELETE + INSERT
    // with index and WAL churn), so long sessions got progressively slower to
    // save. Upserting keeps unchanged rows intact and only deletes rows that
    // disappeared from the incoming list (message deleted / history edited).
    const upsertMsg = this.db.prepare(`
      INSERT INTO chat_messages (id, session_id, role, content, sort_order, context_files, token_count, thinking, tool_calls, tool_results, attachments, edited_at, request_started_at, request_duration_ms, request_tokens_in, request_tokens_out, ttft_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        role = excluded.role,
        content = excluded.content,
        sort_order = excluded.sort_order,
        context_files = excluded.context_files,
        token_count = excluded.token_count,
        thinking = excluded.thinking,
        tool_calls = excluded.tool_calls,
        tool_results = excluded.tool_results,
        -- NULL means "this save carries no attachment payload" (the renderer
        -- strips base64 once it is durable) — keep the stored copy then.
        attachments = COALESCE(excluded.attachments, attachments),
        edited_at = excluded.edited_at,
        request_started_at = excluded.request_started_at,
        request_duration_ms = excluded.request_duration_ms,
        request_tokens_in = excluded.request_tokens_in,
        request_tokens_out = excluded.request_tokens_out,
        ttft_ms = excluded.ttft_ms
    `)

    const replaceMessages = this.db.transaction((messages: ChatMessage[]) => {
      for (const msg of messages) {
        upsertMsg.run(
          msg.id,
          id,
          msg.role,
          this.maybeEncrypt(msg.content),
          msg.sortOrder,
          JSON.stringify(msg.contextFiles),
          msg.tokenCount,
          msg.thinking ? this.maybeEncrypt(msg.thinking) : '',
          JSON.stringify(msg.toolCalls || []),
          JSON.stringify(msg.toolResults || []),
          msg.attachments?.length ? this.maybeEncrypt(JSON.stringify(msg.attachments)) : null,
          msg.editedAt || 0,
          msg.requestStartedAt || 0,
          msg.requestDurationMs || 0,
          msg.requestTokensIn || 0,
          msg.requestTokensOut || 0,
          msg.ttftMs || 0,
          msg.createdAt
        )
      }
      // Drop rows no longer present in the incoming list. Diffed in JS against
      // the current rows so very long sessions don't hit SQLite's 999-parameter
      // limit (a `NOT IN (...)` list of message ids would).
      const kept = new Set(messages.map((m) => m.id))
      const existingIds = this.db.prepare('SELECT id FROM chat_messages WHERE session_id = ?').all(id) as any[]
      const delStmt = this.db.prepare('DELETE FROM chat_messages WHERE id = ?')
      for (const row of existingIds) {
        if (!kept.has(row.id)) delStmt.run(row.id)
      }
    })

    replaceMessages(session.messages)

    return {
      ...session,
      id,
      createdAt: existing ? (this.db.prepare('SELECT created_at FROM chat_sessions WHERE id = ?').get(id) as any).created_at : now,
      updatedAt: now,
    }
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id)
  }

  // User Preferences
  getPreferences(): UserPreferences {
    const rows = this.db.prepare('SELECT * FROM user_preferences').all() as any[]
    const prefs: any = { ...DEFAULT_PREFERENCES }

    for (const row of rows) {
      try {
        prefs[row.key] = JSON.parse(row.value)
      } catch {
        prefs[row.key] = row.value
      }
    }

    return prefs as UserPreferences
  }

  savePreferences(prefs: Partial<UserPreferences>): void {
    const upsert = this.db.prepare(`
      INSERT OR REPLACE INTO user_preferences (key, value) VALUES (?, ?)
    `)

    const saveMany = this.db.transaction((entries: [string, any][]) => {
      for (const [key, value] of entries) {
        upsert.run(key, JSON.stringify(value))
      }
    })

    saveMany(Object.entries(prefs))
  }

  // Encrypt/Decrypt helpers for chat content
  private maybeEncrypt(text: string): string {
    if (!this.encryptChat || !this.crypto.hasChatKey()) return text
    return this.crypto.encryptChat(text).toString('base64')
  }

  private maybeDecrypt(text: string): string {
    if (!this.encryptChat || !this.crypto.hasChatKey()) return text
    try {
      const buf = Buffer.from(text, 'base64')
      // Only attempt decrypt if buffer is large enough for IV+TAG+data
      if (buf.length > 32) return this.crypto.decryptChat(buf)
    } catch {
      // Not encrypted (plaintext from before encryption was enabled)
    }
    return text
  }

  // ───────────────────── Memories (persistent user context) ─────────────────────
  getMemories(): Memory[] {
    const rows = this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all() as any[]
    return rows.map((row) => ({
      id: row.id,
      content: this.maybeDecrypt(row.content),
      scope: (row.scope || 'global') as Memory['scope'],
      projectPath: row.project_path || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  addMemory(content: string, scope: Memory['scope'], projectPath?: string): Memory {
    const id = uuidv4()
    const now = Date.now()
    this.db.prepare('INSERT INTO memories (id, content, scope, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, this.maybeEncrypt(content), scope || 'global', projectPath || '', now, now)
    return { id, content, scope: scope || 'global', projectPath, createdAt: now, updatedAt: now }
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  // ───────────────────── Checkpoints (AI edit snapshots) ─────────────────────
  getCheckpoints(sessionId: string): Checkpoint[] {
    const rows = this.db.prepare(
      'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC'
    ).all(sessionId) as any[]
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      createdAt: row.created_at,
      label: row.label || '',
      messageId: row.message_id || undefined,
      files: parseJsonField<Checkpoint['files']>(row.files, []),
    }))
  }

  addCheckpoint(checkpoint: Omit<Checkpoint, 'createdAt'> & { createdAt?: number }): Checkpoint {
    const now = checkpoint.createdAt || Date.now()
    this.db.prepare(`
      INSERT INTO checkpoints (id, session_id, created_at, label, message_id, files)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      checkpoint.id,
      checkpoint.sessionId,
      now,
      checkpoint.label || '',
      checkpoint.messageId || '',
      JSON.stringify(checkpoint.files || [])
    )
    return { ...checkpoint, createdAt: now }
  }

  deleteCheckpoints(sessionId: string): void {
    this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId)
  }

  deleteCheckpoint(id: string): void {
    this.db.prepare('DELETE FROM checkpoints WHERE id = ?').run(id)
  }

  // ─────────────── Reverted files (display-only, survives checkpoint delete) ─
  getRevertedFiles(sessionId: string): string[] {
    return this.getRevertedFileRecords(sessionId).map((r) => r.path)
  }

  /** Full forward-snapshot records of a session's reverted files — used to
   *  restore (undo a revert) and to show the AI-written content in diffs. */
  getRevertedFileRecords(sessionId: string): RevertedFileRecord[] {
    const rows = this.db.prepare(
      'SELECT file_path, restore_content, restore_existed, reverted_at, message_id, has_snapshot FROM reverted_files WHERE session_id = ? ORDER BY reverted_at ASC'
    ).all(sessionId) as any[]
    return rows.map((r) => ({
      path: r.file_path,
      content: r.restore_content || '',
      existed: r.restore_existed !== 0,
      revertedAt: r.reverted_at,
      messageId: r.message_id || undefined,
      hasSnapshot: r.has_snapshot !== 0,
    }))
  }

  addRevertedFiles(
    sessionId: string,
    records: Array<{ path: string; content?: string; existed?: boolean; messageId?: string }>,
  ): void {
    const now = Date.now()
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO reverted_files
        (session_id, file_path, reverted_at, restore_content, restore_existed, message_id, has_snapshot)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `)
    for (const r of records) {
      if (!r?.path) continue
      insert.run(sessionId, r.path, now, r.content || '', r.existed === false ? 0 : 1, r.messageId || '')
    }
  }

  deleteRevertedFile(sessionId: string, filePath: string): void {
    this.db.prepare('DELETE FROM reverted_files WHERE session_id = ? AND file_path = ?').run(sessionId, filePath)
  }

  /** Drop every reverted record for a path (any session) — called after a
   *  successful write/delete so a stale forward snapshot can't restore outdated
   *  AI content over the file's newer state. */
  deleteRevertedFileByPath(filePath: string): void {
    this.db.prepare('DELETE FROM reverted_files WHERE file_path = ?').run(filePath)
  }

  deleteRevertedFiles(sessionId: string): void {
    this.db.prepare('DELETE FROM reverted_files WHERE session_id = ?').run(sessionId)
  }

  // ───────────────────── Workflows (reusable prompt templates) ─────────────────────
  getWorkflows(): Workflow[] {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY updated_at DESC').all() as any[]
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      prompt: this.maybeDecrypt(row.prompt),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  addWorkflow(input: { name: string; description?: string; prompt: string }): Workflow {
    const id = uuidv4()
    const now = Date.now()
    this.db.prepare('INSERT INTO workflows (id, name, description, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.name || '未命名工作流', input.description || '', this.maybeEncrypt(input.prompt), now, now)
    return { id, name: input.name || '未命名工作流', description: input.description || '', prompt: input.prompt, createdAt: now, updatedAt: now }
  }

  deleteWorkflow(id: string): void {
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id)
  }

  // ───────────────────── Usage statistics (LLM / skills / subagents / MCP) ─────────────────────
  /** Batch-insert usage events (idempotent per id — INSERT OR REPLACE) */
  recordUsageEvents(events: UsageEvent[]): void {
    if (!events || events.length === 0) return
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO usage_events
        (id, category, name, sub, session_id, project_path, started_at, finished_at,
         duration_ms, tokens_in, tokens_out, ok, error, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertMany = this.db.transaction((rows: UsageEvent[]) => {
      for (const e of rows) {
        insert.run(
          e.id,
          e.category,
          e.name,
          e.sub || '',
          e.sessionId || '',
          e.projectPath || '',
          e.startedAt,
          e.finishedAt || 0,
          e.durationMs || 0,
          e.tokensIn || 0,
          e.tokensOut || 0,
          e.ok === false ? 0 : 1,
          e.error || '',
          JSON.stringify(e.payload || {})
        )
      }
    })
    insertMany(events)
  }

  /** Aggregate one ranking group (byModel / skills / subagents / mcp) */
  private usageRank(category: string, cutoff: number): UsageRankRow[] {
    const sql = `
      SELECT name, sub, COUNT(*) AS count,
             IFNULL(SUM(tokens_in), 0) AS tokensIn,
             IFNULL(SUM(tokens_out), 0) AS tokensOut,
             IFNULL(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
             MAX(started_at) AS lastUsed
      FROM usage_events
      WHERE category = ?${cutoff > 0 ? ' AND started_at >= ?' : ''}
      GROUP BY name, sub
      ORDER BY count DESC, lastUsed DESC
    `
    const rows = cutoff > 0
      ? this.db.prepare(sql).all(category, cutoff)
      : this.db.prepare(sql).all(category)
    return (rows as any[]).map((r) => ({
      name: r.name,
      sub: r.sub || '',
      count: r.count,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      errors: r.errors,
      lastUsed: r.lastUsed,
    }))
  }

  /** Dashboard payload for a time range (rangeDays; 0/undefined = all time) */
  getUsageSummary(rangeDays?: number): UsageSummary {
    const cutoff = rangeDays && rangeDays > 0 ? Date.now() - rangeDays * 86400000 : 0
    const where = cutoff > 0 ? 'WHERE started_at >= ?' : ''
    const params = cutoff > 0 ? [cutoff] : []

    const totals = this.db.prepare(`
      SELECT COUNT(*) AS requests,
             IFNULL(SUM(tokens_in), 0) AS tokensIn,
             IFNULL(SUM(tokens_out), 0) AS tokensOut,
             IFNULL(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors
      FROM usage_events ${where}
    `).get(...params) as any

    const daily = this.db.prepare(`
      SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
             IFNULL(SUM(tokens_in), 0) AS tokensIn,
             IFNULL(SUM(tokens_out), 0) AS tokensOut,
             COUNT(*) AS requests
      FROM usage_events ${where}
      GROUP BY day ORDER BY day ASC
    `).all(...params) as any[]

    const recent = this.db.prepare(`
      SELECT id, category, name, sub, session_id, started_at, duration_ms, tokens_in, tokens_out, ok, error
      FROM usage_events ORDER BY started_at DESC LIMIT 50
    `).all() as any[]

    return {
      totals: {
        requests: totals.requests,
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        errors: totals.errors,
      },
      daily: daily.map((d) => ({ day: d.day, tokensIn: d.tokensIn, tokensOut: d.tokensOut, requests: d.requests })),
      byModel: this.usageRank('llm', cutoff),
      skills: this.usageRank('skill', cutoff),
      subagents: this.usageRank('subagent', cutoff),
      mcp: this.usageRank('mcp', cutoff),
      recent: recent.map((r) => ({
        id: r.id,
        category: r.category,
        name: r.name,
        sub: r.sub || '',
        sessionId: r.session_id,
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        ok: r.ok !== 0,
        error: r.error || '',
      })),
    }
  }

  clearUsageEvents(): void {
    this.db.exec('DELETE FROM usage_events')
  }

  // ───────────────────── LLM response cache ─────────────────────
  /** Max entries kept in the cache; the least-recently-accessed are evicted on insert beyond this. */
  private static readonly CACHE_MAX_ENTRIES = 5000

  getResponseCache(key: string): { response: string; tokensIn: number; tokensOut: number } | null {
    const row = this.db.prepare(
      'SELECT response, tokens_in, tokens_out FROM llm_response_cache WHERE key = ?'
    ).get(key) as any
    if (!row) return null
    this.db.prepare('UPDATE llm_response_cache SET hits = hits + 1, last_accessed_at = ? WHERE key = ?').run(Date.now(), key)
    return {
      response: row.response,
      tokensIn: row.tokens_in || 0,
      tokensOut: row.tokens_out || 0,
    }
  }

  /** Insert (or refresh) a cache entry; evict the least-recently-accessed when over capacity. */
  putResponseCache(key: string, provider: string, model: string, response: string, tokensIn: number, tokensOut: number): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO llm_response_cache (key, provider, model, response, tokens_in, tokens_out, created_at, last_accessed_at, hits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET
        response = excluded.response,
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        created_at = excluded.created_at,
        last_accessed_at = excluded.last_accessed_at
    `).run(key, provider, model, response, tokensIn, tokensOut, now, now)

    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM llm_response_cache').get() as any).c as number
    if (count > SQLiteStore.CACHE_MAX_ENTRIES) {
      const excess = count - SQLiteStore.CACHE_MAX_ENTRIES
      this.db.prepare(
        'DELETE FROM llm_response_cache WHERE key IN (SELECT key FROM llm_response_cache ORDER BY last_accessed_at ASC LIMIT ?)'
      ).run(excess)
    }
  }

  clearResponseCache(): void {
    this.db.exec('DELETE FROM llm_response_cache')
  }

  resetAll(): void {
    this.db.exec('DELETE FROM chat_messages')
    this.db.exec('DELETE FROM chat_sessions')
    this.db.exec('DELETE FROM api_config_groups')
    this.db.exec('DELETE FROM user_preferences')
    this.db.exec('DELETE FROM memories')
    this.db.exec('DELETE FROM checkpoints')
    this.db.exec('DELETE FROM reverted_files')
    this.db.exec('DELETE FROM workflows')
    this.db.exec('DELETE FROM usage_events')
  }

  private closed = false

  close(): void {
    // Idempotent — close() is called from both window-all-closed and will-quit
    // on some platforms; better-sqlite3 throws on a double close.
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
