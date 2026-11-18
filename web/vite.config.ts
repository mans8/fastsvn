import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // BoardUI 组件统一用 @/ 导入，指向项目根（与 tsconfig 的 paths 对齐）
      '@': path.resolve(__dirname, '.'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 单页应用，路由只有一层，不需要分块策略
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 开发时把 API 打到本地 server.js
      '/api': {
        target: 'http://127.0.0.1:5183',
        changeOrigin: false,
      },
    },
  },
});
