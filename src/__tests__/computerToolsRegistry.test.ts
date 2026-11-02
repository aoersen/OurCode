import { describe, it, expect } from 'vitest'
import { createToolRegistry } from '../services/tools/ToolRegistry'
import { ToolExecutor } from '../services/tools/ToolExecutor'

const COMPUTER_TOOLS = [
  'computer_list_apps',
  'computer_get_state',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_set_value',
  'computer_scroll',
  'computer_drag',
  'computer_screenshot',
  'computer_launch_app',
  'computer_run_steps',
  'computer_stop',
]

const READ_TOOLS = new Set(['computer_list_apps', 'computer_get_state', 'computer_screenshot'])
const ALWAYS_FREE = new Set(['computer_stop'])

describe('computer_* tool definitions', () => {
  it('registers exactly the 12 documented tools', () => {
    const tools = createToolRegistry().map((t) => t.name)
    expect(tools.filter((name) => name.startsWith('computer_'))).toEqual(COMPUTER_TOOLS)
  })

  it('keeps every schema a closed object', () => {
    for (const tool of createToolRegistry().filter((t) => t.name.startsWith('computer_'))) {
      expect(tool.parameters.type).toBe('object')
      expect(Array.isArray(tool.parameters.required)).toBe(true)
      expect(tool.parameters.additionalProperties).toBe(false)
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })

  it('marks desktop writes as approval-gated and reads/stops as free', () => {
    const executor = new ToolExecutor()
    for (const name of COMPUTER_TOOLS) {
      const expected = !READ_TOOLS.has(name) && !ALWAYS_FREE.has(name)
      expect({ name, approval: executor.requiresApproval(name) }).toEqual({ name, approval: expected })
    }
  })
})
