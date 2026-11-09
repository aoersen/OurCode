import { describe, expect, it } from 'vitest'
import {
  addMcpEntry,
  mcpCounts,
  mcpDetailLines,
  mcpEntryState,
  mcpFileLabel,
  mcpStateWord,
  mcpSummary,
  mcpTransport,
  mergeMcpServers,
  parseMcpEntryForm,
  removeMcpEntry,
  setMcpEntryDisabled,
  type McpServerMap,
  type McpStatusItem,
} from '@/shell/agent/surfaces/mcp/mcpModel'

const project: McpServerMap = {
  github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' } },
}
const global: McpServerMap = {
  github: { command: 'node', args: ['old.js'] },
  filesystem: { command: 'npx', args: ['server-fs', '/tmp'] },
  remote: { serverUrl: 'http://localhost:3001/mcp', headers: { Authorization: 'Bearer t' } },
}

const status: McpStatusItem[] = [
  { name: 'github', state: 'ready' },
  { name: 'filesystem', state: 'failed', error: 'boom', retry: 2 },
  { name: 'remote', state: 'stopped' },
]

describe('mcpModel · 传输与状态词', () => {
  it('有 serverUrl/url 就是 http，否则 stdio', () => {
    expect(mcpTransport({ command: 'npx' })).toBe('stdio')
    expect(mcpTransport({ serverUrl: 'http://a/b' })).toBe('http')
    expect(mcpTransport({ url: 'http://a/b' })).toBe('http')
  })

  it('状态词覆盖六种状态', () => {
    expect(mcpStateWord('ready')).toBe('已就绪')
    expect(mcpStateWord('connecting')).toBe('连接中')
    expect(mcpStateWord('restarting')).toBe('重启中')
    expect(mcpStateWord('failed')).toBe('连接失败')
    expect(mcpStateWord('disabled')).toBe('已停用')
    expect(mcpStateWord('stopped')).toBe('未启动')
  })

  it('配置里的 disabled 压过运行时状态', () => {
    expect(mcpEntryState({ disabled: true }, { name: 'x', state: 'ready' })).toBe('disabled')
    expect(mcpEntryState({}, { name: 'x', state: 'ready' })).toBe('ready')
    expect(mcpEntryState({})).toBe('stopped')
  })

  it('summary 拼命令或取 URL', () => {
    expect(mcpSummary({ command: 'npx', args: ['-y', 'pkg'] })).toBe('npx -y pkg')
    expect(mcpSummary({ serverUrl: 'http://localhost:3001/mcp' })).toBe('http://localhost:3001/mcp')
  })
})

describe('mcpModel · 两级合并', () => {
  it('项目同名条目覆盖全局，并统计被覆盖数', () => {
    const merged = mergeMcpServers({
      project,
      global,
      status,
      projectFile: 'E:\\proj\\mcp_config.json',
      globalFile: 'C:\\userData\\mcp_config.json',
    })
    expect(merged.shadowed).toBe(1)
    expect(merged.rows.map((row) => row.name)).toEqual(['github', 'filesystem', 'remote'])
    expect(merged.rows[0].scope).toBe('project')
    expect(merged.rows[0].entry.command).toBe('npx')
    expect(merged.rows[1].scope).toBe('global')
    expect(merged.rows[1].state).toBe('failed')
    expect(merged.rows[1].error).toBe('boom')
    expect(merged.rows[2].transport).toBe('http')
    expect(merged.rows[2].file).toBe('C:\\userData\\mcp_config.json')
  })

  it('没有项目层时全是全局行，shadowed 为 0', () => {
    const merged = mergeMcpServers({ project: {}, global, status: [], projectFile: null, globalFile: null })
    expect(merged.shadowed).toBe(0)
    expect(merged.rows).toHaveLength(3)
    expect(merged.rows.every((row) => row.scope === 'global')).toBe(true)
    expect(merged.rows[0].state).toBe('stopped')
  })

  it('统计就绪 / 失败 / 停用', () => {
    const merged = mergeMcpServers({ project, global, status, projectFile: null, globalFile: null })
    expect(mcpCounts(merged.rows)).toEqual({ total: 3, ready: 1, failed: 1, disabled: 0 })
  })
})

