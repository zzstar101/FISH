import { createFileRoute } from '@tanstack/react-router'
import { SearchPage } from '../features/search/search-page'

export const Route = createFileRoute('/search')({
  // kw / free 都可选：`<Link search={{ free: true }}>`（免费送入口）与
  // `<Link search={{ kw }}>`（关键词搜索）各自只关心自己的参数。
  validateSearch: (search: Record<string, unknown>) => {
    const out: { kw?: string; free?: boolean } = {}
    if (typeof search.kw === 'string') out.kw = search.kw
    if (search.free === true) out.free = true
    return out
  },
  component: () => {
    const { kw = '', free = false } = Route.useSearch()
    return <SearchPage free={free} keyword={kw} />
  },
})
