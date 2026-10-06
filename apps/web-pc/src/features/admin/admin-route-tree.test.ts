import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * `beb81a89` 重新生成了 `routeTree.gen.ts`（生成器产物，禁止手改），把 /admin/ index
 * 路由登记进去 —— 交付方零用例证明这件事（#472 审查发现 §5）。这里直接读生成产物断言
 * 两处登记：模块 import 与 fullPath 映射；配合 admin-index-route.test.tsx 的渲染断言，
 * 覆盖「文件被重新生成后 index 路由真的存在」。
 */
const routeTree = readFileSync(new URL('../../routeTree.gen.ts', import.meta.url), 'utf8')

describe('routeTree 生成产物（beb81a89）', () => {
  test('登记了 /admin/ index 路由', () => {
    expect(routeTree).toContain(
      "import { Route as AdminIndexRouteImport } from './routes/admin.index'",
    )
    expect(routeTree).toContain("'/admin/': typeof AdminIndexRoute")
    expect(routeTree).toContain('preLoaderRoute: typeof AdminIndexRouteImport')
  })
})