describe('mcpModel · 详情行', () => {
  it('stdio 展开 command / args / env', () => {
    expect(mcpDetailLines(project.github)).toEqual([
      { label: 'command', value: 'npx' },
      { label: 'args', value: '-y @modelcontextprotocol/server-github' },
      { label: 'env', value: 'GITHUB_TOKEN=x' },
    ])
  })

  it('http 展开 URL / headers', () => {
    expect(mcpDetailLines(global.remote)).toEqual([
      { label: 'URL', value: 'http://localhost:3001/mcp' },
      { label: 'headers', value: 'Authorization: Bearer t' },
    ])
  })

  it('停用工具单独一行', () => {
    const lines = mcpDetailLines({ command: 'x', disabledTools: ['a', 'b'] })
    expect(lines[lines.length - 1]).toEqual({ label: '停用工具', value: 'a, b' })
  })
})

describe('mcpModel · 表单与编辑', () => {
  it('stdio 表单解析 args 与 env', () => {
    const parsed = parseMcpEntryForm({
      name: ' github ',
      transport: 'stdio',
      command: 'npx',
      args: ' -y  pkg ',
      url: '',
      envText: 'TOKEN=abc\nBAD_LINE\n',
      headersText: '',
    })
    expect('entry' in parsed && parsed.name).toBe('github')
    expect('entry' in parsed ? parsed.entry : null).toEqual({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'abc' },
    })
  })

  it('http 表单校验 URL，headers 用冒号解析', () => {
    const ok = parseMcpEntryForm({
      name: 'remote',
      transport: 'http',
      command: '',
      args: '',
      url: 'https://x/mcp',
      envText: '',
      headersText: 'Authorization: Bearer t\nX: y',
    })
    expect('entry' in ok ? ok.entry : null).toEqual({
      serverUrl: 'https://x/mcp',
      headers: { Authorization: 'Bearer t', X: 'y' },
    })
    expect(parseMcpEntryForm({
      name: 'remote', transport: 'http', command: '', args: '', url: 'ftp://x', envText: '', headersText: '',
    })).toEqual({ error: 'URL 需要以 http:// 或 https:// 开头' })
  })

  it('缺名字 / 缺命令给可读错误', () => {
    expect(parseMcpEntryForm({
      name: ' ', transport: 'stdio', command: 'x', args: '', url: '', envText: '', headersText: '',
    })).toEqual({ error: '先给服务器起个名字' })
    expect(parseMcpEntryForm({
      name: 's', transport: 'stdio', command: '', args: '', url: '', envText: '', headersText: '',
    })).toEqual({ error: '服务器「s」缺少启动命令' })
  })

  it('启停只改 disabled，其余字段保留；删除是纯移除', () => {
    const disabled = setMcpEntryDisabled(project, 'github', false)
    expect(disabled.github).toEqual({ ...project.github, disabled: true })
    expect(disabled.github.command).toBe('npx')
    const enabled = setMcpEntryDisabled(disabled, 'github', true)
    expect(enabled.github.disabled).toBeUndefined()
    expect(project.github.disabled).toBeUndefined()

    const added = addMcpEntry(project, 'new', { command: 'node' })
    expect(Object.keys(added)).toEqual(['github', 'new'])
    expect(Object.keys(removeMcpEntry(added, 'github'))).toEqual(['new'])
  })

  it('配置文件只展示文件名', () => {
    expect(mcpFileLabel('C:\\Users\\me\\AppData\\mcp_config.json')).toBe('mcp_config.json')
    expect(mcpFileLabel(null)).toBe('')
  })
})
