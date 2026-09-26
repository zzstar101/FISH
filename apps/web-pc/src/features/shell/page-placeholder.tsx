import { Card } from '@fish/ui/card'
import { Link } from '@tanstack/react-router'

/** 骨架阶段占位页：说明路由已接好，业务内容留到后续 Issue。 */
export function PagePlaceholder({
  title,
  description,
  actionLabel = '返回首页',
  actionTo = '/',
}: {
  title: string
  description: string
  actionLabel?: string
  actionTo?: '/' | '/search' | '/publish' | '/messages' | '/notifications' | '/profile' | '/wish'
}) {
  return (
    <div>
      <h1 className="font-semibold text-2xl tracking-[-0.03em]">{title}</h1>
      <Card className="mt-6 gap-0 border border-line p-8">
        <p className="max-w-[620px] text-ink-2 text-sm leading-7">{description}</p>
        <Link
          className="mt-5 w-fit rounded-lg bg-brand px-4 py-2 font-medium text-sm text-white transition-colors hover:bg-brand-deep"
          to={actionTo}
        >
          {actionLabel}
        </Link>
      </Card>
    </div>
  )
}
