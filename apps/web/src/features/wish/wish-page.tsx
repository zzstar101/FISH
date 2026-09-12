import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, LoadingState } from '@fish/ui/states'
import { Tabs, TabsList, TabsTrigger } from '@fish/ui/tabs'
import { Thumb } from '@fish/ui/thumb'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { ChevronRight, PartyPopper, Plus, Search, Sun, X } from 'lucide-react'
import { useState } from 'react'
import { formatPrice, formatRelativeTime, formatYuan } from '../../lib/format'
import type { WishView } from '../../lib/mock/store'
import { AppShell } from '../navigation/app-shell'
import { useCloseWish, useCreateWish, useWishes } from './queries'

const TABS = [
  { value: 'wall', label: '大家的愿望' },
  { value: 'mine', label: '我的愿望' },
] as const

/** 许愿墙（#7）：Banner + 大家的愿望 / 我的愿望。 */
export function WishPage() {
  const wishes = useWishes()
  const createWish = useCreateWish()
  const closeWish = useCloseWish()
  const [tab, setTab] = useState<'wall' | 'mine'>('wall')
  const [creating, setCreating] = useState(false)

  const wall = wishes.data?.wall ?? []
  const mine = wishes.data?.mine ?? []
  const list = tab === 'wall' ? wall : mine

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
              <span className="font-bold text-xl">{wall.length}</span>
              <span className="text-white/80 text-xs">条愿望在墙上</span>
            </div>
            <span className="h-8 w-px bg-white/25" />
            <div className="flex flex-1 flex-col items-center">
              <span className="font-bold text-xl">{wishes.data?.matchedListings ?? 0}</span>
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
        <Tabs onValueChange={(next) => setTab(next as 'wall' | 'mine')} value={tab}>
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
        {tab === 'wall' ? '大家的愿望' : '我的愿望'}
        <span className="font-normal text-ink-3 text-xs">共 {list.length} 条</span>
      </h2>

      {wishes.isPending ? <LoadingState /> : null}
      {list.length === 0 && !wishes.isPending ? (
        <EmptyState description="还没有愿望,先许一个吧" emoji="🌞" />
      ) : null}

      <div className="space-y-2.5 px-3 pb-6">
        {list.map((wish) => (
          <WishCard
            key={wish.id}
            mine={tab === 'mine'}
            onClose={() => closeWish.mutate(wish.id)}
            wish={wish}
          />
        ))}
      </div>

      {creating ? (
        <CreateWishSheet
          onClose={() => setCreating(false)}
          onSubmit={(keyword, budgetCents) =>
            createWish.mutate(
              { keyword, budgetCents },
              {
                // 新建的愿望在自己的列表里，直接切过去给用户反馈。
                onSuccess: () => {
                  setCreating(false)
                  setTab('mine')
                },
              },
            )
          }
          pending={createWish.isPending}
        />
      ) : null}
    </AppShell>
  )
}

function WishCard({ wish, mine, onClose }: { wish: WishView; mine: boolean; onClose: () => void }) {
  const owner = wish.owner

  return (
    <article className="overflow-hidden rounded-2xl bg-surface">
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <UserAvatar emoji={owner.emoji} size="default" tone={owner.tone} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-[15px]">{owner.nickname}</p>
            <p className="mt-0.5 truncate text-ink-3 text-xs">
              {owner.college} · {owner.campus} · {formatRelativeTime(wish.minutesAgo)}
            </p>
          </div>
          <Badge variant="lavender">求购</Badge>
        </div>

        <p className="mt-2.5 font-medium text-[17px]">{wish.keyword}</p>

        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-[15px]">
            预算 <span className="font-semibold">¥{formatYuan(wish.budgetCents)}</span>
          </span>
          <span className="text-ink-3 text-xs">{wish.helpers} 人想帮 TA</span>
        </div>
      </div>

      {/* #8 愿望成真：这条愿望已经匹配到的在售商品（最多 3 件）。 */}
      {wish.matched.length > 0 ? (
        <div className="border-line border-t bg-success-soft/60 px-3 py-2.5">
          {/*
            这里刻意不重复写数量：卡片底部「查看匹配的闲置 N」用的是 #7 的 matchedCount
            （关键词搜索口径），与 #8 匹配引擎的命中数不一定相同，两个数字并排会互相打架。
          */}
          <p className="flex items-center gap-1.5 font-medium text-[13px] text-success">
            <PartyPopper className="size-4" />
            愿望成真
          </p>
          <ul className="mt-2 space-y-1.5">
            {wish.matched.map((match) => (
              <li key={match.listing.id}>
                <Link
                  className="flex items-center gap-2.5 rounded-xl bg-surface p-2"
                  params={{ listingId: match.listing.id }}
                  to="/detail/$listingId"
                >
                  <Thumb
                    className="size-10 shrink-0 rounded-lg"
                    emoji={match.listing.emoji}
                    emojiClassName="text-lg"
                    tone={match.listing.tone}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] leading-snug">{match.listing.title}</p>
                    <p className="mt-0.5 truncate text-ink-3 text-[11px]">{match.reason}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-semibold text-[13px]">
                      {match.listing.free ? '免费送' : formatPrice(match.listing.priceCents)}
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
          <span className="truncate">查看匹配的闲置</span>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px]">
            {wish.matchedCount}
          </span>
        </Link>
        {mine ? (
          <button className="shrink-0 text-danger text-xs" onClick={onClose} type="button">
            关闭愿望
          </button>
        ) : (
          <ChevronRight className="size-[18px] shrink-0 text-ink-3" />
        )}
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
  onSubmit: (keyword: string, budgetCents: number) => void
  pending: boolean
}) {
  const [keyword, setKeyword] = useState('')
  const [budget, setBudget] = useState('')
  const keywordOk = keyword.trim().length >= 2 && keyword.trim().length <= 30
  // 契约：budgetMinCents ≥ 0、budgetMaxCents > 0 —— 这里只收正整数元。
  const budgetOk = /^\d+$/.test(budget.trim()) && Number(budget) > 0
  const valid = keywordOk && budgetOk

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
        <Input
          className="mt-2 border-0"
          inputMode="decimal"
          onChange={(event) => setBudget(event.target.value)}
          placeholder="预算上限,例如:200"
          value={budget}
        />

        {keyword.length > 0 && !keywordOk ? (
          <p className="mt-1 text-danger text-xs">关键词需要 2–30 个字符</p>
        ) : null}
        {budget.length > 0 && !budgetOk ? (
          <p className="mt-1 text-danger text-xs">预算填一个大于 0 的整数(元)</p>
        ) : null}

        <Button
          className="mt-4 w-full"
          disabled={!valid || pending}
          onClick={() => onSubmit(keyword.trim(), Number(budget) * 100)}
          size="lg"
        >
          {pending ? '发布中…' : '发布愿望'}
        </Button>
      </div>
    </div>
  )
}
