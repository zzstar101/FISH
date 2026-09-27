import { Button } from '@fish/ui/button'
import { EmptyState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { Home, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { PcShell } from './pc-shell'

function FallbackContent({
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
    <div className="grid min-h-[calc(100dvh-8rem)] place-items-center">
      <EmptyState action={action} description={description} emoji={emoji} title={title} />
    </div>
  )
}

/** 根级运行时错误页：错误会替换 RootLayout，因此这里自行补回 PC 外壳。 */
export function RouteErrorPage({ reset }: { reset: () => void }) {
  return (
    <PcShell>
      <FallbackContent
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
    </PcShell>
  )
}

/** 404 内容不自己套 PcShell；由 RootChrome 或外层路由边界决定外壳层级。 */
export function RouteNotFoundPage() {
  return (
    <FallbackContent
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
      description="这个地址不存在，或者页面已经下线。"
      emoji="🧭"
      title="页面不存在"
    />
  )
}
