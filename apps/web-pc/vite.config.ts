import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { type Connect, defineConfig, type Plugin } from 'vite'

/**
 * Vite base 只认带尾斜杠的 `/pc/`，请求 `/pc` 会直接 404。
 * 生产反代虽然有同口径 308，本地 dev / preview 也必须在入口处收口。
 */
function pcRootRedirect(): Plugin {
  const handler: Connect.NextHandleFunction = (request, response, next) => {
    const [pathname, query] = (request.url ?? '').split('?')
    if (pathname !== '/pc') {
      next()
      return
    }

    response.statusCode = 308
    response.setHeader('Location', query === undefined ? '/pc/' : `/pc/?${query}`)
    response.end()
  }

  return {
    name: 'pc-root-redirect',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}

// PC Web 挂在站点根 /pc/ 下，但 API 与 WebSocket 仍在站点根的 /api、/ws。
export default defineConfig({
  base: '/pc/',
  plugins: [
    pcRootRedirect(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
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
