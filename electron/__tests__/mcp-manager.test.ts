import { describe, it, expect, afterAll } from 'vitest'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { MCPManager, extractMcpText, isBundledServerConfig, toMcpToolDefinition, shouldResetRetry } from '../services/mcp-manager'

const MOCK = join(__dirname, 'fixtures', 'mock-mcp-server.js')

/** Wait for an event (with a timeout) — rejects on failure. */
function waitForEvent<T>(emitter: MCPManager, event: string, timeoutMs: number, predicate?: (payload: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler)
      reject(new Error(`等待事件 "${event}" 超时`))
    }, timeoutMs)
    const handler = (payload: T) => {
      if (predicate && !predicate(payload)) return
      clearTimeout(timer)
      emitter.off(event, handler)
      resolve(payload)
    }
    emitter.on(event, handler)
  })
}

const tempRoots: string[] = []

function makeConfigDir(name: string, serverOverrides: Record<string, any> = {}): string {
  const dir = join(__dirname, 'fixtures', `mcp-config-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  mkdirSync(dir, { recursive: true })
  tempRoots.push(dir)
  const config = {
    mcpServers: {
      mock: {
        command: process.execPath,
        args: [MOCK],
        env: { MOCK_MCP_SILENT: '0' },
        ...serverOverrides,
      },
    },
  }
  writeFileSync(join(dir, 'mcp_config.json'), JSON.stringify(config, null, 2), 'utf-8')
  return dir
}

afterAll(async () => {
  // Stop servers BEFORE deleting their cwd dirs — on Windows a live child
  // process holds the directory (cwd lock), making rmSync fail silently.
  // (Single afterAll: vitest runs hooks in registration order, so a separate
  // cleanup hook would run before stopAll.)
  for (const m of managers) m.stopAll()
  await new Promise((r) => setTimeout(r, 100))
  for (const dir of tempRoots) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
  }
})

const managers: MCPManager[] = []

function track(m: MCPManager): MCPManager {
  managers.push(m)
  return m
}

const fastManager = () =>
  track(new MCPManager({ requestTimeoutMs: 2_000, restart: { baseDelayMs: 50, maxRetries: 3 } }))

describe('MCPManager (stdio transport)', () => {
  it('performs the handshake and lists tools', async () => {
    const mcp = fastManager()
    const ready = waitForEvent(mcp, 'ready', 5_000)
    await mcp.loadConfig(makeConfigDir('basic'))
    await ready

    const tools = await mcp.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'fail_tool', 'secret_tool'])
    expect(tools.find((t) => t.name === 'echo')?.server).toBe('mock')
  })

  it('filters disabledTools from the tool list', async () => {
    const mcp = fastManager()
    const ready = waitForEvent(mcp, 'ready', 5_000)
    await mcp.loadConfig(makeConfigDir('disabled', { disabledTools: ['secret_tool'] }))
    await ready

    const tools = await mcp.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'fail_tool'])
  })

  it('calls a tool and surfaces error results as rejected promises', async () => {
    const mcp = fastManager()
    const ready = waitForEvent(mcp, 'ready', 5_000)
    await mcp.loadConfig(makeConfigDir('calls'))
    await ready

    const result = await mcp.callTool('mock', 'echo', { text: 'hi' })
    expect(extractMcpText(result)).toBe('echo:hi')

    await expect(mcp.callTool('mock', 'fail_tool', {})).rejects.toThrow('故意失败')
  })

  it('exposes resources and prompts', async () => {
    const mcp = fastManager()
    const ready = waitForEvent(mcp, 'ready', 5_000)
    await mcp.loadConfig(makeConfigDir('resources'))
    await ready

    const resources = await mcp.listResources()
    expect(resources).toHaveLength(1)
    expect(resources[0].uri).toBe('mock://greeting')

    const resource = await mcp.readResource('mock', 'mock://greeting')
    expect(extractMcpText(resource)).toContain('hello from mock')

    const prompts = await mcp.listPrompts()
    expect(prompts).toHaveLength(1)
    expect(prompts[0].name).toBe('greet')

    const prompt = await mcp.getPrompt('mock', 'greet', { who: 'world' })
    const text = JSON.stringify(prompt)
    expect(text).toContain('hello world')
  })

  it('auto-restarts a crashed server with backoff and re-readies', async () => {
    const mcp = fastManager()
    // The mock exits after handling 2 requests (initialize + one more)
    const ready = waitForEvent(mcp, 'ready', 5_000)
    await mcp.loadConfig(makeConfigDir('crash', { env: { MOCK_MCP_EXIT_AFTER: '2' } }))
    await ready

    // Trigger the crash: this listTools is the server's 2nd handled request
    const restarted = waitForEvent<{ server: string; restarted?: boolean }>(mcp, 'ready', 5_000, (p) => !!p.restarted)
    await mcp.listTools().catch(() => { /* may already be dead */ })
    const restartedInfo = await restarted
    expect(restartedInfo.server).toBe('mock')

    // The restarted connection is fully functional
    const tools = await mcp.listTools()
    expect(tools.map((t) => t.name)).toContain('echo')
  })

  it('gives up after maxRetries and emits failed', async () => {
    const mcp = track(new MCPManager({ requestTimeoutMs: 2_000, restart: { baseDelayMs: 10, maxRetries: 2 } }))
    const failed = waitForEvent<{ server: string; reason: string }>(mcp, 'failed', 10_000)
    await mcp.loadConfig(makeConfigDir('badcmd', { command: 'definitely-not-a-real-command-xyz' }))
    const info = await failed
    expect(info.server).toBe('mock')
    expect(info.reason).toMatch(/spawn|ENOENT|启动失败/)
  })

  it('times out unresponsive tools/call requests', async () => {
    const mcp = track(new MCPManager({ requestTimeoutMs: 300, restart: { baseDelayMs: 10, maxRetries: 1 } }))
    const ready = waitForEvent(mcp, 'ready', 5_000)
    await mcp.loadConfig(makeConfigDir('silent', { env: { MOCK_MCP_SILENT: '1' } }))
    await ready

    // listTools skips unresponsive servers (returns [])…
    expect(await mcp.listTools()).toEqual([])
    // …but a direct call surfaces the timeout
    await expect(mcp.callTool('mock', 'echo', {})).rejects.toThrow('超时')
  })

  it('stopAll kills children and suppresses restarts', async () => {
    const mcp = fastManager()
    const ready = waitForEvent(mcp, 'ready', 5_000)
    await mcp.loadConfig(makeConfigDir('stop'))
    await ready

    mcp.stopAll()
    expect(mcp.serverNames()).toEqual([])
    // Give a hypothetical restart timer a chance to fire — none should
    await new Promise((r) => setTimeout(r, 150))
    expect(mcp.serverNames()).toEqual([])
  })

  it('launches bundled servers with Electron-bundled Node (no system node)', async () => {
    // "bundled-node" spawns process.execPath with ELECTRON_RUN_AS_NODE=1, and
    // "bundled:" args resolve inside the configured bundled mcp-servers dir.
    const mcp = track(new MCPManager({
      requestTimeoutMs: 2_000,
      restart: { baseDelayMs: 50, maxRetries: 3 },
      bundledNodeDir: join(__dirname, 'fixtures'),
    }))
    const ready = waitForEvent(mcp, 'ready', 5_000)
    await mcp.loadConfig(makeConfigDir('bundled', { command: 'bundled-node', args: ['bundled:mock-mcp-server.js'] }))
    await ready

    const tools = await mcp.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'fail_tool', 'secret_tool'])
    expect(await mcp.callTool('mock', 'echo', { text: 'hi' }).then(extractMcpText)).toBe('echo:hi')
  })

  it('fails cleanly when bundled-node is used without a bundledNodeDir', async () => {
    const mcp = fastManager()
    const errors: string[] = []
    mcp.on('error', (e: Error) => errors.push(e.message))
    const failed = waitForEvent(mcp, 'failed', 5_000)
    await mcp.loadConfig(makeConfigDir('bundled-nodir', { command: 'bundled-node', args: ['bundled:mock-mcp-server.js'] }))
    await failed
    expect(errors.some((m) => m.includes('内置 mcp-servers 目录'))).toBe(true)
  })

  it('rejects bundled: paths that escape the bundled dir', async () => {
    const mcp = track(new MCPManager({
      requestTimeoutMs: 2_000,
      restart: { baseDelayMs: 50, maxRetries: 3 },
      bundledNodeDir: join(__dirname, 'fixtures'),
    }))
    const errors: string[] = []
    mcp.on('error', (e: Error) => errors.push(e.message))
    const failed = waitForEvent(mcp, 'failed', 5_000)
    await mcp.loadConfig(makeConfigDir('bundled-escape', { command: 'bundled-node', args: ['bundled:../escaped.js'] }))
    await failed
    expect(errors.some((m) => m.includes('路径越界'))).toBe(true)
  })

  it('allows bundled: filenames that begin with ".." (still inside the dir)', async () => {
    const mcp = track(new MCPManager({
      requestTimeoutMs: 2_000,
      restart: { baseDelayMs: 50, maxRetries: 3 },
      bundledNodeDir: join(__dirname, 'fixtures'),
    }))
    const errors: string[] = []
    mcp.on('error', (e: Error) => errors.push(e.message))
    const failed = waitForEvent(mcp, 'failed', 5_000)
    // "..mock-mcp-server.js" is a single filename inside the bundled dir (the
    // file doesn't exist, so the spawn itself fails) — it must NOT be treated
    // as a path escape like "../escaped.js" is.
    await mcp.loadConfig(makeConfigDir('bundled-dotdot', { command: 'bundled-node', args: ['bundled:..mock-mcp-server.js'] }))
    await failed
    expect(errors.some((m) => m.includes('路径越界'))).toBe(false)
    // The file doesn't exist, so the spawned runtime exits with code 1 — the
    // failure must come from the process itself, not from the path guard.
    expect(errors.some((m) => /进程退出|启动失败|spawn|ENOENT/.test(m))).toBe(true)
  })
})

describe('toMcpToolDefinition', () => {
  it('maps an MCP tool to an mcp__<server>__<name> function definition', () => {
    const def = toMcpToolDefinition({ server: 'git', name: 'git_status', description: '状态', inputSchema: { type: 'object', properties: {} } })
    expect(def.function.name).toBe('mcp__git__git_status')
    expect(def.function.description).toContain('MCP:git')
    expect(def.function.parameters).toEqual({ type: 'object', properties: {} })
  })
})

describe('MCP backoff-budget reset + stale tools', () => {
  afterEach(() => {
    for (const m of managers) m.stopAll()
    managers.length = 0
  })

  describe('shouldResetRetry', () => {
    const now = 1_000_000

    it('never resets for a server that never became ready (crash-loop)', () => {
      expect(shouldResetRetry(undefined, undefined, now)).toBe(false)
      expect(shouldResetRetry(undefined, now - 10, now)).toBe(false)
    })

    it('resets on the first death after a successful ready', () => {
      expect(shouldResetRetry(now - 5000, undefined, now)).toBe(true)
    })

    it('resets only after the stable window has passed since the last death', () => {
      // died 10s ago → still within the window → keep the retry budget
      expect(shouldResetRetry(now - 1000, now - 10_000, now, 60_000)).toBe(false)
      // died 90s ago → stable window passed → new outage → reset
      expect(shouldResetRetry(now - 1000, now - 90_000, now, 60_000)).toBe(true)
    })
  })

  describe('stale tool merge', () => {
    it('returns cached tools marked stale for a dead-but-configured server', async () => {
      const manager = new MCPManager()
      managers.push(manager)
      ;(manager as any).config = { mock: { command: 'x', args: [] } }
      ;(manager as any).lastKnownTools.set('mock', [
        { server: 'mock', name: 'toolA', description: 'd' },
      ])

      const tools = await manager.listTools()
      expect(tools).toContainEqual({ server: 'mock', name: 'toolA', description: 'd', stale: true })
    })

    it('does not merge stale tools for disabled or live servers', async () => {
      const manager = new MCPManager()
      managers.push(manager)
      ;(manager as any).config = { disabledSrv: { command: 'x', args: [], disabled: true } }
      ;(manager as any).lastKnownTools.set('disabledSrv', [{ server: 'disabledSrv', name: 't' }])

      const tools = await manager.listTools()
      expect(tools).toEqual([])
    })

    it('clears stale tools on stopAll (config reload / quit)', () => {
      const manager = new MCPManager()
      managers.push(manager)
      ;(manager as any).lastKnownTools.set('mock', [{ server: 'mock', name: 't' }])
      manager.stopAll()
      expect((manager as any).lastKnownTools.size).toBe(0)
    })
  })
})

describe('isBundledServerConfig — which MCP tools skip approval', () => {
  it('accepts only the app’s own runtime plus app-shipped entry points', () => {
    expect(isBundledServerConfig({ command: 'bundled-node', args: ['bundled:git-server/server.js'] })).toBe(true)
    // Anything else runs code this install did not ship.
    expect(isBundledServerConfig({ command: 'node', args: ['mcp-servers/git-server/server.js'] })).toBe(false)
    expect(isBundledServerConfig({ command: 'bundled-node', args: ['server.js'] })).toBe(false)
    expect(isBundledServerConfig({ command: 'bundled-node', args: ['bundled:../../evil.js'] })).toBe(true) // path escape is resolveStdio's job, not this gate's
    expect(isBundledServerConfig({ command: 'bundled-node', args: [] })).toBe(false)
    expect(isBundledServerConfig({ command: 'bundled-node' })).toBe(false)
    expect(isBundledServerConfig({ serverUrl: 'https://example.com/mcp' })).toBe(false)
    expect(isBundledServerConfig({ url: 'https://example.com/mcp' })).toBe(false)
    expect(isBundledServerConfig({})).toBe(false)
  })

  it('reports bundled per server through getStatus', () => {
    const manager = new MCPManager()
    ;(manager as any).config = {
      git: { command: 'bundled-node', args: ['bundled:git-server/server.js'] },
      thirdParty: { command: 'npx', args: ['some-mcp'] },
      off: { command: 'bundled-node', args: ['bundled:x.js'], disabled: true },
    }
    const byName = Object.fromEntries(manager.getStatus().map((s) => [s.name, s]))
    expect(byName.git.bundled).toBe(true)
    expect(byName.thirdParty.bundled).toBe(false)
    expect(byName.off.bundled).toBe(true)
    expect(byName.off.state).toBe('disabled')
    manager.stopAll()
  })
})

describe('MCPManager global config (two-tier merge)', () => {
  const mockServer = (overrides: Record<string, any> = {}) => ({
    command: process.execPath,
    args: [MOCK],
    env: { MOCK_MCP_SILENT: '0' },
    ...overrides,
  })

  const globalManager = (globalConfigPath: string) =>
    track(new MCPManager({ requestTimeoutMs: 2_000, restart: { baseDelayMs: 50, maxRetries: 3 }, globalConfigPath }))

  function emptyDir(name: string): string {
    const dir = join(__dirname, 'fixtures', `mcp-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
    mkdirSync(dir, { recursive: true })
    tempRoots.push(dir)
    return dir
  }

  function writeConfig(file: string, servers: Record<string, any>) {
    writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8')
  }

  it('loads global servers with no project open (rootPath "")', async () => {
    const dir = makeConfigDir('global-only')
    const mcp = globalManager(join(dir, 'mcp_config.json'))
    const ready = waitForEvent(mcp, 'ready', 5_000, (p: any) => p.server === 'mock')
    await mcp.loadConfig('')
    await ready
    expect(mcp.serverNames()).toEqual(['mock'])
    expect(mcp.getStatus().map((s) => s.name)).toEqual(['mock'])
  })

  it('merges both tiers and lets a same-name project entry override the global one', async () => {
    const globalDir = makeConfigDir('merge-global')
    writeConfig(join(globalDir, 'mcp_config.json'), {
      // 若错误地使用了全局配置，这个坏命令会立刻 failed；项目同名条目应胜出
      shared: { command: 'definitely-not-a-real-command-xyz' },
      globonly: mockServer(),
    })
    const projDir = makeConfigDir('merge-proj')
    writeConfig(join(projDir, 'mcp_config.json'), {
      shared: mockServer(),
      projonly: mockServer(),
    })
    const mcp = globalManager(join(globalDir, 'mcp_config.json'))
    const readyShared = waitForEvent(mcp, 'ready', 5_000, (p: any) => p.server === 'shared')
    const readyGlobonly = waitForEvent(mcp, 'ready', 5_000, (p: any) => p.server === 'globonly')
    await mcp.loadConfig(projDir)
    await readyShared
    await readyGlobonly
    expect(mcp.serverNames().sort()).toEqual(['globonly', 'projonly', 'shared'])
    expect(mcp.getStatus().map((s) => s.name).sort()).toEqual(['globonly', 'projonly', 'shared'])
    // 项目同名覆盖全局：shared 用的是项目的 mock（状态 ready），全局的坏命令从未执行
    expect(mcp.getStatus().find((s) => s.name === 'shared')!.state).toBe('ready')
  })

  it('keeps unchanged global servers connected across project switches (no re-handshake)', async () => {
    const globalDir = makeConfigDir('keep-global')
    writeConfig(join(globalDir, 'mcp_config.json'), { globonly: mockServer() })
    const projA = makeConfigDir('keep-a')
    writeConfig(join(projA, 'mcp_config.json'), { aonly: mockServer() })
    const projB = emptyDir('keep-b') // 没有任何配置文件的项目

    const mcp = globalManager(join(globalDir, 'mcp_config.json'))
    let globonlyReadyCount = 0
    mcp.on('ready', (p: any) => { if (p.server === 'globonly') globonlyReadyCount++ })

    const until = async (cond: () => boolean, timeoutMs: number): Promise<void> => {
      const start = Date.now()
      while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error('条件等待超时')
        await new Promise((r) => setTimeout(r, 25))
      }
    }

    await mcp.loadConfig(projA)
    // globonly 与 aonly 的握手完成顺序不定 — 轮询等待计数，而不是等某个事件
    await until(() => globonlyReadyCount >= 1, 5_000)

    await mcp.loadConfig(projB)
    // 给足时间：若全局连接被错误地拆除重连，ready 会再次触发
    await new Promise((r) => setTimeout(r, 500))
    expect(globonlyReadyCount).toBe(1)
    expect(mcp.serverNames()).toEqual(['globonly'])
    expect(mcp.getStatus().find((s) => s.name === 'globonly')!.state).toBe('ready')
  })

  it('loadGlobalConfig re-applies edits: removed servers are torn down, added ones connect', async () => {
    const dir = makeConfigDir('reload-global')
    const globalFile = join(dir, 'mcp_config.json')
    writeConfig(globalFile, { one: mockServer() })
    const mcp = globalManager(globalFile)
    await mcp.loadConfig('')
    await waitForEvent(mcp, 'ready', 5_000, (p: any) => p.server === 'one')

    writeConfig(globalFile, { two: mockServer() })
    await mcp.loadGlobalConfig()
    await waitForEvent(mcp, 'ready', 5_000, (p: any) => p.server === 'two')
    expect(mcp.serverNames()).toEqual(['two'])
    expect(mcp.getStatus().map((s) => s.name)).toEqual(['two'])
  })
})

describe('MCPManager reload retries failed servers', () => {
  it('a failed server re-attempts connection on the next loadConfig (manual 重试)', async () => {
    const mcp = track(new MCPManager({ requestTimeoutMs: 2_000, restart: { baseDelayMs: 10, maxRetries: 2 } }))
    const dir = makeConfigDir('retry-failed', { command: 'definitely-not-a-real-command-xyz' })
    const failed = waitForEvent<{ server: string }>(mcp, 'failed', 10_000)
    await mcp.loadConfig(dir)
    await failed
    expect(mcp.getStatus().find((s) => s.name === 'mock')!.state).toBe('failed')

    // 配置没有变化，但再次 loadConfig（面板「重试」/ 切项目回来）应重新发起
    // 连接尝试，而不是永远停在 failed 上等重启 IDE。
    const connecting = waitForEvent<{ server: string; state: string }>(mcp, 'status', 5_000, (p: any) => p.server === 'mock' && p.state === 'connecting')
    await mcp.loadConfig(dir)
    await connecting
  })
})
