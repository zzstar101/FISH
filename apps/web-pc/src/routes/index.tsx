import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { createFileRoute } from '@tanstack/react-router'
import { AnnouncementBar } from '../features/home/announcement-bar'
import { TopSellers } from '../features/home/top-sellers'
import { PcListingCard } from '../features/listings/listing-card'
import { useHomeFeed } from '../features/listings/queries'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const feed = useHomeFeed()
  const items = feed.data?.items ?? []

  return (
    <div>
      <AnnouncementBar />

      <TopSellers />

      <div className="mt-9 mb-5 flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">今日上新</h1>
          <p className="mt-1.5 text-ink-3 text-sm">广应科校内 · 刚刚发布的闲置</p>
        </div>
        <p className="text-ink-3 text-xs">真实 API · 第一页 24 条</p>
      </div>

      {feed.isPending ? <LoadingState label="正在加载商品…" /> : null}
      {feed.isError ? (
        <ErrorState message="首页加载失败" onRetry={() => void feed.refetch()} />
      ) : null}
      {feed.isSuccess && items.length === 0 ? (
        <EmptyState description="还没有人发布闲置" emoji="🐟" title="暂时没有商品" />
      ) : null}
      {items.length > 0 ? (
        // 瀑布流：四列、卡片按内容自然高度排列，避免跨列断开。
        // 目前卡片高度接近（`ListingCardSchema` 没有封面宽高比，占位图高度固定），
        // 接入真实图片比例后错落会自然出现。
        <section aria-label="商品列表" className="columns-4 gap-5">
          {items.map((item) => (
            <div className="mb-5 break-inside-avoid" key={item.id}>
              <PcListingCard item={item} />
            </div>
          ))}
        </section>
      ) : null}
    </div>
  )
}
