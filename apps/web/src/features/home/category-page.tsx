import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Heart, Search } from 'lucide-react'
import { useState } from 'react'
import { meta, useCategoryListings } from '../home/queries'
import { ListingRow } from '../search/listing-row'

/** 分类页（#4）。默认落在第一个分类（数码电子），与截图一致。 */
export function CategoryPage({ categoryId }: { categoryId?: string }) {
  const activeId = categoryId ?? meta.categories[0]?.id ?? 'digital'
  const active = meta.categories.find((item) => item.id === activeId) ?? meta.categories[0]
  const list = useCategoryListings(active?.label ?? null)
  // 二级分类是页面内的过滤（点同一个再点一次取消）；不跳转，避免原地导航。
  const [childId, setChildId] = useState<string | null>(null)
  const activeChild = active?.children.find((item) => item.id === childId) ?? null
  const visible = activeChild
    ? (list.data ?? []).filter(
        (item) =>
          item.title.includes(activeChild.label) || item.category.includes(activeChild.label),
      )
    : (list.data ?? [])

  return (
    <div className="min-h-dvh bg-bg">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar
          onBack={() => window.history.back()}
          right={
            <Link
              aria-label="我的收藏"
              className="flex size-9 items-center justify-center"
              to="/mylist"
              search={{ type: 'fav' }}
            >
              <Heart className="size-5 text-ink" />
            </Link>
          }
          title={
            <Link
              className="mx-auto flex h-8 max-w-[240px] items-center gap-2 rounded-full bg-surface-2 px-3 font-normal text-ink-3 text-sm"
              search={{ kw: '' }}
              to="/search"
            >
              <Search className="size-4 shrink-0" />
              <span className="truncate">搜索分类下的闲置</span>
            </Link>
          }
        />
      </div>

      <div className="flex items-start">
        <nav className="w-[92px] shrink-0 self-stretch bg-rail pb-6">
          {meta.categories.map((item) => {
            const isActive = item.id === activeId
            return (
              <Link
                className={`relative flex flex-col items-center gap-1 py-3.5 text-xs ${
                  isActive ? 'bg-bg font-medium text-brand' : 'text-ink-2'
                }`}
                key={item.id}
                params={{ categoryId: item.id }}
                to="/category/$categoryId"
              >
                {isActive ? (
                  <span className="absolute top-1/2 left-0 h-6 w-[3px] -translate-y-1/2 rounded-r bg-brand" />
                ) : null}
                <span className="text-2xl leading-none">{item.emoji}</span>
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className="min-w-0 flex-1 pb-6">
          <h2 className="flex items-center gap-1.5 px-3 pt-3 pb-2 font-semibold text-[15px]">
            <span className="h-4 w-[3px] rounded bg-brand" />
            {active?.label} · 全分类
          </h2>
          <div className="grid grid-cols-3 gap-2 px-3">
            {active?.children.map((child) => (
              <button
                className={`flex flex-col items-center gap-1.5 rounded-xl py-3 ${
                  activeChild?.id === child.id ? 'bg-brand-soft ring-2 ring-brand' : 'bg-surface'
                }`}
                key={child.id}
                onClick={() => setChildId(activeChild?.id === child.id ? null : child.id)}
                type="button"
              >
                <span className="text-[26px] leading-none">{child.emoji}</span>
                <span className="text-ink-2 text-xs">{child.label}</span>
              </button>
            ))}
          </div>

          <h2 className="flex items-baseline justify-between px-3 pt-5 pb-2 font-semibold text-[15px]">
            {activeChild ? `${activeChild.label} · 热门闲置` : '热门闲置'}
            <span className="font-normal text-ink-3 text-xs">{visible.length} 件</span>
          </h2>

          {list.isPending ? <LoadingState /> : null}
          {list.isError ? (
            <ErrorState message="分类加载失败" onRetry={() => void list.refetch()} />
          ) : null}
          {!list.isPending && visible.length === 0 ? (
            <EmptyState description="这个分类还没有闲置" emoji="📦" />
          ) : null}
          {visible.length > 0 ? (
            <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface">
              {visible.map((item) => (
                <ListingRow item={item} key={item.id} showTime={false} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
