import { describe, it, expect } from 'vitest'
import { createToolRegistry, toToolDefinitions } from '../services/tools/ToolRegistry'
import { ToolExecutor } from '../services/tools/ToolExecutor'

describe('ToolRegistry', () => {
  it('should create a non-empty tool list', () => {
    const tools = createToolRegistry()
    expect(tools.length).toBeGreaterThan(0)
  })

  it('should have unique tool names', () => {
    const tools = createToolRegistry()
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('should have all required fields on each tool', () => {
    const tools = createToolRegistry()
    for (const tool of tools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.parameters).toBeTruthy()
      expect(tool.parameters.type).toBe('object')
      expect(tool.parameters.properties).toBeTruthy()
      expect(tool.parameters.required).toBeInstanceOf(Array)
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('should mark write tools as requiring approval', () => {
    const tools = createToolRegistry()
    const writeTools = ['write_file', 'edit_file', 'multi_edit_file', 'create_directory', 'delete_file', 'run_command']
    const readTools = ['read_file', 'read_multiple_files', 'list_directory', 'get_directory_tree', 'search_files', 'search_in_files']

    for (const name of writeTools) {
      const tool = tools.find((t) => t.name === name)
      expect(tool).toBeTruthy()
      expect(tool!.requiresApproval).toBe(true)
    }

    for (const name of readTools) {
      const tool = tools.find((t) => t.name === name)
      expect(tool).toBeTruthy()
      expect(tool!.requiresApproval).toBeFalsy()
    }
  })

  it('declares replaceAll on edit_file and per-edit replaceAll on multi_edit_file', () => {
    const tools = createToolRegistry()
    const edit = tools.find((t) => t.name === 'edit_file')!
    expect(edit.parameters.properties).toHaveProperty('replaceAll')

    const multi = tools.find((t) => t.name === 'multi_edit_file')!
    expect(multi.parameters.required).toEqual(['edits'])
    const editItems = multi.parameters.properties.edits.items.properties
    expect(editItems).toHaveProperty('replaceAll')
    expect(editItems).toHaveProperty('path')
  })

  it('should convert to OpenAI tool definitions format', () => {
    const tools = createToolRegistry()
    const defs = toToolDefinitions(tools)

    expect(defs.length).toBe(tools.length)

    for (const def of defs) {
      expect(def.type).toBe('function')
      expect(def.function.name).toBeTruthy()
      expect(def.function.description).toBeTruthy()
      expect(def.function.parameters).toBeTruthy()
    }
  })

  it('registers cross-session messaging tools without requiring approval', () => {
    const tools = createToolRegistry()
    const listAgents = tools.find((t) => t.name === 'list_agents')
    const sendMessage = tools.find((t) => t.name === 'send_message')

    expect(listAgents).toBeTruthy()
    expect(sendMessage).toBeTruthy()
    expect(listAgents!.requiresApproval).toBeFalsy()
    expect(sendMessage!.requiresApproval).toBeFalsy()
    // send_message must declare the message payload as required
    expect(sendMessage!.parameters.required).toEqual(['message'])
    // target resolution accepts either id or title
    expect(sendMessage!.parameters.properties).toHaveProperty('targetSessionId')
    expect(sendMessage!.parameters.properties).toHaveProperty('targetTitle')
  })

  it('registers native git tools with the mainstream approval policy', () => {
    const tools = createToolRegistry()
    const names = new Set(tools.map((t) => t.name))
    const readOnly = ['git_status', 'git_diff', 'git_log', 'git_branch']
    // git_add 可逆 → 免审批；git_commit / git_push 写历史/对外发布 → 需审批
    expect(names.has('git_add')).toBe(true)
    expect(names.has('git_commit')).toBe(true)
    expect(names.has('git_push')).toBe(true)

    for (const name of readOnly) {
      const tool = tools.find((t) => t.name === name)
      expect(tool, name).toBeTruthy()
      expect(tool!.requiresApproval, name).toBeFalsy()
    }
    expect(tools.find((t) => t.name === 'git_add')!.requiresApproval).toBeFalsy()
    expect(tools.find((t) => t.name === 'git_commit')!.requiresApproval).toBe(true)
    expect(tools.find((t) => t.name === 'git_push')!.requiresApproval).toBe(true)
    // 命名避开 mcp__ / skill__ 前缀（否则会被 execute 的动态工具分支劫持）
    for (const name of readOnly) expect(name.startsWith('mcp__')).toBe(false)
  })

  it('registers browser tools, with approval only for the one that mutates the page', () => {
    const tools = createToolRegistry()
    const byName = (name: string) => tools.find((t) => t.name === name)
    for (const name of ['browser_navigate', 'browser_read_console', 'browser_screenshot', 'browser_act']) {
      expect(byName(name), name).toBeTruthy()
    }
    // 读页面/看控制台/截图不改动任何东西；点击与输入可能改动远端状态 → 要审批
    expect(byName('browser_navigate')!.requiresApproval).toBeFalsy()
    expect(byName('browser_read_console')!.requiresApproval).toBeFalsy()
    expect(byName('browser_screenshot')!.requiresApproval).toBeFalsy()
    expect(byName('browser_act')!.requiresApproval).toBe(true)
    expect(byName('browser_act')!.parameters.properties.action.enum).toEqual([
      'click', 'type', 'press', 'scroll', 'wait',
    ])
  })

  it('registers PR tools split by read vs write', () => {
    const tools = createToolRegistry()
    const byName = (name: string) => tools.find((t) => t.name === name)
    expect(byName('read_pull_request')!.requiresApproval).toBeFalsy()
    expect(byName('create_pull_request')!.requiresApproval).toBe(true)
    expect(byName('read_pull_request')!.parameters.properties.action.enum).toEqual(['list', 'view'])
    expect(byName('create_pull_request')!.parameters.properties.action.enum).toEqual(['create', 'comment'])
  })
})

describe('ToolExecutor', () => {
  it('should return all tools', () => {
    const executor = new ToolExecutor()
    const tools = executor.getTools()
    expect(tools.length).toBeGreaterThan(0)
  })

  it('should return tool definitions', () => {
    const executor = new ToolExecutor()
    const defs = executor.getToolDefinitions()
    expect(defs.length).toBe(executor.getTools().length)
  })

  it('should correctly identify tools requiring approval', () => {
    const executor = new ToolExecutor()

    expect(executor.requiresApproval('write_file')).toBe(true)
    expect(executor.requiresApproval('edit_file')).toBe(true)
    expect(executor.requiresApproval('delete_file')).toBe(true)
    expect(executor.requiresApproval('run_command')).toBe(true)
    expect(executor.requiresApproval('read_file')).toBe(false)
    expect(executor.requiresApproval('list_directory')).toBe(false)
    expect(executor.requiresApproval('unknown_tool')).toBe(false)
  })

  it('should return error for unknown tool', async () => {
    const executor = new ToolExecutor()
    const result = await executor.execute({
      id: 'call-1',
      name: 'nonexistent_tool',
      arguments: {},
    })

    expect(result.isError).toBe(true)
    expect(result.result).toContain('Unknown tool')
  })

  it('should generate preview for write_file', () => {
    const executor = new ToolExecutor()
    const preview = executor.getPreview({
      id: 'call-1',
      name: 'write_file',
      arguments: { path: '/test/file.txt', content: 'Hello World' },
    })

    expect(preview).toContain('/test/file.txt')
    expect(preview).toContain('11 chars')
  })

  it('should generate preview for run_command', () => {
    const executor = new ToolExecutor()
    const preview = executor.getPreview({
      id: 'call-1',
      name: 'run_command',
      arguments: { command: 'npm test', cwd: '/project' },
    })

    expect(preview).toContain('npm test')
    expect(preview).toContain('/project')
  })

  it('should generate friendly previews for git tools', () => {
    const executor = new ToolExecutor()
    const commit = executor.getPreview({ id: 'c', name: 'git_commit', arguments: { message: 'feat: 拆分提交' } })
    expect(commit).toContain('git commit -m')
    expect(commit).toContain('feat: 拆分提交')

    const add = executor.getPreview({ id: 'c', name: 'git_add', arguments: { path: 'src/a.ts' } })
    expect(add).toContain('git add -- src/a.ts')

    const addAll = executor.getPreview({ id: 'c', name: 'git_add', arguments: {} })
    expect(addAll).toContain('git add -A')

    const push = executor.getPreview({ id: 'c', name: 'git_push', arguments: { remote: 'origin', branch: 'main' } })
    expect(push).toContain('origin main')
  })

  it('hides bundled git MCP tools shadowed by native git tools', async () => {
    const executor = new ToolExecutor()
    // 模拟已连接内置 git MCP（mcp__git__*）
    await executor.refreshMcpTools()
    // refreshMcpTools 走 IPC，测试环境拿不到 → 手工注入同形状的 dynamicTools
    ;(executor as any).dynamicTools = [
      { type: 'function', function: { name: 'mcp__git__git_status', description: '', parameters: {} } },
      { type: 'function', function: { name: 'mcp__git__git_diff', description: '', parameters: {} } },
      // 自定义的、原生没有的 MCP 工具应保留
      { type: 'function', function: { name: 'mcp__git__git_stash', description: '', parameters: {} } },
      { type: 'function', function: { name: 'mcp__other__custom', description: '', parameters: {} } },
    ]
    const names = executor.getToolDefinitions().map((d) => d.function.name)
    expect(names).not.toContain('mcp__git__git_status')
    expect(names).not.toContain('mcp__git__git_diff')
    expect(names).toContain('mcp__git__git_stash')
    expect(names).toContain('mcp__other__custom')
    // 原生 git 工具本身仍在
    expect(names).toContain('git_status')
    expect(names).toContain('git_diff')
  })

  it('should generate generic preview for unknown tool', () => {
    const executor = new ToolExecutor()
    const preview = executor.getPreview({
      id: 'call-1',
      name: 'custom_tool',
      arguments: { foo: 'bar' },
    })

    expect(preview).toContain('custom_tool')
  })

  it('should generate previews for the new batch tools', () => {
    const executor = new ToolExecutor()
    const multi = executor.getPreview({
      id: 'c',
      name: 'multi_edit_file',
      arguments: {
        edits: [
          { path: '/a.ts', oldText: 'x', newText: 'y' },
          { path: '/b.ts', oldText: 'z', newText: 'w' },
        ],
      },
    })
    expect(multi).toContain('批量编辑 2 处')
    expect(multi).toContain('/a.ts')

    const readMulti = executor.getPreview({
      id: 'c',
      name: 'read_multiple_files',
      arguments: { paths: ['/a.ts', '/b.ts'] },
    })
    expect(readMulti).toContain('Read 2 files')
  })
})
