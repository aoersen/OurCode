import { describe, it, expect } from 'vitest'
import { classifyIp, validateHttpUrl } from '../services/web-safety'

describe('classifyIp', () => {
  it('blocks loopback, private, link-local and metadata IPv4 ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1']) {
      expect(classifyIp(ip)).toBe('private')
    }
  })

  it('accepts public IPv4 literals', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(classifyIp(ip)).toBe('public')
    }
  })

  it('blocks private and special IPv6 forms', () => {
    for (const ip of [
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '2001:db8::1',
      '::ffff:192.168.1.1',
      '64:ff9b::10.0.0.1',
      '2002:0a00:0001::',
    ]) {
      expect(classifyIp(ip)).toBe('private')
    }
  })

  it('accepts public IPv6 literals, including mapped public IPv4', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      expect(classifyIp(ip)).toBe('public')
    }
  })

  it('treats hostnames and garbage as invalid', () => {
    expect(classifyIp('example.com')).toBe('invalid')
    expect(classifyIp('')).toBe('invalid')
  })
})

describe('validateHttpUrl', () => {
  it('rejects non-http schemes and embedded credentials', () => {
    expect(() => validateHttpUrl('file:///etc/passwd')).toThrow('仅支持')
    expect(() => validateHttpUrl('ftp://example.com/file')).toThrow('仅支持')
    expect(() => validateHttpUrl('https://user:pass@example.com/')).toThrow('用户名或密码')
    expect(() => validateHttpUrl('not a url')).toThrow('无效')
  })

  it('blocks local names and private literals by default', () => {
    for (const url of [
      'http://localhost/',
      'http://app.localhost/',
      'http://printer.local/',
      'http://127.0.0.1:8080/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
    ]) {
      expect(() => validateHttpUrl(url)).toThrow('已阻止')
    }
  })

  it('allows public URLs and the explicit private escape hatch', () => {
    expect(validateHttpUrl('https://example.com/docs').hostname).toBe('example.com')
    expect(validateHttpUrl('http://127.0.0.1:8080', { allowPrivate: true }).port).toBe('8080')
  })
})
