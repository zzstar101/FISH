import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { ChevronRight } from 'lucide-react'
import { formatRelativeTimeAt } from '../../lib/format'
import { notificationCopy, notificationTarget } from './notification-view'

type NotificationRowProps = {
  item: NotificationDto
  onOpen: (item: NotificationDto) => void
}

export function NotificationRow({ item, onOpen }: NotificationRowProps) {
  const copy = notificationCopy(item)
  const target = notificationTarget(item)
  const unread = item.readAt === null

  return (
    <button
      className={`group flex w-full items-start gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-2 ${
        unread ? 'bg-brand-soft/35' : ''
      }`}
      onClick={() => onOpen(item)}
      type="button"
    >
      <span className="relative mt-0.5 grid size-11 shrink-0 place-items-center rounded-full bg-brand-soft text-xl">
        <span aria-hidden>{copy.emoji}</span>
        {unread ? (
          <span className="absolute top-0 right-0 size-2.5 rounded-full bg-danger ring-2 ring-surface" />
        ) : null}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span
            className={`truncate text-[15px] ${unread ? 'font-semibold' : 'font-medium text-ink-2'}`}
          >
            {copy.title}
          </span>
          <span className="shrink-0 text-ink-3 text-xs">
            {formatRelativeTimeAt(item.createdAt)}
          </span>
        </span>
        <span className="mt-1 block line-clamp-2 text-ink-2 text-sm leading-6">
          {copy.description}
        </span>
      </span>

      {target.kind === 'none' ? null : (
        <ChevronRight className="mt-3 size-[18px] shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
      )}
    </button>
  )
}
