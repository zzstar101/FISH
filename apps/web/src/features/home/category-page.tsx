import { cn } from '@fish/ui/lib/utils'
import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Heart, Search } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { CATEGORY_IDS } from '../../lib/labels'
import { ListingList } from './listing-card'
import { meta, useCategoryListings } from './queries'

/**
 * 分类页（#4）。内容布局与首页保持一致：顶部头部 → 横滑分类条 → 双列瀑布流。
 *
 * 相对旧版的三处改动：
 * 1. 左侧竖排分类栏去掉，改成顶部**横滑**分类条——一屏放不下就往右滑，因此不再需要
 *    「更多分类」这个入口；横滑条不显示滚动条（`styles.css` 的 `no-scrollbar`）。
 * 2. **不做二级分类**：旧版右栏那个三列子类网格整块删掉，分类页只看整类，不再按子类过滤。
 * 3. 商品列表从单列 `ListingRow` 换成首页那套双列瀑布流（`ListingList`），卡片与首页同款。
 *
 * 顶部刻意**保留本页原有的 `NavBar`**（返回键在左上角），不换成首页那条搜索头部——
 * 首页头部没有返回键，换上去分类页就没有出口了。
 */
export function CategoryPage({ categoryId }: { categoryId?: string }) {
  /*
   * `active` 只解析一次，`activeId` 再由它反推。
   * 不能直接拿路由参数当高亮依据：`category.$categoryId.tsx` 没有校验，`/category/foo`
   * 这种地址会落到第一个分类的内容上，却一个高亮都没有——改掉两行 h2 之后，
   * 高亮是「当前在看哪一类」的唯一提示，对不上就等于页面没有状态。
   */
  const active = meta.categories.find((item) => item.id === categoryId) ?? meta.categories[0]
  const activeId = active?.id
  // 路由参数是导航 id（digital 等），请求要用 #6 契约的枚举（DIGITAL 等）。
  const list = useCategoryListings(activeId ? (CATEGORY_IDS[activeId] ?? null) : null)
  const visible = list.data ?? []

  const railRef = useRef<HTMLElement | null>(null)
  const activeRef = useRef<HTMLAnchorElement | null>(null)

  /*
   * 深链 / 刷新时把当前分类滚进可视区：横滑条默认停在最左边，
   * `/category/transport`（第 6 个）之后的分类会连高亮都看不见。
   * 用 rect 差值算居中量、不用 `scrollIntoView`——后者会连带把整页纵向滚走。
   */
  useLayoutEffect(() => {
    const rail = railRef.current
    const item = activeRef.current
    // 没解析出当前分类（分类表为空）就没有要滚的目标；这条守卫同时是 `activeId` 的真实用途，
    // 保证切换分类时这个 effect 必然重跑。
    if (!activeId || !rail || !item) return
    const railRect = rail.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    // 只在该项真的被遮住时才滚：否则点一个本来就完整可见的分类，松手后横滑条还会自己滑一下。
    if (itemRect.left >= railRect.left && itemRect.right <= railRect.right) return
    rail.scrollLeft += itemRect.left - railRect.left - (rail.clientWidth - itemRect.width) / 2
  }, [activeId])

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

      {/*
        横滑分类条：一屏只放得下 4 个左右，其余往右滑；刻意不做「更多分类」入口。
        每个分类就是一个普通链接，点谁就切到谁，没有展开/收起。
        旧版这里是 `<nav>`，所以这里也用 nav（`aria-label` 让它成为导航 landmark），
        `px-3` 与下面内容区对齐，`aria-current` 标出当前在看哪一类。
      */}
      <nav
        aria-label="商品分类"
        className="no-scrollbar flex gap-1 overflow-x-auto px-3 py-2"
        ref={railRef}
      >
        {meta.categories.map((item) => {
          const isActive = item.id === activeId
          return (
            <Link
              aria-current={isActive ? 'page' : undefined}
              className="flex w-[74px] shrink-0 flex-col items-center gap-1.5"
              key={item.id}
              params={{ categoryId: item.id }}
              ref={isActive ? activeRef : undefined}
              to="/category/$categoryId"
            >
              <span
                className={cn(
                  'relative flex size-14 items-center justify-center rounded-full',
                  isActive && 'ring-2 ring-brand',
                )}
              >
                <span
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-gradient-to-b from-[#E7EDF6] to-white opacity-40"
                />
                <img alt="" className="size-14 object-cover" src={item.image} />
              </span>
              {/* 高亮文字用 `text-lavender` 而不是 `text-brand`：后者是 12px 文字，
                  在 `bg-bg` 上只有 3.48:1；lavender 是品牌蓝最深档，4.76:1 过线。 */}
              <span
                className={cn('text-xs', isActive ? 'font-medium text-lavender' : 'text-ink-2')}
              >
                {item.label}
              </span>
            </Link>
          )
        })}
      </nav>

      {/* 商品：与首页同一套双列瀑布流。 */}
      <section className="px-3 pb-4">
        {list.isPending ? <LoadingState /> : null}
        {list.isError ? (
          <ErrorState message="分类加载失败" onRetry={() => void list.refetch()} />
        ) : null}
        {/*
          空态必须把 isError 排除掉：出错时 `data` 是 undefined、`isPending` 也是 false，
          只判 `visible.length === 0` 会让「这个分类还没有闲置」叠在错误提示下面。
        */}
        {!list.isPending && !list.isError && visible.length === 0 ? (
          <EmptyState description="这个分类还没有闲置" emoji="📦" />
        ) : null}
        {visible.length > 0 ? <ListingList items={visible} /> : null}
      </section>
    </div>
  )
}
