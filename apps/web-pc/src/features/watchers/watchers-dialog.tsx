import type { ListingCard } from '@fish/contracts/listings/schema'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { watchersLoadError } from './api'
import { useChatWatchers } from './queries'
import { WatchersPanelView, watchersPanelState, watchersTotalLabel } from './watchers-panel-view'

/** 「谁想要」名单弹窗（#381）：由「我的发布」商品卡打开，只读。 */
export function WatchersDialog({
  listing,
  onClose,
}: {
  listing: ListingCard
  onClose: () => void
}) {
  const watchers = useChatWatchers(listing.id, true)

  const items = watchers.data?.pages.flatMap((page) => page.items) ?? []
  const total = watchers.data?.pages[0]?.total ?? null
  // 首屏失败与缓存复用窗口内的 refetch 失败都过同一张映射（404/403 一律降级成业务空态）。
  const failure = watchers.isError ? watchersLoadError(watchers.error) : null

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      open
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-xl">谁想要「{listing.title}」</DialogTitle>
          {/* 人数渲染在外壳里（radix Portal 在静态渲染下不可测），文案由 watchersTotalLabel 钉住。 */}
          <DialogDescription>{watchersTotalLabel(total)}</DialogDescription>
        </DialogHeader>
        <WatchersPanelView
          errorMessage={failure?.kind === 'error' ? failure.message : null}
          fetchingNextPage={watchers.isFetchingNextPage}
          hasNextPage={watchers.hasNextPage}
          items={items}
          nextPageFailed={watchers.isFetchNextPageError}
          onLoadMore={() => void watchers.fetchNextPage()}
          onRetry={() => void watchers.refetch()}
          state={watchersPanelState({
            pending: watchers.isPending,
            failure,
            itemCount: items.length,
          })}
          total={total}
        />
      </DialogContent>
    </Dialog>
  )
}
