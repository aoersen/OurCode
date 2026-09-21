import { describe, it, expect, vi } from 'vitest'
import { ToolExecutor } from '../services/tools/ToolExecutor'

/**
 * MCP approval gating. An MCP server executes third-party code the user
 * installed, so its tools are approval-gated like any other side effect; only
 * servers that run the app's own packaged code skip the dialog (otherwise the
 * bundled git MCP would nag on every status check).
 */
const electronAPI = {
  mcpToolDefinitions: vi.fn(async () => []),
  mcpStatus: vi.fn(async () => [
    { name: 'git', state: 'ready' as const, bundled: true },
    { name: 'playwright', state: 'ready' as const, bundled: false },
    { name: 'stitch', state: 'ready' as const },
  ]),
}

vi.stubGlobal('window', { electronAPI })

async function executor(): Promise<ToolExecutor> {
  const ex = new ToolExecutor()
  await ex.refreshMcpTools()
  return ex
}

describe('ToolExecutor.requiresApproval for MCP tools', () => {
  it('exempts only app-shipped servers', async () => {
    const ex = await executor()
    expect(ex.requiresApproval('mcp__git__git_status')).toBe(false)
    expect(ex.requiresApproval('mcp__playwright__browser_click')).toBe(true)
    // A status entry that never says it is bundled is not bundled.
    expect(ex.requiresApproval('mcp__stitch__do_thing')).toBe(true)
  })

  it('gates on the server, not on a name that merely looks like one', async () => {
    const ex = await executor()
    // No '__' after the prefix: the whole remainder is the server name.
    expect(ex.requiresApproval('mcp__git')).toBe(false)
    // Server names are matched up to the first separator, same as usage stats.
    expect(ex.requiresApproval('mcp__git__nested__deep')).toBe(false)
    expect(ex.requiresApproval('mcp__notgit__x')).toBe(true)
  })

  it('loses the exemption when status cannot be read', async () => {
    electronAPI.mcpStatus.mockRejectedValueOnce(new Error('bridge gone'))
    const ex = new ToolExecutor()
    await ex.refreshMcpTools()
    expect(ex.requiresApproval('mcp__git__git_status')).toBe(true)
  })

  it('leaves built-in tools to their own metadata', async () => {
    const ex = await executor()
    expect(ex.requiresApproval('run_command')).toBe(true)
    expect(ex.requiresApproval('read_file')).toBe(false)
  })
})
