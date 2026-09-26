import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../features/shell/page-placeholder'

type SearchParams = { q?: string }

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    q: typeof search.q === 'string' && search.q.length > 0 ? search.q : undefined,
  }),
  component: SearchPage,
})

function SearchPage() {
  const { q } = Route.useSearch()
  return (
    <PagePlaceholder
      actionLabel="返回首页"
      description={`搜索路由已经接通 PC Web basepath。当前关键词：${q ?? '未输入'}。真实搜索接口将在下一个 Issue 接入。`}
      title="搜索结果"
    />
  )
}
