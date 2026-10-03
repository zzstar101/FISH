import { useState } from 'react'
import { useAuth } from '../auth/auth-provider'
import { HistoryView } from './history-view'
import { useClearViewHistory, useMyViewHistory } from './queries'

/**
 * 我的浏览记录（`/history`）。
 *
 * 路由不在 `__root.tsx` 的免登录白名单里，由 `RequireAuth` 守卫（未登录跳登录并回跳）；
 * 这里的 `me` 兜底与个人中心同款。查询键已带 ownerId（第二道隔离），按 `me.id` 重挂载
 * 是为了页面内的一次性状态（清空失败文案）不跨账号复用。
 */
export function HistoryPage() {
  const { me } = useAuth()
  if (!me) return null
  return <HistoryContent key={me.id} ownerId={me.id} />
}

function HistoryContent({ ownerId }: { ownerId: string }) {
  const [clearFailure, setClearFailure] = useState<string | null>(null)
  const history = useMyViewHistory(ownerId)
  const clear = useClearViewHistory()

  const items = history.data?.pages.flatMap((page) => page.items) ?? []

  function handleClear() {
    setClearFailure(null)
    clear.mutate(undefined, {
      // 失败只显示文案：列表保持原样（服务端没删成功，本地不能假装删了）。
      onError: (error) => {
        setClearFailure(
          error instanceof Error && error.message ? error.message : '清空失败，请稍后重试',
        )
      },
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">浏览记录</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          你最近看过的商品在这里；清空后记录立即消失，不影响商品本身。
        </p>
      </div>
      <HistoryView
        clearFailure={clearFailure}
        clearing={clear.isPending}
        // 首屏失败与翻页失败分开：翻页失败保留已加载列表、行内重试（与 chat 会话列表同款）。
        error={history.isError && !history.isFetchNextPageError}
        hasNextPage={history.hasNextPage}
        items={items}
        loading={history.isPending}
        loadingMore={history.isFetchingNextPage}
        nextPageError={history.isFetchNextPageError}
        onClear={handleClear}
        onLoadMore={() => void history.fetchNextPage()}
        onRetry={() => void history.refetch()}
        onRetryNextPage={() => void history.fetchNextPage()}
      />
    </div>
  )
}
