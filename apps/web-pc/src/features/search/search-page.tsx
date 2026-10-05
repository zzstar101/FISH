import {
  type ListingCategory,
  ListingCategorySchema,
  type ListingSort,
  ListingSortSchema,
} from '@fish/contracts/listings/schema'
import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fish/ui/select'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { CATEGORY_LABEL } from '../../lib/labels'
import { PcListingCard } from '../listings/listing-card'
import { useListingSearch } from '../listings/queries'
import {
  findListingByNumber,
  isAbortError,
  isListingNumberQuery,
  lookupErrorMessage,
  type NumberLookupPhase,
  numberQueryHint,
} from './number-lookup'
import { NumberLookupPanel, NumberQueryHint } from './number-lookup-panel'
import type { PcSearchParams } from './search-params'

const SORT_OPTIONS: ReadonlyArray<{ value: ListingSort; label: string }> = [
  { value: 'newest', label: '最新发布' },
  { value: 'priceAsc', label: '价格从低到高' },
  { value: 'priceDesc', label: '价格从高到低' },
]

const CATEGORY_OPTIONS = ListingCategorySchema.options.map((value) => ({
  value,
  label: CATEGORY_LABEL[value],
}))

type SearchPatch = {
  q?: string
  category?: ListingCategory | null
  sort?: ListingSort
  /** `null` = 关掉该筛选（与 `category: null` 同一套语义）。 */
  free?: boolean | null
}

