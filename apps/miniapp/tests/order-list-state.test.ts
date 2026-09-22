import { describe, expect, mock, test } from 'bun:test'

/**
 * 订单列表的身份结转规则（#89 审查收口）。
 *
 * `useOrderList` 的 state 是账号作用域的：换账号 / 退出登录回到压在栈里的订单页时，
 * 旧账号的列表、错误态、截断标记都必须整片作废。判定抽成纯函数锁住组合；
 * 组件接线（渲染期调用、请求代次自增）同仓库先例靠 code review 保证。
 *
 * 为什么 `mock.module`：`useOrderList.ts` 经 `loadOrders → features/fetchers → lib/request`
 * 静态拖着 `@tarojs/taro`，而 Bun 下加载真 Taro 会抛 `ENABLE_INNER_HTML is not defined`。
 * 手法与 `wishes-api.test.ts` 一致：`mock.module` 后再动态 import 被测模块
 * （静态 import 会被提升到 mock 之前，顶替就不生效了）。
 */
mock.module('@tarojs/taro', () => ({ default: {} }))

// 构建期注入的开关（`config/index.ts` 的 defineConstants）。被测模块经
// `features/fetchers` 静态拖着 `features/auth/demo.ts`，它在模块求值阶段就读
// `__DEMO_AUTH__`；不定义会在 import 时 ReferenceError（同 `wishes-api.test.ts`）。
Object.assign(globalThis, { __DEMO_AUTH__: false, __ALLOW_MOCK_FALLBACK__: true })

const { nextIdentityState } = await import('../src/features/transaction/useOrderList')

describe('nextIdentityState —— 订单列表身份结转规则', () => {
  test('冷启动首帧（还没有身份、手里也没有数据）：idle —— 不加载，也没有东西要清', () => {
    expect(nextIdentityState(null, null)).toBe('idle')
  })

  test('退出登录（手里还挂着上一个账号的数据）：reset —— 不能残留旧账号订单', () => {
    expect(nextIdentityState('u-1', null)).toBe('reset')
  })

  test('首次拿到身份：reset —— 把初始「空 + loading」当作待加载', () => {
    expect(nextIdentityState(null, 'u-1')).toBe('reset')
  })

  test('身份未变：keep —— 已属于当前账号的列表原样保留', () => {
    expect(nextIdentityState('u-1', 'u-1')).toBe('keep')
  })

  test('换账号：reset —— 旧账号订单不能挂在新账号视角下', () => {
    expect(nextIdentityState('u-1', 'u-2')).toBe('reset')
  })
})
