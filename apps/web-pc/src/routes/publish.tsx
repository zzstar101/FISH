import { createFileRoute } from '@tanstack/react-router'
import { PagePlaceholder } from '../features/shell/page-placeholder'

export const Route = createFileRoute('/publish')({ component: PublishPage })

function PublishPage() {
  return (
    <PagePlaceholder
      actionLabel="返回首页"
      description="发布路由已接通。图片上传、AI 润色和 POST /listings 将在发布主链 Issue 实现。"
      title="发布闲置"
    />
  )
}
