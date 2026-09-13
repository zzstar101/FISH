import type { WishCategory, WishDto, WishPoolItem, WishStatus } from '@fish/contracts/wishes/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { cn } from '@fish/ui/lib/utils'
import { GlassSurface } from '@fish/ui/liquid-glass'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, LoadingState } from '@fish/ui/states'
import { Tabs, TabsList, TabsTrigger } from '@fish/ui/tabs'
import { Link } from '@tanstack/react-router'
import { ChevronDown, PartyPopper, Plus, Search, Sun, X } from 'lucide-react'
import { useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { CATEGORY_LABEL, categoryLabel } from '../../lib/labels'
import { AppShell } from '../navigation/app-shell'
import { HOT_WISH_TAGS } from './hot-tags'
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

/** 热门标签榜：折叠态露出 4 行 × 2 列 = 8 个，其余由「展示全部」展开。 */
const VISIBLE_TAG_ROWS = 4
const TAG_COLUMNS = 2

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
  const [tagsExpanded, setTagsExpanded] = useState(false)

  const mine = wishes.data ?? []
  const poolItems = pool.data ?? []
  // 折叠态只露前 4 行（2 列），展开态铺全部。
  const visibleTags = tagsExpanded
    ? HOT_WISH_TAGS
    : HOT_WISH_TAGS.slice(0, VISIBLE_TAG_ROWS * TAG_COLUMNS)

  return (
    <AppShell>
      <div className="sticky top-0 z-20 bg-surface">
        {/* 右上角原来有个「许愿」加号钮，与 Banner 里的「我要许愿」重复；后者已搬到 h2 行，
            这里去掉，入口只留一个。 */}
        <NavBar title="许愿墙" />
      </div>

      <section className="px-3 pt-3">
        {/*
          红→白自上而下。`from-40%` 把纯红撑到 40% 处，是刻意的：线性渐变直接过渡的话，
          标题区（卡片顶部 ~25%）已经淡成粉色，白字就压不住底了。
        */}
        <div className="rounded-2xl bg-gradient-to-b from-coral from-40% to-surface px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/15 text-white">
              <Sun className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-lg text-white">想找什么?先许个愿</p>
              <p className="mt-1 text-white/80 text-xs">同学看到你的需求,有闲置就会来找你</p>
            </div>
          </div>

          {/*
            热门求购标签榜：顶替原来的双格统计条（「N 种心愿在被寻找 / N 件闲置可能匹配」）。
            磨砂玻璃材质复用 packages/ui 的 GlassSurface，这里只覆盖圆角（xl）与白底透明度
            （/20 = 原来的 /15 再加 5 个百分点）。榜单数据是纯前端常量，见 `hot-tags.ts`。

            榜单文字一律 `text-ink`：面板浮在卡片红→白的渐变上，实测底色是
            rgb(255,125,109) → rgb(255,207,198)，只有近黑能过 4.5:1
            （ink-3 只有 1.28、warn 1.16、白色 1.4–2.5）。层级靠字重和字号拉开。
          */}
          <GlassSurface className="mt-3 overflow-hidden rounded-xl bg-white/20">
            <ol className="grid grid-cols-2 gap-x-2 p-2">
              {visibleTags.map((tag, index) => (
                <li key={tag.label}>
                  <Link
                    className="flex items-center gap-1.5 px-1.5 py-1.5"
                    search={{ kw: tag.label }}
                    to="/search"
                  >
                    <RankNumber index={index} />
                    <span className="min-w-0 flex-1 truncate font-medium text-[13px] text-ink">
                      {tag.label}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink">{tag.wanters} 人想要</span>
                  </Link>
                </li>
              ))}
            </ol>

            {HOT_WISH_TAGS.length > VISIBLE_TAG_ROWS * TAG_COLUMNS ? (
              <button
                aria-expanded={tagsExpanded}
                className="flex w-full items-center justify-center gap-1 border-white/25 border-t py-2 font-medium text-[13px] text-ink"
                onClick={() => setTagsExpanded((prev) => !prev)}
                type="button"
              >
                {tagsExpanded ? '收起' : `展示全部 ${HOT_WISH_TAGS.length} 个标签`}
                <ChevronDown
                  className={cn('size-4 transition-transform', tagsExpanded && 'rotate-180')}
                />
              </button>
            ) : null}
          </GlassSurface>
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

      {/*
        右侧原来是「共 N 条」计数，按需求换成许愿入口——按钮从 Banner 里搬到这里。
        `items-baseline` 顺带改成 `items-center`：让 28px 的胶囊在标题行里垂直居中，
        而不是跟着标题文字按基线对齐。
      */}
      <h2 className="flex items-center justify-between px-4 py-3 font-semibold text-[15px]">
        {tab === 'mine' ? '我的愿望' : '大家在找'}
        <Button onClick={() => setCreating(true)} size="sm">
          <Plus />
          我要许愿
        </Button>
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

/**
 * 榜单名次：固定占宽，让不同名次的标签左边缘对齐。
 *
 * 名次刻意不着色：面板浮在卡片红→白渐变上，实测底色偏红（rgb(255,125,109) 起），
 * 除近黑外都到不了 4.5:1（装饰红 1.48、警示橙 1.16），颜色区分等于不可读。
 */
function RankNumber({ index }: { index: number }) {
  return (
    <span className="w-3 shrink-0 text-center font-bold text-[13px] text-ink">{index + 1}</span>
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
