import { describe, expect, it } from 'vitest'
import {
  RUN_EXPANSION_KEY,
  RUN_STORAGE_PREFIX,
  RUN_THINKING_KEY,
  isExpanded,
  parseExpansionMap,
  readExpansionMap,
  serializeExpansionMap,
  withExpanded,
  writeExpansionMap,
} from '@/shell/agent/run/runExpansion'

function fakeStorage(initial: string | null = null) {
  let value = initial
  const writes: string[] = []
  return {
    writes,
    get value() {
      return value
    },
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next
      writes.push(next)
    },
  }
}

describe('storage keys', () => {
  it('uses the ourcode.shell.run. prefix', () => {
    expect(RUN_STORAGE_PREFIX).toBe('ourcode.shell.run.')
    expect(RUN_EXPANSION_KEY.startsWith(RUN_STORAGE_PREFIX)).toBe(true)
    expect(RUN_THINKING_KEY.startsWith(RUN_STORAGE_PREFIX)).toBe(true)
    expect(RUN_EXPANSION_KEY).not.toBe(RUN_THINKING_KEY)
  })
})

describe('parseExpansionMap', () => {
  it('returns an empty map for missing or malformed input', () => {
    expect(parseExpansionMap(null)).toEqual({})
    expect(parseExpansionMap(undefined)).toEqual({})
    expect(parseExpansionMap('')).toEqual({})
    expect(parseExpansionMap('{')).toEqual({})
    expect(parseExpansionMap('null')).toEqual({})
    expect(parseExpansionMap('"m1"')).toEqual({})
    expect(parseExpansionMap('[true,false]')).toEqual({})
  })

  it('keeps booleans and drops every other value type', () => {
    expect(parseExpansionMap('{"m1":true,"m2":false,"m3":"true","m4":1,"m5":null}')).toEqual({
      m1: true,
      m2: false,
    })
  })

  it('ignores prototype-polluting keys', () => {
    const parsed = parseExpansionMap('{"__proto__":true,"constructor":true,"prototype":true,"m1":true}')
    expect(parsed).toEqual({ m1: true })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
  })
})

describe('serializeExpansionMap', () => {
  it('round-trips through parse', () => {
    const map = { a: true, b: false }
    expect(parseExpansionMap(serializeExpansionMap(map))).toEqual(map)
  })

  it('drops unsafe keys and non-booleans on write', () => {
    const dirty = { a: true, __proto__: true, c: 'x' } as unknown as Record<string, boolean>
    expect(JSON.parse(serializeExpansionMap(dirty))).toEqual({ a: true })
  })
})

describe('isExpanded', () => {
  it('uses the persisted value and falls back otherwise', () => {
    const map = { on: true, off: false }
    expect(isExpanded(map, 'on')).toBe(true)
    expect(isExpanded(map, 'off', true)).toBe(false)
    expect(isExpanded(map, 'missing', true)).toBe(true)
    expect(isExpanded(map, 'missing')).toBe(false)
    expect(isExpanded(map, '')).toBe(false)
  })
})

describe('withExpanded', () => {
  it('adds and updates without mutating the input', () => {
    const base = { a: true }
    const next = withExpanded(base, 'b', true)
    expect(next).toEqual({ a: true, b: true })
    expect(base).toEqual({ a: true })
    expect(withExpanded(next, 'a', false)).toEqual({ a: false, b: true })
  })

  it('ignores empty and unsafe ids', () => {
    const base = { a: true }
    expect(withExpanded(base, '', true)).toBe(base)
    expect(withExpanded(base, '__proto__', true)).toBe(base)
  })

  it('trims the oldest entries past the limit', () => {
    let map = {}
    for (let i = 0; i < 5; i++) map = withExpanded(map, `m${i}`, true, 3)
    expect(Object.keys(map)).toEqual(['m2', 'm3', 'm4'])
  })
})

describe('read / write', () => {
  it('reads through a storage and tolerates a throwing one', () => {
    expect(readExpansionMap(RUN_EXPANSION_KEY, fakeStorage('{"m1":true}'))).toEqual({ m1: true })
    expect(readExpansionMap(RUN_EXPANSION_KEY, fakeStorage('not json'))).toEqual({})
    expect(readExpansionMap(RUN_EXPANSION_KEY, null)).toEqual({})
    const throwing = {
      getItem() {
        throw new Error('denied')
      },
    }
    expect(readExpansionMap(RUN_EXPANSION_KEY, throwing)).toEqual({})
  })

  it('writes serialized state and swallows quota errors', () => {
    const storage = fakeStorage()
    writeExpansionMap(RUN_EXPANSION_KEY, { m1: true }, storage)
    expect(storage.writes).toEqual(['{"m1":true}'])

    const failing = {
      setItem() {
        throw new Error('quota')
      },
    }
    expect(() => writeExpansionMap(RUN_EXPANSION_KEY, { m1: true }, failing)).not.toThrow()
  })

  it('survives a malformed persisted value end to end', () => {
    const storage = fakeStorage('{"m1":')
    const map = readExpansionMap(RUN_EXPANSION_KEY, storage)
    expect(isExpanded(map, 'm1', true)).toBe(true)
    writeExpansionMap(RUN_EXPANSION_KEY, withExpanded(map, 'm1', false), storage)
    expect(readExpansionMap(RUN_EXPANSION_KEY, storage)).toEqual({ m1: false })
  })
})
