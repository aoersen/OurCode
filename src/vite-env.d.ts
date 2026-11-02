/// <reference types="vite/client" />

/** Vite 的 `?raw` 导入（no-limits 提示词预设等纯文本资源）。 */
declare module '*.md?raw' {
  const content: string
  export default content
}
