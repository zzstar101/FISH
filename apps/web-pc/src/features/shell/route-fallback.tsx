import { Button } from '@fish/ui/button'
import { EmptyState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Home, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { PcShell } from './pc-shell'

function RouteFallback({
  emoji,
  title,
  description,
  action,
}: {
  emoji: string
  title: string
  description: string
  action: ReactNode
}) {
  return (
    <PcShell>
      <div className="grid min-h-[calc(100dvh-8rem)] place-items-center">
        <EmptyState action={action} description={description} emoji={emoji} title={title} />
      </div>
    </PcShell>
  )
}

/** 根级运行时错误页：保留 PC 顶栏和侧栏，提供重试与返回首页。 */
export function RouteErrorPage({ reset }: { reset: () => void }) {
  return (
    <RouteFallback
      action={
        <div className="flex items-center gap-3">
          <Button onClick={reset} type="button" variant="outline">
            <RotateCcw className="size-4" />
            重试
          </Button>
          <Button asChild>
            <Link to="/">
              <Home className="size-4" />
              返回首页
            </Link>
          </Button>
        </div>
      }
      description="页面运行时出现问题。可以重试，或返回首页继续浏览。"
      emoji="😵"
      title="页面加载失败"
    />
  )
}

/** PC 命名空间内的 404：不落回移动端页面，也不整页白屏。 */
export function RouteNotFoundPage() {
  return (
    <RouteFallback
      action={
        <div className="flex items-center gap-3">
          <Button asChild variant="outline">
            <Link to="/search">去搜索</Link>
          </Button>
          <Button asChild>
            <Link to="/">
              <Home className="size-4" />
              返回首页
            </Link>
          </Button>
        </div>
      }
      description="这个地址不存在，或页面已经下线。"
      emoji="🧭"
      title="页面不存在"
    />
  )
}
