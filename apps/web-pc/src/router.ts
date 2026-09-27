import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

/**
 * PC Web 部署在站点根 `/pc/` 下。
 * 页面路由带 basepath；API 请求不走 basepath，仍固定为 `/api`。
 */
export const router = createRouter({
  routeTree,
  basepath: '/pc',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
