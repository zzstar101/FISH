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
}

export function SearchPage({ q, category, sort = 'newest' }: PcSearchParams) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(q ?? '')
  const results = useListingSearch({ q, category, sort })
  const items = results.data?.pages.flatMap((page) => page.items) ?? []

  useEffect(() => {
    setDraft(q ?? '')
  }, [q])

  function update(next: SearchPatch) {
    const nextQ = next.q === undefined ? q : next.q.trim() || undefined
    const nextCategory = next.category === undefined ? category : (next.category ?? undefined)
    const nextSort = next.sort ?? sort

    void navigate({
      to: '/search',
      search: { q: nextQ, category: nextCategory, sort: nextSort },
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
            {q === undefined ? '浏览全部闲置' : `关键词「${q}」`} ·{' '}
            {category === undefined ? '全部品类' : CATEGORY_LABEL[category]}
          </p>
        </div>
        <p className="text-ink-3 text-xs">真实 API · 每页 24 条</p>
      </div>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <form className="flex gap-3" onSubmit={submit}>
          <div className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-xl bg-surface-2 px-4">
            <Search className="size-4 shrink-0 text-ink-3" />
            <Input
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              maxLength={50}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="搜索标题或描述"
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

          <Select
            onValueChange={(value) => update({ sort: ListingSortSchema.parse(value) })}
            value={sort}
          >
            <SelectTrigger className="h-9 w-[142px] shrink-0 rounded-lg border-line bg-surface-2">
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

      {results.isPending ? <LoadingState label="正在搜索商品…" /> : null}
      {results.isError && !results.isFetchNextPageError ? (
        <ErrorState message="搜索加载失败" onRetry={() => void results.refetch()} />
      ) : null}
      {results.isSuccess && items.length === 0 ? (
        <EmptyState
          action={
            <Button
              onClick={() => update({ q: '', category: null, sort: 'newest' })}
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
    </div>
  )
}
