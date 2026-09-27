import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { createFileRoute } from '@tanstack/react-router'
import { PcListingCard } from '../features/listings/listing-card'
import { useHomeFeed } from '../features/listings/queries'

export const Route = createFileRoute('/')({ component: HomePage })

function HomePage() {
  const feed = useHomeFeed()
  const items = feed.data?.items ?? []

  return (
    <div>
      <div className="mb-5 flex items-end justify-between gap-6">
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
        <section className="grid grid-cols-4 gap-5" aria-label="商品列表">
          {items.map((item) => (
            <PcListingCard item={item} key={item.id} />
          ))}
        </section>
      ) : null}
    </div>
  )
}