export function SearchPage({ q, category, free, sort = 'newest' }: PcSearchParams) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(q ?? '')
  // 输入分类三档（#382）：合法 12 位编号 → byNumber 精确查询（不发关键词请求）；
  // 像编号但不合法 → 关键词搜索 + 行内提示；其余 → 关键词搜索。
  const trimmedQ = q?.trim()
  const isNumberQuery = trimmedQ !== undefined && trimmedQ !== '' && isListingNumberQuery(trimmedQ)
  const numberHint = q === undefined ? null : numberQueryHint(q)
  const [numberLookup, setNumberLookup] = useState<NumberLookupPhase>({ kind: 'idle' })
  const [lookupNonce, setLookupNonce] = useState(0)
  // 编号查询期间把 q 从 filters 里拿掉：编号不进任何缓存 key（验收原文），关键词请求也已关停。
  const results = useListingSearch(
    { q: isNumberQuery ? undefined : q, category, free, sort },
    { enabled: !isNumberQuery },
  )
  const items = results.data?.pages.flatMap((page) => page.items) ?? []

  useEffect(() => {
    setDraft(q ?? '')
  }, [q])

  // 编号精确查询不走 react-query（验收：编号不进缓存 key）：一次性解析，命中立即跳
  // canonical `lst_...` 详情；换输入或重试都会取消上一次在途请求。
  useEffect(() => {
    // lookupNonce 是重试信号（面板的错误态可重试），effect 本身不读它的值。
    void lookupNonce
    if (!isNumberQuery || trimmedQ === undefined) {
      setNumberLookup({ kind: 'idle' })
      return
    }
    const controller = new AbortController()
    let active = true
    setNumberLookup({ kind: 'loading', listingNo: trimmedQ })
    findListingByNumber(trimmedQ, controller.signal)
      .then((listingId) => {
        if (!active) return
        setNumberLookup(
          listingId === null ? { kind: 'miss', listingNo: trimmedQ } : { kind: 'hit', listingId },
        )
      })
      .catch((error: unknown) => {
        if (!active || isAbortError(error)) return
        setNumberLookup({ kind: 'error', message: lookupErrorMessage(error) })
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [isNumberQuery, trimmedQ, lookupNonce])

  // 命中后跳详情：路由参数只有 canonical ID，编号不进路由（id-inventory 边界）。
  // 用 replace：编号命中是一个「中转」而不是一个值得留在历史里的页面——否则从详情
  // 按返回会回到 /search?q=<编号>、重新挂载重新查询再自动跳走，后退键被弹回。
  useEffect(() => {
    if (numberLookup.kind !== 'hit') return
    void navigate({
      params: { listingId: numberLookup.listingId },
      replace: true,
      to: '/listing/$listingId',
    })
  }, [navigate, numberLookup])

  function update(next: SearchPatch) {
    const nextQ = next.q === undefined ? q : next.q.trim() || undefined
    const nextCategory = next.category === undefined ? category : (next.category ?? undefined)
    const nextFree = next.free === undefined ? free : (next.free ?? undefined)
    const nextSort = next.sort ?? sort

    void navigate({
      to: '/search',
      search: { q: nextQ, category: nextCategory, free: nextFree, sort: nextSort },
    })
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    update({ q: draft })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">搜索商品</h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            {q === undefined ? '浏览全部闲置' : isNumberQuery ? `编号「${q}」` : `关键词「${q}」`} ·{' '}
            {category === undefined ? '全部品类' : CATEGORY_LABEL[category]}
            {free === true ? ' · 只看免费送' : ''}
          </p>
        </div>
        <p className="text-ink-3 text-xs">真实 API · 每页 24 条</p>
      </div>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <form className="flex gap-3" onSubmit={submit}>
          <div className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-xl bg-surface-2 px-4">
            <Search className="size-4 shrink-0 text-ink-3" />
            <Input
              aria-label="搜索商品"
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              maxLength={50}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="搜索标题、描述或 12 位商品编号"
              value={draft}
            />
          </div>
          <Button className="h-11 px-6" type="submit">
            搜索
          </Button>
        </form>

        <div className="mt-4 flex items-start justify-between gap-5">
          <fieldset aria-label="品类筛选" className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
            <button
              aria-pressed={category === undefined}
              className={`h-9 rounded-full px-4 text-sm transition-colors ${
                category === undefined
                  ? 'bg-brand font-semibold text-white'
                  : 'bg-surface-2 text-ink-2 hover:bg-brand-soft hover:text-brand'
              }`}
              onClick={() => update({ category: null })}
              type="button"
            >
              全部
            </button>
            {CATEGORY_OPTIONS.map((option) => {
              const active = category === option.value
              return (
                <button
                  aria-pressed={active}
                  className={`h-9 rounded-full px-4 text-sm transition-colors ${
                    active
                      ? 'bg-brand font-semibold text-white'
                      : 'bg-surface-2 text-ink-2 hover:bg-brand-soft hover:text-brand'
                  }`}
                  key={option.value}
                  onClick={() => update({ category: option.value })}
                  type="button"
                >
                  {option.label}
                </button>
              )
            })}
          </fieldset>

          {/*
           * 「免费送」是**独立筛选维度**，不塞进上面的「品类筛选」fieldset：
           * 品类与它语义不同，混在一个 fieldset 里会让读屏用户听到「品类筛选：免费送」。
           * 它落的是契约的 `free` 布尔位，**不是**「价格为 0」（#451 的口径要求）。
           */}
          <fieldset
            aria-label="免费送筛选"
            className="m-0 flex shrink-0 items-center gap-2 border-0 p-0"
          >
            <button
              aria-pressed={free === true}
              className={`h-9 rounded-full px-4 text-sm transition-colors ${
                free === true
                  ? 'bg-brand font-semibold text-white'
                  : 'bg-surface-2 text-ink-2 hover:bg-brand-soft hover:text-brand'
              }`}
              onClick={() => update({ free: free === true ? null : true })}
              type="button"
            >
              免费送
            </button>
          </fieldset>

          <Select
            onValueChange={(value) => update({ sort: ListingSortSchema.parse(value) })}
            value={sort}
          >
            <SelectTrigger
              aria-label="排序方式"
              className="h-9 w-[142px] shrink-0 rounded-lg border-line bg-surface-2"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>

      {numberHint !== null ? <NumberQueryHint hint={numberHint} /> : null}

      {isNumberQuery ? (
        // 编号精确查询取代关键词结果区：命中即跳详情，未命中是明确空态（不是模糊搜索兜底）。
        <NumberLookupPanel
          onRetry={() => setLookupNonce((nonce) => nonce + 1)}
          phase={numberLookup}
        />
      ) : (
        <>
          {results.isPending ? <LoadingState label="正在搜索商品…" /> : null}
          {results.isError && !results.isFetchNextPageError ? (
            <ErrorState message="搜索加载失败" onRetry={() => void results.refetch()} />
          ) : null}
          {results.isSuccess && items.length === 0 ? (
            <EmptyState
              action={
                <Button
                  onClick={() => update({ q: '', category: null, free: null, sort: 'newest' })}
                  variant="outline"
                >
                  清除筛选
                </Button>
              }
              description="换个关键词或品类试试"
              emoji="🔍"
              title="没有找到商品"
            />
          ) : null}
          {items.length > 0 ? (
            <section aria-label="搜索结果" className="grid grid-cols-4 gap-5">
              {items.map((item) => (
                <PcListingCard item={item} key={item.id} />
              ))}
            </section>
          ) : null}

          {results.isFetchNextPageError ? (
            <ErrorState message="加载更多失败" onRetry={() => void results.fetchNextPage()} />
          ) : null}
          {results.hasNextPage && !results.isFetchNextPageError ? (
            <div className="flex justify-center pt-2">
              <Button
                disabled={results.isFetchingNextPage}
                onClick={() => void results.fetchNextPage()}
                variant="outline"
              >
                {results.isFetchingNextPage ? '正在加载…' : '加载更多'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
