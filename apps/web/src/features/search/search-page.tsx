import type { ListingSort } from '@fish/contracts/listings/schema'
import { Input } from '@fish/ui/input'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Tabs, TabsList, TabsTrigger } from '@fish/ui/tabs'
import { useNavigate } from '@tanstack/react-router'
import { Camera, ChevronLeft, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { meta, useFreeListings, useSearch } from '../home/queries'
import { ListingRow } from './listing-row'

/** 排序口径与 #6 冻结契约一致（ListingSortSchema：newest / priceAsc / priceDesc）。 */
const SORTS = [
  { value: 'newest', label: '最新' },
  { value: 'priceAsc', label: '价格从低' },
  { value: 'priceDesc', label: '价格从高' },
] as const

/** 搜索页（#4）：空态是历史搜索 + 猜你想找；`free` 时是 0 元商品（免费送入口），有 kw 时是结果列表。 */
export function SearchPage({ keyword, free = false }: { keyword: string; free?: boolean }) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(keyword)
  const [sort, setSort] = useState<ListingSort>('newest')
  const [history, setHistory] = useState<string[]>(meta.searchHistory)
  const [suggestions, setSuggestions] = useState<string[]>(meta.searchSuggestions)
  const results = useSearch(free ? '' : keyword, sort)
  const freeResults = useFreeListings(sort)
  const items = free ? (freeResults.data ?? []) : (results.data ?? [])
  const pending = free ? freeResults.isPending : results.isPending
  const error = free ? freeResults.error : results.error
  const retry = () => void (free ? freeResults.refetch() : results.refetch())
  const isEmpty = free
    ? freeResults.isSuccess && items.length === 0
    : results.isSuccess && items.length === 0

  const submit = (value: string) => {
    const next = value.trim()
    if (!next) return
    setDraft(next)
    setHistory((prev) => [next, ...prev.filter((item) => item !== next)].slice(0, 10))
    void navigate({ to: '/search', search: { kw: next } })
  }

  return (
    <div className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-20 flex items-center gap-2 bg-surface px-2 pt-2 pb-2">
        <button
          aria-label="返回"
          className="flex size-9 shrink-0 items-center justify-center text-ink"
          onClick={() => window.history.back()}
          type="button"
        >
          <ChevronLeft className="size-6" />
        </button>
        <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border-2 border-brand px-3">
          <Search className="size-[18px] shrink-0 text-ink-3" />
          <Input
            className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[15px] shadow-none focus-visible:bg-transparent"
            maxLength={50}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit(draft)
            }}
            placeholder="搜索宝贝/帖子/用户"
            value={draft}
          />
          <Camera className="size-[18px] shrink-0 text-ink-3" />
        </div>
        <button
          className="shrink-0 px-1 font-semibold text-[15px] text-ink"
          onClick={() => submit(draft)}
          type="button"
        >
          搜索
        </button>
      </header>

      {!free && keyword.trim() === '' ? (
        <div className="space-y-3 pt-3">
          <section className="bg-surface px-4 py-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-[15px]">历史搜索</h2>
              <button
                className="flex items-center gap-1 text-ink-3 text-xs"
                onClick={() => setHistory([])}
                type="button"
              >
                <Trash2 className="size-3.5" />
                全部
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {history.map((item) => (
                <button
                  className="h-8 rounded-full bg-surface-2 px-3 text-ink-2 text-sm"
                  key={item}
                  onClick={() => submit(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
              {history.length === 0 ? <span className="text-ink-3 text-sm">暂无历史</span> : null}
            </div>
          </section>

          <section className="bg-surface px-4 py-3">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold text-[15px]">猜你可能在找</h2>
              <button
                aria-label="换一批"
                className="text-ink-3"
                onClick={() => setSuggestions((prev) => [...prev.slice(1), prev[0] ?? '考研资料'])}
                type="button"
              >
                <RefreshCw className="size-[18px]" />
              </button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((item) => (
                <button
                  className="h-8 rounded-full bg-surface-2 px-3 text-ink-2 text-sm"
                  key={item}
                  onClick={() => submit(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 bg-surface px-4 py-2.5">
            <span className="truncate text-sm">
              <span className="font-semibold">“{free ? '免费送' : keyword}”</span>{' '}
              {items.length > 0 ? <span className="text-ink-3">{items.length} 件</span> : null}
            </span>
            <Tabs
              className="shrink-0"
              onValueChange={(next) => setSort(next as ListingSort)}
              value={sort}
            >
              <TabsList>
                {SORTS.map((option) => (
                  <TabsTrigger className="px-3" key={option.value} value={option.value}>
                    {option.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="mt-2 px-3 pb-6">
            {pending ? <LoadingState /> : null}
            {error ? <ErrorState message="搜索失败,请稍后重试" onRetry={retry} /> : null}
            {isEmpty ? (
              <EmptyState
                description={`没有找到与「${free ? '免费送' : keyword}」相关的闲置`}
                emoji="🔍"
              />
            ) : null}
            {items.length > 0 ? (
              <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface">
                {items.map((item) => (
                  <ListingRow item={item} key={item.id} />
                ))}
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
