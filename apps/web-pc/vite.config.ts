import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// PC Web 挂在站点根 /pc/ 下，但 API 与 WebSocket 仍在站点根的 /api、/ws。
export default defineConfig({
  base: '/pc/',
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
