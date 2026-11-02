import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CuaService } from '../services/computer-use/service'
import { FakeCuaBackend } from '../services/computer-use/fakeBackend'

let dir = ''
let fake: FakeCuaBackend
let prefs: Record<string, unknown>

function makeService() {
  return new CuaService({
    getBackend: async () => fake,
    getBackendStatus: () => ({ running: true, backend: 'fake', capabilities: ['fake'] }),
    getPrefs: () => prefs,
    frameDir: dir,
    auditFile: null,
    // No real waiting: settle becomes a tight loop against the fake desktop.
    sleep: async () => undefined,
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ourcode-cua-'))
  fake = new FakeCuaBackend(dir)
  prefs = { computerUseEnabled: true }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CuaService — observation', () => {
  it('returns full → no_change → delta', async () => {
    const svc = makeService()
    const first = await svc.getState({ owner: 's1', app: { name: '记事本' } })
    expect(first.mode).toBe('full')
    expect(first.elements.length).toBeGreaterThan(3)

    const second = await svc.getState({ owner: 's1', app: { name: '记事本' } })
    expect(second.mode).toBe('no_change')
    expect(second.baseStateId).toBe(first.stateId)

    const acted = await svc.act({ owner: 's1', app: { name: '记事本' }, kind: 'setValue', elementIndex: 3, value: '会议纪要' })
    // settle already re-observed, so the action result carries the delta state.
    expect(acted.state?.mode).toBe('delta')
    expect(acted.state?.elements.find((e) => e.index === 3)?.value).toBe('会议纪要')

    const third = await svc.getState({ owner: 's1', app: { name: '记事本' } })
    expect(third.mode).toBe('no_change')
    expect(third.elements.find((e) => e.index === 3)?.value).toBe('会议纪要')
  })

  it('refuses when the feature is off', async () => {
    prefs = { computerUseEnabled: false }
    const svc = makeService()
    await expect(svc.getState({ owner: 's1', app: { name: '记事本' } })).rejects.toMatchObject({
      info: { code: 'DISABLED' },
    })
  })

  it('blocks applications on the deny list before returning a tree', async () => {
    prefs = { computerUseEnabled: true, computerUseAppDenylist: ['记事本'] }
    const svc = makeService()
    await expect(svc.getState({ owner: 's1', app: { name: '记事本' } })).rejects.toMatchObject({
      info: { code: 'PERMISSION_DENIED' },
    })
  })

  it('filters blocked apps out of list_apps', async () => {
    prefs = { computerUseEnabled: true, computerUseAppDenylist: ['记事本'] }
    const svc = makeService()
    const res = await svc.listApps('s1')
    expect(res.ok).toBe(true)
    expect(res.apps.map((a) => a.name)).not.toContain('记事本')
    expect(res.blocked).toBeGreaterThan(0)
  })
})

describe('CuaService — actions', () => {
  it('setValue reports a changed effect and a fresh state', async () => {
    const svc = makeService()
    await svc.getState({ owner: 's1', app: { name: '记事本' } })
    const res = await svc.act({ owner: 's1', app: { name: '记事本' }, kind: 'setValue', elementIndex: 3, value: 'hi' })
    expect(res.ok).toBe(true)
    expect(res.actionSent).toBe(true)
    expect(res.effectEvidence).toBe('changed')
    expect(res.state?.elements.find((e) => e.index === 3)?.value).toBe('hi')
  })

  it('clicking a button that changes nothing reports unchanged', async () => {
    const svc = makeService()
    await svc.getState({ owner: 's1', app: { name: '记事本' } })
    const res = await svc.act({ owner: 's1', app: { name: '记事本' }, kind: 'click', elementIndex: 4 })
    expect(res.ok).toBe(true)
    expect(res.effectEvidence).toBe('unchanged')
  })

  it('requires the user to confirm a dangerous action', async () => {
    const svc = makeService()
    await svc.getState({ owner: 's1', app: { name: '文件资源管理器' } })
    const blocked = await svc.act({ owner: 's1', app: { name: '文件资源管理器' }, kind: 'click', elementIndex: 4 })
    expect(blocked.ok).toBe(false)
    expect(blocked.error?.code).toBe('PERMISSION_DENIED')
    expect(blocked.error?.details).toMatchObject({ requiresConfirm: true })

    const confirmed = await svc.act({
      owner: 's1',
      app: { name: '文件资源管理器' },
      kind: 'click',
      elementIndex: 4,
      confirm: true,
    })
    expect(confirmed.ok).toBe(true)
  })

  it('refuses coordinate clicks without a live screenshot frame', async () => {
    const svc = makeService()
    await svc.getState({ owner: 's1', app: { name: '记事本' } })
    const res = await svc.act({ owner: 's1', app: { name: '记事本' }, kind: 'click', x: 10, y: 10 })
    expect(res.ok).toBe(false)
    expect(res.error?.code).toBe('TARGET_STALE')
  })

  it('accepts a coordinate click bound to a fresh frame', async () => {
    const svc = makeService()
    await svc.getState({ owner: 's1', app: { name: '记事本' } })
    const shot = await svc.screenshot({ owner: 's1', app: { name: '记事本' } })
    expect(shot.ok).toBe(true)
    expect(shot.dataUrl?.startsWith('data:image/png')).toBe(true)
    const res = await svc.act({
      owner: 's1',
      app: { name: '记事本' },
      kind: 'click',
      x: 10,
      y: 10,
      screenshotId: shot.frame?.frameId,
    })
    expect(res.ok).toBe(true)
  })

  it('runs a bounded batch and stops on the first failure', async () => {
    const svc = makeService()
    await svc.getState({ owner: 's1', app: { name: '记事本' } })
    const okRun = await svc.runSteps({
      owner: 's1',
      steps: [
        { kind: 'setValue', args: { app: { name: '记事本' }, elementIndex: 3, value: 'a' } },
        { kind: 'key', args: { app: { name: '记事本' }, keys: 'Control_L+s' } },
      ],
      finalState: true,
    })
    expect(okRun.ok).toBe(true)
    expect(okRun.completed).toBe(2)
    expect(okRun.state).toBeTruthy()

    const failing = await svc.runSteps({
      owner: 's1',
      steps: [{ kind: 'setValue', args: { app: { name: '记事本' }, elementIndex: 999, value: 'x' } }],
    })
    expect(failing.ok).toBe(false)
    expect(failing.failedStep).toBe(0)
    expect(failing.error?.code).toBe('TARGET_STALE')
  })
})

describe('CuaService — control', () => {
  it('latches a stop and refuses further actions until reset', async () => {
    const svc = makeService()
    await svc.getState({ owner: 's1', app: { name: '记事本' } })
    await svc.stop('s1')
    const blocked = await svc.act({ owner: 's1', app: { name: '记事本' }, kind: 'type', text: 'x' })
    expect(blocked.ok).toBe(false)
    expect(blocked.error?.code).toBe('CONTROL_STOPPED')

    svc.reset('s1')
    const allowed = await svc.act({ owner: 's1', app: { name: '记事本' }, kind: 'type', text: 'x' })
    expect(allowed.ok).toBe(true)
  })

  it('enforces one controller at a time', async () => {
    const svc = makeService()
    await svc.getState({ owner: 's1', app: { name: '记事本' } })
    const first = await svc.act({ owner: 's1', app: { name: '记事本' }, kind: 'click', elementIndex: 4 })
    expect(first.ok).toBe(true)
    const second = await svc.act({ owner: 's2', app: { name: '记事本' }, kind: 'click', elementIndex: 4 })
    expect(second.ok).toBe(false)
    expect(second.error?.code).toBe('CONTROLLER_BUSY')
  })

  it('reports status with the backend capabilities', () => {
    const svc = makeService()
    const status = svc.status()
    expect(status.enabled).toBe(true)
    expect(status.available).toBe(true)
    expect(status.backend).toBe('fake')
  })
})
