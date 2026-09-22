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

/**
 * 「当前该不该有列表」的**纯函数**判定（供 `tests/order-list-state.test.ts` 锁行为）。
 *
 * - `userId === null` 且手里没有账号数据：`idle` —— 不加载、也没什么可清。
 * - `userId === null` 但手里还挂着账号数据（退出登录）：`reset` —— 整片作废。
 * - `identity === userId`：列表已属于当前账号 —— `keep`，不用动。
 * - 其余（首次拿到身份 / 换账号）：`reset`，把列表整片作废，等页面触发加载。
 */
export function nextIdentityState(
  identity: string | null,
  userId: string | null,
): 'idle' | 'reset' | 'keep' {
  if (userId === null) {
    /*
     * 这里**必须**区分「本来就没有数据」与「退出登录后还剩着上一个账号的数据」：
     * 前者返回 `reset` 会让渲染期重置每帧都执行 `setItems([])` —— 新数组引用每次都算
     * 状态变化，而 `identity` 本来就是 `null`、`setIdentity(null)` 不改变它，于是判定
     * 永远是 `reset`，直接渲染死循环。
     */
    return identity === null ? 'idle' : 'reset'
  }
  if (identity !== userId) return 'reset'
  return 'keep'
}

export function useOrderList(role: OrderCardView['role'], userId: string | null): OrderListData {
  const [items, setItems] = useState<OrderCardView[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [truncated, setTruncated] = useState(false)

  /**
   * 请求代次。本页的加载入口有：首次加载（页面在 `authed` 后触发）、下拉刷新、
   * 错误态重试、从面交页返回（`useDidShow`）—— 它们可能并发（连点两次下拉 /
   * 刷新途中切页）。只有最后一次发出的请求可以落地，其余按过期丢弃。
   */
  const requestId = useRef(0)

  /**
   * 身份切换的**渲染期重置**（adjust-state-during-render，React 官方推荐的
   * 「存上一帧信息」写法，消息页同款）：订单页实例会被压在页面栈里、跨登录态存活，
   * 换账号回来时 `items` / `failed` / `truncated` 还是上一个账号的视角，必须在
   * **同一个 commit 内**清成「未加载」—— 写成 effect 里 setState 不行，那要到下一帧
   * 才生效。自增代次也放在这里（同步），上一个账号的迟到响应在微任务窗口里
   * 就已经被判过期，写不进刚清空的 state。
   *
   * `userId === null`（未登录 / 未就绪）时手里还挂着上一个账号的数据（退出登录）同样走清空：
   * 退出登录回到这页不能残留旧账号订单。冷启动首帧（`identity` 也还是 `null`）不在此列，
   * 原因见 `nextIdentityState` 的说明。
   */
  const [identity, setIdentity] = useState<string | null>(null)
  const identityState = nextIdentityState(identity, userId)
  if (identityState === 'reset') {
    setIdentity(userId)
    requestId.current += 1
    setItems([])
    setLoading(true)
    setFailed(false)
    setTruncated(false)
  }

  /**
   * 最新身份。命令式 `reload`（下拉刷新 / 从子页面返回重拉）要按它判断该不该发请求；
   * 走 ref 读最新值，这样 `reload` 的依赖里不必出现 `userId`（否则它的身份每换一次账号就变，
   * 页面那个登录态 effect 会跟着多跑一轮）。
   */
  const userIdRef = useRef(userId)
  userIdRef.current = userId

  const reload = useCallback(
    (options?: { keepList?: boolean }): Promise<void> => {
      /*
       * 登录态未就绪 / 已退出：**不发请求**。`/transactions` 整条挂在 requireAuth 之下，
       * 这个时点发出去必然 401 —— 开发 / 预览构建还会被那次 401 退成 mock。页面在
       * `authed` 之后由登录态 effect 补一次，请求不会丢。
       */
      if (userIdRef.current === null) return Promise.resolve()

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
