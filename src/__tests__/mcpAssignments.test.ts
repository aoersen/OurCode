import { describe, it, expect, beforeEach, vi } from 'vitest'

// mcpAssignments 有模块级 mtime 缓存：每个用例 resetModules + 动态 import，
// 保证缓存状态不跨用例泄漏。
const root = 'C:/proj'
const cfgPath = `${root}/.ourcode/company.json`

function makeApi() {
  const state = { content: null as string | null, mtime: 1000 }
  const api = {
    stat: vi.fn(async (p: string) =>
      p === cfgPath && state.content !== null
        ? { size: 1, isFile: true, isDirectory: false, createdAt: 1, modifiedAt: state.mtime }
        : null),
    readFile: vi.fn(async (p: string) => {
      if (p !== cfgPath || state.content === null) throw new Error('ENOENT')
      return { content: state.content, encoding: 'utf-8' }
    }),
    writeFile: vi.fn(async (p: string, content: string) => {
      state.content = content
      state.mtime += 1
    }),
    createDir: vi.fn(async () => {}),
    mcpStatus: vi.fn(async () => [
      { name: 'aioli', state: 'ready' },
      { name: 'playwright', state: 'ready' },
    ]),
  }
  return { api, state }
}

describe('mcpAssignments — 有效授权解析', () => {
  let mock: ReturnType<typeof makeApi>

  beforeEach(() => {
    mock = makeApi()
    vi.resetModules()
    vi.stubGlobal('window', { electronAPI: mock.api })
  })

  const mod = () => import('@/services/company/mcpAssignments')

  it('没有 company.json → 默认档 all（未分配角色可用全部，含未来新装）', async () => {
    const m = await mod()
    const resolved = await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-developer' })
    expect(resolved.grant).toBe('all')
    expect(resolved.namedServers).toEqual([])
  })

  it('roles 覆盖 default；未列出的角色吃 default 清单', async () => {
    mock.state.content = JSON.stringify({
      mcp: { default: ['git', 'aioli'], roles: { 'tm-ui-developer': ['aioli'] } },
    })
    const m = await mod()
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-ui-developer' })).grant).toEqual(['aioli'])
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-developer' })).grant).toEqual(['git', 'aioli'])
  })

  it('并集只增不减：任一侧为 all → all；两侧清单去重合并', async () => {
    mock.state.content = JSON.stringify({ mcp: { roles: { 'tm-ui-developer': ['aioli'] } } })
    const m = await mod()
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-ui-developer', defMcp: ['aioli', 'playwright'] })).grant)
      .toEqual(['aioli', 'playwright'])
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-ui-developer', defMcp: ['all'] })).grant).toBe('all')
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-developer', defMcp: ['all'] })).grant).toBe('all')
  })

  it('namedServers 含生效授权点名的服务器与 mcpDeny 排除名（对账用）', async () => {
    mock.state.content = JSON.stringify({ mcp: { roles: { 'tm-ui-developer': ['aioli', 'ghost'] } } })
    const m = await mod()
    const resolved = await m.resolveWorkerMcpGrant({
      projectPath: root, role: 'tm-ui-developer', defMcpDeny: ['stitch'],
    })
    expect(resolved.namedServers).toEqual(['aioli', 'ghost', 'stitch'])
  })

  it('归一化：含 all 的数组 → all；空数组 → 未声明 → 落 default', async () => {
    mock.state.content = JSON.stringify({
      mcp: { default: ['all'], roles: { 'tm-developer': [] } },
    })
    const m = await mod()
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-ui-developer' })).grant).toBe('all')
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-developer' })).grant).toBe('all')
  })

  it('损坏的 JSON 按空配置处理（默认档 all 兜底），不让员工体系瘫掉', async () => {
    mock.state.content = '{not json'
    const m = await mod()
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-developer' })).grant).toBe('all')
  })

  it('mtime 缓存：文件未变时不再读文件，变化后读到新配置', async () => {
    mock.state.content = JSON.stringify({ mcp: { roles: { 'tm-developer': ['aioli'] } } })
    const m = await mod()
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-developer' })).grant).toEqual(['aioli'])
    const readsAfterFirst = mock.api.readFile.mock.calls.length
    await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-developer' })
    expect(mock.api.readFile.mock.calls.length).toBe(readsAfterFirst)
    mock.state.content = JSON.stringify({ mcp: { roles: { 'tm-developer': 'all' } } })
    mock.state.mtime += 1
    expect((await m.resolveWorkerMcpGrant({ projectPath: root, role: 'tm-developer' })).grant).toBe('all')
  })
})

describe('mcpAssignments — 对账与告警', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  const mod = () => import('@/services/company/mcpAssignments')

  it('缺失名单 = 点名 − 目录；全命中为空；mcpStatus 抛错不误报', async () => {
    const m = await mod()
    const ok = makeApi()
    vi.stubGlobal('window', { electronAPI: ok.api })
    expect(await m.reconcileMcpGrantServers({ projectPath: root, namedServers: ['aioli', 'ghost'] })).toEqual(['ghost'])
    expect(await m.reconcileMcpGrantServers({ projectPath: root, namedServers: ['aioli'] })).toEqual([])

    const broken = makeApi()
    broken.api.mcpStatus = vi.fn(async () => { throw new Error('boom') })
    vi.stubGlobal('window', { electronAPI: broken.api })
    expect(await m.reconcileMcpGrantServers({ projectPath: root, namedServers: ['ghost'] })).toEqual([])

    vi.stubGlobal('window', { electronAPI: ok.api })
    expect(await m.reconcileMcpGrantServers({ projectPath: root, namedServers: [] })).toEqual([])
  })

  it('buildMcpGrantWarning：空名单返回空串；缺失时产出含服务器名的告警块', async () => {
    const m = await mod()
    expect(m.buildMcpGrantWarning([])).toBe('')
    const warn = m.buildMcpGrantWarning(['ghost'])
    expect(warn).toContain('<mcp_grant_warning>')
    expect(warn).toContain('ghost')
  })
})

describe('mcpAssignments — saveCompanyMcpConfig（看板保存）', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  const mod = () => import('@/services/company/mcpAssignments')

  it('建父目录、保留其它顶层键、写回后立即可读（缓存失效）', async () => {
    const mock2 = makeApi()
    mock2.state.content = JSON.stringify({ other: 1, mcp: { default: ['x'] } })
    vi.stubGlobal('window', { electronAPI: mock2.api })
    const m = await mod()

    await m.saveCompanyMcpConfig(root, { default: 'all', roles: { 'tm-ui-developer': ['aioli'] } })
    expect(mock2.api.createDir).toHaveBeenCalledWith(`${root}/.ourcode`)

    const written = JSON.parse(mock2.state.content!)
    expect(written.other).toBe(1)
    expect(written.mcp.default).toBe('all')
    expect(written.mcp.roles['tm-ui-developer']).toEqual(['aioli'])

    // 写后缓存已失效：不依赖旧 mtime，读回即新值
    const cfg = await m.loadCompanyMcpConfig(root)
    expect(cfg.default).toBe('all')
    expect(cfg.roles?.['tm-ui-developer']).toEqual(['aioli'])
  })
})
