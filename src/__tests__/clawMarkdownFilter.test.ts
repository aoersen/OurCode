import { describe, it, expect } from 'vitest'

import { StreamingMarkdownFilter } from '@tencent-weixin/openclaw-weixin/dist/src/messaging/markdown-filter.js'

/**
 * 官方插件的流式 Markdown 过滤器（增量喂入、输出前缀稳定）是微信出站文本
 * 的关键依赖：保证「已发送文本」永远是「最终过滤文本」的前缀，分片发送
 * 才不会出现错位。这里验证其基本过滤行为。
 */
describe('StreamingMarkdownFilter', () => {
  it('剥掉 CJK 斜体标记、整段移除图片、保留文字内容', () => {
    const f = new StreamingMarkdownFilter()
    const out = f.feed('*斜体* 和 ![图](https://x/y.png) 文字') + f.flush()
    expect(out).not.toContain('*')
    expect(out).not.toContain('![图]')
    expect(out).toContain('斜体')
    expect(out).toContain('文字')
  })

  it('增量喂入与一次性喂入的输出一致（前缀稳定性）', () => {
    const text = '第一段 *重点* 内容\n第二段 ![img](u) 结束'
    const f1 = new StreamingMarkdownFilter()
    const whole = f1.feed(text) + f1.flush()

    const f2 = new StreamingMarkdownFilter()
    let inc = ''
    for (let i = 0; i < text.length; i += 3) {
      inc += f2.feed(text.slice(i, i + 3))
    }
    inc += f2.flush()
    expect(inc).toBe(whole)
  })
})
