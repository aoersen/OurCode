import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * 只服务于 src/__preview__ 的浏览器预览（截图核对上下文用量 UI 用）。
 * 复用工程内的 tailwind/postcss 配置与路径别名，不进入正式打包。
 */
export default defineConfig({
  root: resolve(__dirname, 'src/__preview__'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared'),
    },
  },
  server: { port: 5199, strictPort: true },
})
