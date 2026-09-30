/**
 * 环境声明：@tencent-weixin/openclaw-weixin 打包产物没有 .d.ts。
 * 渲染层只用其纯函数的 StreamingMarkdownFilter（逐字符状态机，增量喂入、
 * 输出前缀稳定），在此为其声明最小接口。实现见该包的
 * dist/src/messaging/markdown-filter.js（MIT，腾讯官方通道插件）。
 */
declare module '@tencent-weixin/openclaw-weixin/dist/src/messaging/markdown-filter.js' {
  export class StreamingMarkdownFilter {
    /** 喂入新增字符，返回可安全输出的过滤后文本（可能为空）。 */
    feed(delta: string): string
    /** 冲刷滞留的少量待定字符（如行尾的 *），返回剩余过滤文本。 */
    flush(): string
  }
}
