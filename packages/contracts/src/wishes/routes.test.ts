import { describe, expect, test } from 'bun:test'
import { WISH_ROUTES } from './routes'

/**
 * 契约里的路径必须是**根级**、不带 `/api` 前缀。
 *
 * 依据 docs/architecture.md：「Web 一律写相对路径 `/api/...`；Vite 在开发时代理到 API 并
 * **去掉 `/api` 前缀**，因此 API 自身路由保持根级（`/health`）」。Web 侧由 `apiRequest`
 * 负责拼 `/api` 前缀（apps/web/src/lib/api-client.ts）——那是调用方约定，它本身不做校验。
 *
 * 回归来源：原值写成 `/api/wishes` 时，浏览器按约定请求 `/api/wishes`，经代理被改写成
 * `/wishes`，而 API 只服务 `/api/wishes` → 404，前端永远拿不到真实数据（#41 / #42）。
 */
describe('WISH_ROUTES', () => {
  const paths: [string, string][] = [
    ['base', WISH_ROUTES.base],
    ['pool', WISH_ROUTES.pool],
    ['detail', WISH_ROUTES.detail('w1')],
    ['close', WISH_ROUTES.close('w1')],
    ['fulfill', WISH_ROUTES.fulfill('w1')],
  ]

  test('全部是根级路径，不带 /api 前缀（前缀会被 Vite 代理吃掉）', () => {
    for (const [name, path] of paths) {
      expect(`${name}: ${path.startsWith('/api/')}`).toBe(`${name}: false`)
      expect(path.startsWith('/')).toBe(true)
    }
  })

  test('子路径都挂在 base 之下，且没有重复斜杠', () => {
    for (const [name, path] of paths) {
      const underBase = path === WISH_ROUTES.base || path.startsWith(`${WISH_ROUTES.base}/`)
      expect(`${name}: ${underBase}`).toBe(`${name}: true`)
      expect(`${name}: ${path.includes('//')}`).toBe(`${name}: false`)
    }
  })
})
