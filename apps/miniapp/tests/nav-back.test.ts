import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 「返回」兜底的**唯一实现**（`@/lib/nav-back`）。
 *
 * 为什么值得单独钉住：经分享卡片 / 扫码**冷启动直入二级页**时页面栈为空，
 * `Taro.navigateBack()` 无路可退 —— 此时必须 `switchTab` 回首页，否则用户点返回
 * 「没反应」，人卡在二级页。抽成函数之前，这段判定在 8 个页面调用点 + `top-bar` /
 * `nav-bar` 里逐字复刻了十份（#470 review：Duplicated Code），所以一条断言顶十处。
 *
 * 用 `mock.module` 顶替 Taro：Bun 下加载真 `@tarojs/taro` 会在求值阶段抛
 * （`ENABLE_INNER_HTML is not defined`，手法同 `tests/visual-search-start.test.ts`）。
 */

const calls: string[] = []
let stackLength = 2

mock.module('@tarojs/taro', () => ({
  default: {
    getCurrentPages: () =>
      Array.from({ length: stackLength }, (_, index) => ({ route: `p${index}` })),
    navigateBack: async () => {
      calls.push('navigateBack')
    },
    switchTab: async (options: { url: string }) => {
      calls.push(`switchTab:${options.url}`)
    },
  },
}))

const { goBackOrHome } = await import('../src/lib/nav-back')

beforeEach(() => {
  calls.length = 0
  stackLength = 2
})

describe('goBackOrHome —— 返回兜底', () => {
  test('页面栈里还有上一页：navigateBack，不动 tab', () => {
    stackLength = 3
    goBackOrHome()
    expect(calls).toEqual(['navigateBack'])
  })

  test('栈里只有当前页（冷启动直入）：switchTab 回首页', () => {
    stackLength = 1
    goBackOrHome()
    expect(calls).toEqual(['switchTab:/pages/home/index'])
  })

  test('栈为空：同样 switchTab 回首页，不抛', () => {
    stackLength = 0
    goBackOrHome()
    expect(calls).toEqual(['switchTab:/pages/home/index'])
  })
})
