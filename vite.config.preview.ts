import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * 只服务于 src/__preview__ 的浏览器预览（截图核对上下文用量 UI 用）。
 * 复用工程内的 tailwind/postcss 配置与路径别名，不进入正式打包。
 *
 * `server.watch.ignored`：编辑器/写入工具会在同目录塞 `.shell.tsx.<pid>.<uuid>.tmpdir/`
 * 临时目录，Windows 上 Vite 的 fs watcher 一旦 watch 到里头的 .tmp 文件就抛
 * EBUSY 把整个 dev server 打死。预览沙盘不需要监听这些临时产物，直接忽略。
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
  server: {
    port: 5199,
    strictPort: true,
    watch: { ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/.shell.tsx.*'] },
  },
})
