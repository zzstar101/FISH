import type { ListingCard } from '@fish/contracts/listings/schema'
import { Button } from '@fish/ui/button'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { createFileRoute } from '@tanstack/react-router'
import { AnnouncementBar } from '../features/home/announcement-bar'
import { PcListingCard } from '../features/listings/listing-card'
import { useHomeFeed } from '../features/listings/queries'
import { useHiddenListings } from '../features/recommendation/hidden'

export const Route = createFileRoute('/')({ component: HomePage })

/** 一张卡片在推荐 Feed 里的位置：position 跨页连续，pageIndex 只用于曝光元数据。 */
type FeedCard = { item: ListingCard; pageIndex: number; position: number }

function HomePage() {
  const feed = useHomeFeed()
  const { hiddenIds, hideListing } = useHiddenListings()
  const pages = feed.data?.pages ?? []

  // position 是**本次推荐请求内跨页连续**的全局序号：接着上一页已加载的条数往下数，
  // 不能只取本页下标，否则第二页的「第 0 位」会和第一页撞号。
  const cards: FeedCard[] = []
  for (const [pageIndex, page] of pages.entries()) {
    for (const item of page.items) cards.push({ item, pageIndex, position: cards.length })
  }

  // 隐藏名单只影响展示：position 已按推荐返回的原始顺序算好，过滤不会打乱它。
  const visibleCards = cards.filter((card) => !hiddenIds.has(card.item.id))
  const requestId = pages[0]?.requestId ?? null

  return (
    <div>
      <AnnouncementBar />

      <div className="mb-5 flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">今日上新</h1>
          <p className="mt-1.5 text-ink-3 text-sm">广应科校内 · 刚刚发布的闲置</p>
        </div>
        <p className="text-ink-3 text-xs">真实 API · 每页 24 条</p>
      </div>

      {feed.isPending ? <LoadingState label="正在加载商品…" /> : null}
      {feed.isError ? (
        <ErrorState message="首页加载失败" onRetry={() => void feed.refetch()} />
      ) : null}
      {feed.isSuccess && visibleCards.length === 0 ? (
        <EmptyState description="还没有人发布闲置" emoji="🐟" title="暂时没有商品" />
      ) : null}
      {visibleCards.length > 0 ? (
        <section className="grid grid-cols-4 gap-5" aria-label="商品列表">
          {visibleCards.map((card) => (
            <PcListingCard
              impression={{ requestId, pageIndex: card.pageIndex, position: card.position }}
              item={card.item}
              key={card.item.id}
              onHide={hideListing}
            />
          ))}
        </section>
      ) : null}

      {feed.isFetchNextPageError ? (
        <ErrorState message="加载更多失败" onRetry={() => void feed.fetchNextPage()} />
      ) : null}
      {feed.hasNextPage && !feed.isFetchNextPageError ? (
        <div className="flex justify-center pt-2">
          <Button
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
            variant="outline"
          >
            {feed.isFetchingNextPage ? '正在加载…' : '加载更多'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
