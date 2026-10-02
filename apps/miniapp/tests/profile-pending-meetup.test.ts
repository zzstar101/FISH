import { expect, mock, test } from 'bun:test'

/**
 * 「我的」页 卖出 / 买入 两格的**待面交**计数（#431 任务二）。
 *
 * 需求：卖出格徽标 = 我在**卖家**一侧的 PENDING_MEETUP 笔数，买入格 = **买家**一侧，
 * 与各自订单页的「待面交」档同口径（订单页按 role 分页、按状态过滤，见
 * `features/transaction/api.ts`）。role 写反时页面照样渲染一个数字，肉眼看不出对错 ——
 * 所以这里把两个方向都钉住。
 *
 * 顶替的是 `features/profile/api` 而不是 `lib/request`：`loadProfile` 要的是
 * `fetchProfile()` 的返回值，fixture 只关心 `transactions[].role / status` 两个字段，
 * 不必把整份 `profileResponseSchema`（商品卡 / 卖家 / Me）都造齐。
 * `@tarojs/taro` 一并顶替：`features/fetchers` 静态拖着 `lib/request`，Bun 下加载真
 * Taro 会抛 `ENABLE_INNER_HTML is not defined`（同 `order-list-state.test.ts`）。
 */

Object.assign(globalThis, { __DEMO_AUTH__: false, __ALLOW_MOCK_FALLBACK__: false })
mock.module('@tarojs/taro', () => ({ default: {} }))

type TxStatus = 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED'

/** 每次调用重新读，避免「模块已 import 就不再求值」把用例之间的数据粘住 */
let transactions: { role: 'buyer' | 'seller'; status: TxStatus }[] = []

mock.module('@/features/profile/api', () => ({
  fetchProfile: async () => ({
    user: { id: 'usr_self', nickname: '我' },
    stats: { activeListings: 0, activeWishes: 0, completedTransactions: 0, followingCount: 0 },
    listings: [],
    wishes: [],
    transactions,
  }),
  updateProfile: async () => ({ id: 'usr_self' }),
}))

const { loadProfile } = await import('../src/features/fetchers')

test('卖出格 = 卖家侧 PENDING_MEETUP；买入格 = 买家侧（role 两个方向都不写错）', async () => {
  transactions = [
    { role: 'seller', status: 'PENDING_MEETUP' },
    { role: 'seller', status: 'PENDING_MEETUP' },
    { role: 'seller', status: 'COMPLETED' },
    { role: 'seller', status: 'CANCELLED' },
    { role: 'buyer', status: 'PENDING_MEETUP' },
    { role: 'buyer', status: 'PENDING_MEETUP' },
    { role: 'buyer', status: 'PENDING_MEETUP' },
    { role: 'buyer', status: 'COMPLETED' },
  ]

  const profile = await loadProfile(0)

  // 卖家侧 4 笔里只有 2 笔待面交；买家侧 4 笔里 3 笔 —— 取消 / 完成都不计入
  expect(profile?.pendingMeetupSell).toBe(2)
  expect(profile?.pendingMeetupBuy).toBe(3)
  // 「全部订单」角标仍按原口径计所有状态
  expect(profile?.orderCount).toBe(8)
})

test('只有一个方向有待面交时，另一格是 0 —— 「确定没有」不是「不知道」', async () => {
  transactions = [{ role: 'seller', status: 'PENDING_MEETUP' }]

  const profile = await loadProfile(0)

  expect(profile?.pendingMeetupSell).toBe(1)
  // 0 = 真实结果是「没有待面交」（页面不出徽标）；接口失败才是 null。
  // 这里若写成 null，就把「有卖出、没买入」说成了「买入未知」
  expect(profile?.pendingMeetupBuy).toBe(0)
})
