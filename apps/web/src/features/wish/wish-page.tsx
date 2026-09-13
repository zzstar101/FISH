import type { WishCategory, WishDto, WishPoolItem, WishStatus } from '@fish/contracts/wishes/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, LoadingState } from '@fish/ui/states'
import { Tabs, TabsList, TabsTrigger } from '@fish/ui/tabs'
import { Link } from '@tanstack/react-router'
import { PartyPopper, Plus, Search, Sun, X } from 'lucide-react'
import { useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { CATEGORY_LABEL, categoryLabel } from '../../lib/labels'
import { AppShell } from '../navigation/app-shell'
import { useCloseWish, useCreateWish, useMyWishes, useWishMatches, useWishPool } from './queries'

const TABS = [
  { value: 'mine', label: '我的愿望' },
  { value: 'pool', label: '愿望池' },
] as const

const WISH_STATUS_BADGE: Record<WishStatus, { label: string; variant: 'success' | 'secondary' }> = {
  ACTIVE: { label: '许愿中', variant: 'success' },
  FULFILLED: { label: '已达成', variant: 'success' },
  CLOSED: { label: '已关闭', variant: 'secondary' },
}

/** 许愿墙（#7）：Banner + 我的愿望 / 愿望池。数据全部来自真实 `/api/wishes`。 */

/** 预算文案：预算 0 是「不设下限」而不是「免费送」（formatPrice 的 0 元是商品语义）。 */
function formatBudget(cents: number): string {
  return cents === 0 ? '¥0' : formatPrice(cents)
}

export function WishPage() {
  const wishes = useMyWishes()
  const pool = useWishPool()
  const createWish = useCreateWish()
  const closeWish = useCloseWish()
  const [tab, setTab] = useState<'mine' | 'pool'>('mine')
  const [creating, setCreating] = useState(false)

  const mine = wishes.data ?? []
  const poolItems = pool.data ?? []
  // 「件闲置可能匹配」：我的愿望的真实命中数之和（#8 matches 实时计数）。
  const matchedListings = mine.reduce((sum, wish) => sum + wish.matchCount, 0)

  return (
    <AppShell>
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar
          right={
            <button
              aria-label="许愿"
              className="flex size-9 items-center justify-center text-ink"
              onClick={() => setCreating(true)}
              type="button"
            >
              <Plus className="size-5" />
            </button>
          }
          title="许愿墙"
        />
      </div>

      <section className="px-3 pt-3">
        <div className="rounded-2xl bg-brand px-4 py-4 text-white">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/15">
              <Sun className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-lg">想找什么?先许个愿</p>
              <p className="mt-1 text-white/80 text-xs">同学看到你的需求,有闲置就会来找你</p>
            </div>
          </div>

          <div className="mt-3 flex items-center rounded-xl bg-white/15 py-2.5">
            <div className="flex flex-1 flex-col items-center">
              <span className="font-bold text-xl">{poolItems.length}</span>
              <span className="text-white/80 text-xs">种心愿在被寻找</span>
            </div>
            <span className="h-8 w-px bg-white/25" />
            <div className="flex flex-1 flex-col items-center">
              <span className="font-bold text-xl">{matchedListings}</span>
              <span className="text-white/80 text-xs">件闲置可能匹配</span>
            </div>
          </div>

          <Button className="mt-3 w-full" onClick={() => setCreating(true)} variant="onBrand">
            <Plus />
            我要许愿
          </Button>
        </div>
      </section>

      <div className="px-3 pt-3">
        <Tabs onValueChange={(next) => setTab(next as 'mine' | 'pool')} value={tab}>
          <TabsList>
            {TABS.map((option) => (
              <TabsTrigger key={option.value} value={option.value}>
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <h2 className="flex items-baseline justify-between px-4 py-3 font-semibold text-[15px]">
        {tab === 'mine' ? '我的愿望' : '大家在找'}
        <span className="font-normal text-ink-3 text-xs">
          共 {tab === 'mine' ? mine.length : poolItems.length} 条
        </span>
      </h2>

      {tab === 'mine' && wishes.isPending ? <LoadingState /> : null}
      {tab === 'pool' && pool.isPending ? <LoadingState /> : null}
      {tab === 'mine' && wishes.isSuccess && mine.length === 0 ? (
        <EmptyState description="还没有愿望,先许一个吧" emoji="🌞" />
      ) : null}
      {tab === 'pool' && pool.isSuccess && poolItems.length === 0 ? (
        <EmptyState description="愿望池还是空的" emoji="🌞" />
      ) : null}

      <div className="space-y-2.5 px-3 pb-6">
        {tab === 'mine'
          ? mine.map((wish) => (
              <MyWishCard key={wish.id} onClose={() => closeWish.mutate(wish.id)} wish={wish} />
            ))
          : poolItems.map((item) => (
              <PoolCard item={item} key={`${item.keyword}-${item.category}`} />
            ))}
      </div>

      {creating ? (
        <CreateWishSheet
          onClose={() => setCreating(false)}
          onSubmit={(input) =>
            createWish.mutate(input, {
              // 新建的愿望在自己的列表里，直接切过去给用户反馈。
              onSuccess: () => {
                setCreating(false)
                setTab('mine')
              },
            })
          }
          pending={createWish.isPending}
        />
      ) : null}
    </AppShell>
  )
}

/** 我的愿望卡：状态、预算区间、真实匹配数 + 愿望成真（/matches 的命中商品）。 */
function MyWishCard({ wish, onClose }: { wish: WishDto; onClose: () => void }) {
  // 愿望成真只对活跃愿望有意义；关闭/达成后不再拉匹配。
  const matches = useWishMatches(wish.id, wish.status === 'ACTIVE')
  const matched = (matches.data?.items ?? []).slice(0, 3)
  const badge = WISH_STATUS_BADGE[wish.status]

  return (
    <article className="overflow-hidden rounded-2xl bg-surface">
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <div className="min-w-0 flex-1">
            <p className="mt-0.5 truncate text-ink-3 text-xs">
              {formatRelativeTimeAt(wish.createdAt)}许下
            </p>
          </div>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>

        <p className="mt-1 font-medium text-[17px]">{wish.keyword}</p>
        <p className="mt-0.5 truncate text-ink-3 text-xs">
          想要「{CATEGORY_LABEL[wish.category]}」类闲置
        </p>

        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-[15px]">
            预算{' '}
            <span className="font-semibold">
              {wish.budgetMinCents === wish.budgetMaxCents
                ? formatBudget(wish.budgetMaxCents)
                : `${formatBudget(wish.budgetMinCents)} ~ ${formatBudget(wish.budgetMaxCents)}`}
            </span>
          </span>
          <span className="text-ink-3 text-xs">{wish.matchCount} 件闲置命中</span>
        </div>
      </div>

      {/* #8 愿望成真：这条愿望已经匹配到的在售商品（最多 3 件，真实结果）。 */}
      {matched.length > 0 ? (
        <div className="border-line border-t bg-success-soft/60 px-3 py-2.5">
          <p className="flex items-center gap-1.5 font-medium text-[13px] text-success">
            <PartyPopper className="size-4" />
            愿望成真
          </p>
          <ul className="mt-2 space-y-1.5">
            {matched.map((match) => (
              <li key={match.id}>
                <Link
                  className="flex items-center gap-2.5 rounded-xl bg-surface p-2"
                  params={{ listingId: match.listing.id }}
                  to="/detail/$listingId"
                >
                  <ListingThumb
                    alt={match.listing.title}
                    className="size-10 shrink-0 rounded-lg"
                    coverUrl={match.listing.coverUrl}
                    listingId={match.listing.id}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] leading-snug">{match.listing.title}</p>
                    <p className="mt-0.5 truncate text-ink-3 text-[11px]">
                      {formatRelativeTimeAt(match.listing.createdAt)}发布
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-semibold text-[13px]">
                      {formatPrice(match.listing.priceCents)}
                    </p>
                    <p className="text-[11px] text-success">{match.score}% 匹配</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-2 border-line border-t px-3 py-2.5">
        <Link
          className="flex min-w-0 flex-1 items-center gap-1.5 text-brand text-sm"
          search={{ kw: wish.keyword }}
          to="/search"
        >
          <Search className="size-4" />
          <span className="truncate">按关键词搜索</span>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px]">
            {wish.matchCount}
          </span>
        </Link>
        {wish.status === 'ACTIVE' ? (
          <button className="shrink-0 text-danger text-xs" onClick={onClose} type="button">
            关闭愿望
          </button>
        ) : null}
      </div>
    </article>
  )
}

/** 愿望池卡：全站聚合数据，没有所有者——不渲染任何虚构的用户信息。 */
function PoolCard({ item }: { item: WishPoolItem }) {
  return (
    <article className="rounded-2xl bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[17px]">{item.keyword}</p>
          <p className="mt-0.5 truncate text-ink-3 text-xs">{categoryLabel(item.category)}</p>
        </div>
        <Badge variant="lavender">求购</Badge>
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <span className="text-[15px]">
          常见预算 <span className="font-semibold">{formatPrice(item.medianBudgetCents)}</span>
        </span>
        <span className="text-ink-3 text-xs">{item.wantCount} 人想要</span>
      </div>
    </article>
  )
}

function CreateWishSheet({
  onClose,
  onSubmit,
  pending,
}: {
  onClose: () => void
  onSubmit: (input: {
    acceptSimilar: true
    keyword: string
    category: WishCategory
    budgetMinCents: number
    budgetMaxCents: number
  }) => void
  pending: boolean
}) {
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState<WishCategory>('DIGITAL')
  const [budgetMin, setBudgetMin] = useState('')
  const [budgetMax, setBudgetMax] = useState('')
  const keywordOk = keyword.trim().length >= 2 && keyword.trim().length <= 30
  // 契约：budgetMinCents ≥ 0、budgetMaxCents > 0、max ≥ min。
  const minOk =
    /^\d*$/.test(budgetMin) && (budgetMin === '' || Number(budgetMin) > 0 || budgetMin === '0')
  const maxOk = /^\d+$/.test(budgetMax) && Number(budgetMax) > 0
  const rangeOk = minOk && maxOk && Number(budgetMax) * 100 >= Number(budgetMin || '0') * 100
  const valid = keywordOk && rangeOk

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" data-overlay-open="">
      <button
        aria-label="关闭"
        className="absolute inset-0 bg-black/35"
        onClick={onClose}
        type="button"
      />
      <div className="pb-safe relative w-full max-w-[430px] rounded-t-2xl bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-[17px]">许个愿</h3>
          <button aria-label="关闭" onClick={onClose} type="button">
            <X className="size-5 text-ink-3" />
          </button>
        </div>
        <p className="mt-1 text-ink-3 text-xs">关键词 2–30 字,会统一转成小写（#7 契约）</p>

        <Input
          className="mt-3 border-0"
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="想要什么?例如:机械键盘"
          value={keyword}
        />
        <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
          {(Object.keys(CATEGORY_LABEL) as WishCategory[]).map((value) => (
            <button
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${
                category === value ? 'bg-brand text-white' : 'bg-surface-2 text-ink-2'
              }`}
              key={value}
              onClick={() => setCategory(value)}
              type="button"
            >
              {CATEGORY_LABEL[value]}
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Input
            className="border-0"
            inputMode="decimal"
            onChange={(event) => setBudgetMin(event.target.value)}
            placeholder="预算下限(元,选填)"
            value={budgetMin}
          />
          <span className="shrink-0 text-ink-3">~</span>
          <Input
            className="border-0"
            inputMode="decimal"
            onChange={(event) => setBudgetMax(event.target.value)}
            placeholder="预算上限(元)"
            value={budgetMax}
          />
        </div>

        {keyword.length > 0 && !keywordOk ? (
          <p className="mt-1 text-danger text-xs">关键词需要 2–30 个字符</p>
        ) : null}
        {budgetMax.length > 0 && !maxOk ? (
          <p className="mt-1 text-danger text-xs">预算上限要大于 0 的整数(元)</p>
        ) : null}
        {minOk && maxOk && !rangeOk ? (
          <p className="mt-1 text-danger text-xs">预算上限不能低于下限</p>
        ) : null}

        <Button
          className="mt-4 w-full"
          disabled={!valid || pending}
          onClick={() =>
            onSubmit({
              acceptSimilar: true,
              budgetMaxCents: Number(budgetMax) * 100,
              budgetMinCents: budgetMin === '' ? 0 : Number(budgetMin) * 100,
              category,
              keyword: keyword.trim(),
            })
          }
          size="lg"
        >
          {pending ? '发布中…' : '发布愿望'}
        </Button>
      </div>
    </div>
  )
}
