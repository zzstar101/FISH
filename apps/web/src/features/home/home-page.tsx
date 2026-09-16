import { Button } from '@fish/ui/button'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Camera, ScanLine, Search } from 'lucide-react'
import { AppShell } from '../navigation/app-shell'
import { ListingList } from './listing-card'
import { useFeed } from './queries'

export function HomePage() {
  const feed = useFeed()

  return (
    <AppShell>
      {/*
        顶部留白 + 搜索卡片：搜索胶囊、扫码/相机图标、搜索按钮全部收进同一张白卡里，
        卡片用薄边框 + 三层阴影叠出「浮在页面之上」的层次，和下面的内容区留出缝隙。
        header 这一层**保持透明**：只有白卡自己是实心的，卡片四周的留白里能看到内容
        正常滚过去，不会出现一条灰带把下面的内容横着切断。
      */}
      <header className="sticky top-0 z-20 px-3 pt-5 pb-2">
        <div className="flex items-center gap-2 rounded-2xl border border-line bg-surface p-1.5 shadow-[0_1px_2px_rgba(16,17,20,0.05),0_6px_16px_-4px_rgba(16,17,20,0.10),0_16px_36px_-14px_rgba(16,17,20,0.16)]">
          <Button
            asChild
            className="h-10 min-w-0 flex-1 justify-start gap-2 rounded-full bg-surface-2 px-3 text-ink-3 text-sm hover:bg-surface-2"
            variant="ghost"
          >
            <Link search={{ kw: '' }} to="/search">
              <ScanLine className="size-[22px] shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">
                搜校园好物,如 自行车 / 考研资料
              </span>
            </Link>
          </Button>
          <Button aria-label="扫码" asChild className="size-10 shrink-0 rounded-full" size="icon">
            <Link to="/scan">
              <Camera className="size-[22px]" />
            </Link>
          </Button>
          <Button aria-label="搜索" asChild className="size-10 shrink-0 rounded-full" size="icon">
            <Link search={{ kw: '' }} to="/search">
              <Search className="size-5" />
            </Link>
          </Button>
        </div>
      </header>

      {/* 快捷入口（#4）：图书教材 / 数码电子 / 免费送 / 更多分类 */}
      <section className="grid grid-cols-4 gap-2 px-3 py-3">
        <Link
          className="flex flex-col items-center gap-1.5"
          params={{ categoryId: 'books' }}
          to="/category/$categoryId"
        >
          <Button
            className="size-14 rounded-full bg-surface text-[26px] shadow-sm hover:bg-surface"
            size="icon-lg"
            variant="secondary"
          >
            📚
          </Button>
          <span className="text-ink-2 text-xs">图书教材</span>
        </Link>
        <Link
          className="flex flex-col items-center gap-1.5"
          params={{ categoryId: 'digital' }}
          to="/category/$categoryId"
        >
          <Button
            className="size-14 rounded-full bg-surface text-[26px] shadow-sm hover:bg-surface"
            size="icon-lg"
            variant="secondary"
          >
            📱
          </Button>
          <span className="text-ink-2 text-xs">数码电子</span>
        </Link>
        <Link className="flex flex-col items-center gap-1.5" search={{ free: true }} to="/search">
          <Button
            className="size-14 rounded-full bg-surface text-[26px] shadow-sm hover:bg-surface"
            size="icon-lg"
            variant="secondary"
          >
            🎁
          </Button>
          <span className="text-ink-2 text-xs">免费送</span>
        </Link>
        <Link className="flex flex-col items-center gap-1.5" to="/category">
          <Button
            className="size-14 rounded-full bg-surface text-[26px] shadow-sm hover:bg-surface"
            size="icon-lg"
            variant="secondary"
          >
            🧺
          </Button>
          <span className="text-ink-2 text-xs">更多分类</span>
        </Link>
      </section>

      <section className="px-3 pb-4">
        {feed.isPending ? <LoadingState /> : null}
        {feed.isError ? (
          <ErrorState message="首页加载失败" onRetry={() => void feed.refetch()} />
        ) : null}
        {feed.data?.length === 0 ? (
          <EmptyState description="还没有人发布闲置,快去发布第一件吧" emoji="🐟" />
        ) : null}
        {feed.data && feed.data.length > 0 ? <ListingList items={feed.data} /> : null}
      </section>
    </AppShell>
  )
}
