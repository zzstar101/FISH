/**
 * 订单卡上的两个跳转地址（#304）。
 *
 * 为什么单独放一层：演示构建（`TARO_APP_MOCK=1`）里后端不可用时，订单列表会整片换成
 * fixture，那些订单的 id 是 `t-*` 假 id —— 拿进真实面交页 / 会话页只会 404
 * 「找不到这笔交易」。所以「这张卡能跳到哪」必须把**来源**算进去：演示来源**没有地址**，
 * 调用方拿到 `null` 就不跳。
 *
 * 两个**交易入口**的地址在这里拼：调用方拿到 `null` 就不跳，于是
 * `tests/order-list-state.test.ts` 能真的断言「演示来源不会生成指向真实页的 URL」，
 * 而不是只看源码里有没有某个字符串。
 *
 * 组件里另有一处裸的 `…?id=`：`openListing`（`components/order-list/index.tsx`）跳商品
 * 详情，**不按来源拦** —— Owner 决策只点了「二维码 / 交易码」与「查看会话」两条交易
 * 入口，而假 `l-*` 会先打一次真实 `GET /listings/:id`（失败）再落到详情页自己的演示
 * 兜底，页面能正常打开。所以「地址只在这里拼一次」只对本模块这两个函数成立，
 * 上面那条 URL 断言覆盖的也只是这两条。
 */
import type { OrderCardView } from './adapt'

/** 演示来源的卡被拦下时给用户的说明（跳转与写操作四条路径同一句） */
export const DEMO_ORDER_HINT = '演示数据，不接入真实交易'

/** 来源是不是演示 fixture。`source` 由投影层写死（`adapt.ts`），不靠 id 前缀猜。 */
export function isDemoSource(item: Pick<OrderCardView, 'source'>): boolean {
  return item.source === 'demo'
}

/**
 * 「打开二维码 / 交易码」→ 面交页地址。演示来源返回 `null`：`t-*` 进真实页必然 404，
 * 调用方拿到 `null` 就只给一句说明、不跳页。
 */
export function meetupUrlOf(item: Pick<OrderCardView, 'id' | 'source'>): string | null {
  if (isDemoSource(item)) return null
  return `/pkg-trade/pages/transaction-meetup/index?id=${item.id}`
}

/**
 * 「查看会话」→ 会话页地址。演示来源、以及真实数据里解析不到 `conversationId`
 * （投影层给 `null`）的都返回 `null` —— 前者给演示说明，后者提示「会话已失效」。
 */
export function conversationUrlOf(
  item: Pick<OrderCardView, 'conversationId' | 'source'>,
): string | null {
  if (isDemoSource(item)) return null
  if (!item.conversationId) return null
  return `/pkg-social/pages/conversation/index?id=${item.conversationId}`
}
