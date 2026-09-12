import type { ReactNode } from 'react'
import { Button } from './button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from './empty'
import { Spinner } from './spinner'

/**
 * Loading / Empty / Error 三态。
 *
 * 这三个不是自研控件，而是 shadcn/ui `Empty` + `Spinner` + `Button` 的 FISH 组合：
 * 三态在 15 个页面里都是同一套尺寸与间距，分散到各页面手写会立刻走样。
 * 需要更自由的三态布局时，直接组合 `@fish/ui/empty` 的原语即可。
 */

/** 三态之一：Loading。 */
export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <Empty className="py-16">
      <Spinner className="size-5 text-primary" />
      <EmptyDescription>{label}</EmptyDescription>
    </Empty>
  )
}

/** 三态之二：Empty。 */
export function EmptyState({
  emoji = '🧩',
  title,
  description,
  action,
}: {
  emoji?: string
  title?: string
  description?: string
  action?: ReactNode
}) {
  return (
    <Empty>
      <EmptyMedia className="mb-0 text-5xl leading-none">{emoji}</EmptyMedia>
      <EmptyHeader className="gap-3">
        {title === undefined ? null : <EmptyTitle>{title}</EmptyTitle>}
        {description === undefined ? null : <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action === undefined ? null : <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}

/** 三态之三：Error。 */
export function ErrorState({
  message = '加载失败，请稍后重试',
  onRetry,
}: {
  message?: string
  onRetry?: () => void
}) {
  return (
    <Empty>
      <EmptyMedia className="mb-0 text-5xl leading-none">😵</EmptyMedia>
      <EmptyDescription className="text-ink-2">{message}</EmptyDescription>
      {onRetry ? (
        <Button onClick={onRetry} size="sm" variant="outline">
          重试
        </Button>
      ) : null}
    </Empty>
  )
}
