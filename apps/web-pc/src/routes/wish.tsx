import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../features/shell/page-placeholder'

export const Route = createFileRoute('/wish')({ component: WishPage })

function WishPage() {
  return (
    <PagePlaceholder
      actionLabel="返回首页"
      description="许愿墙路由已接通。许愿池、愿望表单和匹配列表将在许愿主链 Issue 实现。"
      title="许愿墙"
    />
  )
}
