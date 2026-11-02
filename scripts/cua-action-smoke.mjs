#!/usr/bin/env node
/**
 * Action-level smoke test for the Computer Use helper (Windows).
 *
 * Launches its own WPF target window (probe/target-wpf.ps1), then drives it
 * through the helper's *write* path: set_value → element_perform_action(press)
 * → re-observe and read the label back. Read-only smoke (cua-smoke.mjs) proves
 * observation; this one proves actions, which is where a backend can silently
 * "succeed" without doing anything.
 *
 *   node scripts/cua-action-smoke.mjs            # native exe if built, else PS
 *   OURCODE_CUA_HELPER=ps node scripts/cua-action-smoke.mjs
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const winDir = join(here, '..', 'tools', 'cua-helper', 'win')
const probeTarget = join(here, '..', 'tools', 'cua-helper', 'probe', 'target-wpf.ps1')
const exePath = join(winDir, 'CuaHelper.exe')
const psPath = join(winDir, 'UiaBridge.ps1')
const wantPs = process.env.OURCODE_CUA_HELPER === 'ps'
const useExe = !wantPs && existsSync(exePath)
const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const helperCmd = useExe ? exePath : existsSync(ps) ? ps : 'powershell.exe'
const helperArgs = useExe ? [] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath]
console.log(`backend: ${useExe ? 'native (CuaHelper.exe)' : 'powershell (UiaBridge.ps1)'}`)

const suffix = String(Date.now() % 100000)
const windowTitle = `CUA Probe WPF ${suffix}`
const target = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeTarget, '-Suffix', suffix], {
  stdio: 'ignore',
})
const token = randomBytes(32).toString('hex')
const helper = spawn(helperCmd, helperArgs, { env: { ...process.env, OURCODE_CUA_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] })
helper.stdout.setEncoding('utf8')
helper.stderr.setEncoding('utf8')
helper.stderr.on('data', (chunk) => process.stderr.write(`[helper] ${chunk}`))

let buffer = ''
let nextId = 1
const pending = new Map()
helper.stdout.on('data', (chunk) => {
  buffer += chunk
  let nl = buffer.indexOf('\n')
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line) {
      const msg = JSON.parse(line)
      const waiter = pending.get(msg.id)
      if (waiter) {
        pending.delete(msg.id)
        msg.ok ? waiter.resolve(msg.result) : waiter.reject(new Error(`${msg.error?.code}: ${msg.error?.message}`))
      }
    }
    nl = buffer.indexOf('\n')
  }
})

function call(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)) }, 20_000)
    const waiter = pending.get(id)
    const done = (fn, v) => { clearTimeout(timer); fn(v) }
    waiter.resolve = (v) => done(resolve, v)
    waiter.reject = (e) => done(reject, e)
    helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  })
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : [])

try {
  await call('hello', { token, protocol: 'cua-ips/1', pid: process.pid })

  // Wait for the target window.
  let win = null
  for (let i = 0; i < 60 && !win; i++) {
    await new Promise((r) => setTimeout(r, 300))
    const { apps } = await call('list_apps')
    win = asArray(apps).find((a) => String(a.title ?? '').includes(windowTitle))
  }
  if (!win) throw new Error('target window not found')

  const state = await call('capture_app', { app: { pid: win.pid, windowId: win.windowId }, maxNodes: 200 })
  const elements = asArray(state.elements)
  const input = elements.find((e) => e.automationId === 'probeInput')
  const submit = elements.find((e) => e.automationId === 'probeSubmit')
  const echo = elements.find((e) => e.automationId === 'probeEcho')
  if (!input || !submit || !echo) throw new Error('probe elements missing')

  await call('set_value', { app: { pid: win.pid, windowId: win.windowId }, elementIndex: input.index, value: 'action-smoke' })
  await call('element_perform_action', { app: { pid: win.pid, windowId: win.windowId }, elementIndex: submit.index, action: 'press' })
  await new Promise((r) => setTimeout(r, 400))

  const after = await call('capture_app', { app: { pid: win.pid, windowId: win.windowId }, maxNodes: 200 })
  const echoAfter = asArray(after.elements).find((e) => e.automationId === 'probeEcho')
  const text = String(echoAfter?.name ?? '')
  console.log(`set_value + press → echo="${text}"`)
  if (!text.includes('action-smoke')) throw new Error('action did not reach the app')

  await call('shutdown')
  helper.stdin.end()
  console.log('action-smoke: OK')
} catch (error) {
  console.error('action-smoke: FAILED —', error.message)
  process.exitCode = 1
} finally {
  setTimeout(() => { try { helper.kill() } catch {} ; try { target.kill() } catch {} }, 300)
}
