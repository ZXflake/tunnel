import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: path.resolve(root, 'src/renderer'),
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'src/shared'),
    },
  },
  build: {
    outDir: path.resolve(root, 'dist/renderer'),
    // 覆盖式构建：避免清空目录时触发受管环境的删除拦截
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
})
