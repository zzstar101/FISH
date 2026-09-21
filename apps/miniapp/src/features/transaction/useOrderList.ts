/**
 * 订单列表的数据与派生（「我买到的」/「我卖出的」两页共用）。
 *
 * 只放**普通 React hook 与纯函数**，不放 Taro 的页面级 hook（`useLoad` /
 * `usePullDownRefresh` / `usePageScroll`）—— 那几个由页面自己持有（见 `pages/orders-buy`），
 * 因为仓库里没有「页面级 hook 写在子组件里」的先例，不想把页面行为赌在这上面。
 */
import { useCallback, useRef, useState } from 'react'
import { loadOrders } from '@/features/fetchers'
import type { OrderCardView } from './adapt'

/** 状态筛选的键：`ALL` + 契约的三个交易状态 */
export type StatusKey = 'ALL' | OrderCardView['status']

export type OrderListData = {
  items: OrderCardView[]
  loading: boolean
  /** 真实接口失败且**没有**回退 mock —— 页面渲染错误态，而不是空态 */
  failed: boolean
  /** 列表不完整（翻页到上限，或服务端游标没前进）—— 不能拿它的长度当总数 */
  truncated: boolean
  /**
   * 重拉当前视角。
   *
   * `keepList` 时不亮骨架屏：下拉刷新用（系统已经拉出原生指示器，再把列表整片换成
   * 骨架屏只会让用户丢掉阅读位置，还分不清「刷新」与「首次加载」）。
   * 返回值 resolve 时本次请求已落地（无论成功还是失败），调用方据此收掉原生指示器。
   */
  reload: (options?: { keepList?: boolean }) => Promise<void>
}

export function useOrderList(role: OrderCardView['role']): OrderListData {
  const [items, setItems] = useState<OrderCardView[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [truncated, setTruncated] = useState(false)

  /**
   * 请求代次。本页只有下拉刷新会重发请求，但迟到的响应同样会盖掉新结果
   * （连点两次下拉 / 刷新途中切页），所以守卫照留。
   */
  const requestId = useRef(0)

  const reload = useCallback(
    (options?: { keepList?: boolean }): Promise<void> => {
      const id = requestId.current + 1
      requestId.current = id
      if (!options?.keepList) setLoading(true)
      return loadOrders(role).then((result) => {
        if (requestId.current !== id) return
        /*
         * 失败时**不动** `items` / `truncated`：`loadOrders` 失败一律给空数组，直接写进去
         * 就等于「把用户已经读到的订单清空」—— 下拉刷新失败时尤其糟（阅读位置白丢）。
         * 保留上一次成功的结果、只把错误态交给渲染层（`components/order-list` 会把
         * `LoadError` 追加在列表下面；一条都没有时才用它顶替列表），比清空诚实也更可用。
         */
        if (!result.failed) {
          setItems(result.items)
          setTruncated(result.truncated)
        }
        setFailed(result.failed)
        setLoading(false)
      })
    },
    [role],
  )

  return { items, loading, failed, truncated, reload }
}

/** 各状态计数（含 `ALL`）。全部由拿到的那份列表算出，不写死任何数字 */
export function countsOf(items: OrderCardView[]): Record<StatusKey, number> {
  const counts: Record<StatusKey, number> = {
    ALL: items.length,
    PENDING_MEETUP: 0,
    COMPLETED: 0,
    CANCELLED: 0,
  }
  for (const item of items) counts[item.status] += 1
  return counts
}

/** 当前筛选 + 排序后的列表。不原地 sort（`items` 是 state，改了会让下次渲染看到被重排的数组） */
export function shownOf(
  items: OrderCardView[],
  status: StatusKey,
  sortDesc: boolean,
): OrderCardView[] {
  const filtered = status === 'ALL' ? items : items.filter((item) => item.status === status)
  return [...filtered].sort((a, b) => {
    const diff = Date.parse(b.createdAt) - Date.parse(a.createdAt)
    return sortDesc ? diff : -diff
  })
}
