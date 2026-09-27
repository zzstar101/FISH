import type { WishDto } from '@fish/contracts/wishes/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight, Search } from 'lucide-react'
import { useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice } from '../../lib/format'
import { categoryLabel } from '../../lib/labels'
import { useAuth } from '../auth/auth-provider'
import { formatWishBudgetCents, MatchListDialog, type MatchTarget } from './match-list'
import { MyWishes } from './my-wishes'
import { useMyListingsForMatches, useWishPool } from './queries'
import { WishFormDialog } from './wish-form'

type WishTab = 'mine' | 'pool' | 'listings'

const TABS: ReadonlyArray<{ value: WishTab; label: string }> = [
  { value: 'mine', label: '我的愿望' },
  { value: 'pool', label: '愿望池' },
  { value: 'listings', label: '商品匹配' },
]

export function WishPage() {
  const { me } = useAuth()
  if (!me) return null
  return <WishContent key={me.id} ownerId={me.id} />
}

function WishContent({ ownerId }: { ownerId: string }) {
  const [tab, setTab] = useState<WishTab>('mine')
  const [formOpen, setFormOpen] = useState(false)
  const [editingWish, setEditingWish] = useState<WishDto | undefined>(undefined)
  const [matchTarget, setMatchTarget] = useState<MatchTarget | null>(null)

  function createWish() {
    setEditingWish(undefined)
    setFormOpen(true)
  }

  function editWish(wish: WishDto) {
    setEditingWish(wish)
    setFormOpen(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">许愿墙</h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            发布需求、查看匿名聚合，并查看 Worker 产出的真实匹配。
          </p>
        </div>
        <p className="text-ink-3 text-xs">真实 API · 愿望按 page/pageSize 分页</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {TABS.map((item) => {
          const active = item.value === tab
          return (
            <button
              aria-pressed={active}
              className={`h-10 rounded-full px-5 font-medium text-sm transition-colors ${
                active
                  ? 'bg-brand text-white'
                  : 'bg-surface text-ink-2 hover:bg-brand-soft hover:text-brand'
              }`}
              key={item.value}
              onClick={() => setTab(item.value)}
              type="button"
            >
              {item.label}
            </button>
          )
        })}
      </div>

      {tab === 'mine' ? (
        <MyWishes
          onCreate={createWish}
          onEdit={editWish}
          onOpenMatch={setMatchTarget}
          ownerId={ownerId}
        />
      ) : null}
      {tab === 'pool' ? <WishPool ownerId={ownerId} /> : null}
      {tab === 'listings' ? (
        <MyListingMatches ownerId={ownerId} onOpenMatch={setMatchTarget} />
      ) : null}

      <WishFormDialog
        onOpenChange={(open) => {
          setFormOpen(open)
          if (!open) setEditingWish(undefined)
        }}
        open={formOpen}
        ownerId={ownerId}
        wish={editingWish}
      />
      <MatchListDialog
        onClose={() => setMatchTarget(null)}
        ownerId={ownerId}
        target={matchTarget}
      />
    </div>
  )
}

function WishPool({ ownerId }: { ownerId: string }) {
  const navigate = useNavigate()
  const pool = useWishPool(ownerId)

  if (pool.isPending) return <LoadingState label="正在加载愿望池…" />
  if (pool.isError) {
    return <ErrorState message="愿望池加载失败" onRetry={() => void pool.refetch()} />
  }
  if (pool.data.items.length === 0) {
    return (
      <EmptyState description="达到 k-匿名门槛的需求会显示在这里" emoji="🫧" title="暂无聚合需求" />
    )
  }

  return (
    <section aria-label="愿望池" className="grid grid-cols-3 gap-4">
      {pool.data.items.map((item) => (
        <button
          className="text-left"
          key={`${item.category}:${item.keyword}`}
          onClick={() =>
            void navigate({
              to: '/search',
              search: { q: item.keyword, category: item.category, sort: 'newest' },
            })
          }
          type="button"
        >
          <Card className="h-full gap-0 border border-line p-5 transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="line-clamp-1 font-semibold text-lg">{item.keyword}</h2>
                <p className="mt-1.5 text-ink-3 text-sm">{categoryLabel(item.category)}</p>
              </div>
              <ChevronRight className="mt-1 size-4 shrink-0 text-ink-3" />
            </div>
            <div className="mt-5 flex items-end justify-between gap-3">
              <div>
                <p className="text-ink-3 text-xs">预算中位数</p>
                <p className="mt-1 font-semibold text-lg">
                  {formatWishBudgetCents(item.medianBudgetCents)}
                </p>
              </div>
              <Badge variant="lavender">{item.wantCount} 条需求</Badge>
            </div>
            <p className="mt-4 flex items-center gap-1.5 text-brand text-xs">
              <Search className="size-3.5" />
              按这个关键词搜索商品
            </p>
          </Card>
        </button>
      ))}
    </section>
  )
}

function MyListingMatches({
  ownerId,
  onOpenMatch,
}: {
  ownerId: string
  onOpenMatch: (target: MatchTarget) => void
}) {
  const listings = useMyListingsForMatches(ownerId)
  const items = listings.data?.pages.flatMap((page) => page.items) ?? []

  if (listings.isPending) return <LoadingState label="正在加载我的商品…" />
  if (listings.isError && !listings.isFetchNextPageError) {
    return <ErrorState message="我的商品加载失败" onRetry={() => void listings.refetch()} />
  }
  if (items.length === 0) {
    return (
      <EmptyState
        action={
          <Link
            className="inline-flex h-9 items-center rounded-full bg-brand px-4 font-medium text-sm text-white hover:bg-lavender"
            to="/publish"
          >
            去发布闲置
          </Link>
        }
        description="发布商品后，这里会显示想买它的愿望匹配"
        emoji="📦"
        title="还没有商品"
      />
    )
  }

  const loadMore = () => void listings.fetchNextPage()

  return (
    <section className="space-y-3">
      <p className="text-ink-3 text-sm">
        商品侧展示的是“谁在求购我的商品”。匹配由服务端按分数排序，前端不重算。
      </p>
      {items.map((listing) => (
        <Card className="gap-0 border border-line p-4" key={listing.id}>
          <div className="flex items-center gap-4">
            <Link params={{ listingId: listing.id }} to="/listing/$listingId">
              <ListingThumb
                alt={listing.title}
                className="size-20 rounded-2xl"
                coverUrl={listing.coverUrl}
                listingId={listing.id}
              />
            </Link>
            <div className="min-w-0 flex-1">
              <Link
                className="line-clamp-1 font-semibold hover:text-brand"
                params={{ listingId: listing.id }}
                to="/listing/$listingId"
              >
                {listing.title}
              </Link>
              <p className="mt-1.5 text-ink-3 text-sm">
                {categoryLabel(listing.category)} · {formatPrice(listing.priceCents)}
              </p>
            </div>
            <Button
              onClick={() => onOpenMatch({ kind: 'listing', id: listing.id, title: listing.title })}
              variant="outline"
            >
              查看求购愿望
            </Button>
          </div>
        </Card>
      ))}
      {listings.isFetchNextPageError ? (
        <ErrorState message="加载更多商品失败" onRetry={loadMore} />
      ) : null}
      {!listings.isFetchNextPageError && listings.hasNextPage ? (
        <div className="flex justify-center pt-2">
          <Button disabled={listings.isFetchingNextPage} onClick={loadMore} variant="outline">
            {listings.isFetchingNextPage ? '正在加载…' : '加载更多商品'}
          </Button>
        </div>
      ) : null}
      <p className="text-center text-ink-3 text-xs">已加载 {items.length} 件商品</p>
    </section>
  )
}
