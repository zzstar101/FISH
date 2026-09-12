import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

/**
 * 单独成模块（而不是写在 `main.tsx` 里）是为了让 `lib/query-client.ts` 的全局
 * 401 收口能拿到 router，同时避免「入口 → query-client → 入口」的循环依赖。
 */
export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
