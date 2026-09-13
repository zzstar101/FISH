/**
 * `WISH_ROUTES` 的回归守卫（#7 / #43）。
 *
 * 改动前实测失败：常量写成 `/api/wishes`（把**浏览器前缀**写进了 API 路径）。
 * 本仓约定是「API 路由保持根级，Web 写相对路径 `/api/...`、Vite 代理掉前缀」
 * （`docs/architecture.md` §5.1），`listings` / `matching` 的 `routes.ts` 同款。
 */
import { describe, expect, test } from 'bun:test'
import { WISH_ROUTES } from './routes'

const ID = '00000000-0000-0000-0000-000000000001'

describe('WISH_ROUTES', () => {
  test('全部是根级路径，不带浏览器前缀 /api', () => {
    const all = [
      WISH_ROUTES.base,
      WISH_ROUTES.pool,
      WISH_ROUTES.detail(ID),
      WISH_ROUTES.close(ID),
      WISH_ROUTES.fulfill(ID),
    ]
    for (const path of all) {
      // 改动前这两条都失败：`base` 等以 `/api/wishes` 开头。
      expect(path.startsWith('/api')).toBe(false)
      expect(path.startsWith('/wishes')).toBe(true)
    }
  })

  test('子路径挂在 base 之下，且无重复斜杠、无尾斜杠', () => {
    const children = [
      WISH_ROUTES.pool,
      WISH_ROUTES.detail(ID),
      WISH_ROUTES.close(ID),
      WISH_ROUTES.fulfill(ID),
    ]
    for (const path of children) {
      expect(path.startsWith(`${WISH_ROUTES.base}/`)).toBe(true)
      expect(path.includes('//')).toBe(false)
      expect(path.endsWith('/')).toBe(false)
    }
  })
})
