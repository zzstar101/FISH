import type { AuthStatus } from '@fish/contracts/auth/user'
import { Badge } from '@fish/ui/badge'

/** 认证徽章的文案只有两态，没有「审核中」（#3 冻结契约）。 */
const LABELS: Record<AuthStatus, string> = {
  VERIFIED: '学生认证',
  UNVERIFIED: '未认证',
}

/**
 * 认证徽章。判据只有 `authStatus === 'VERIFIED'`。
 * #5 的卖家展示与 #12 的个人页复用本组件与同一份 `AuthStatus` 类型，不要各自造。
 * 底色走 shadcn `Badge` 的 `success` / `secondary` 变体。
 */
export function AuthBadge({ status, className = '' }: { status: AuthStatus; className?: string }) {
  const verified = status === 'VERIFIED'
  return (
    <Badge
      className={`h-auto px-1.5 py-0.5 ${verified ? '' : 'text-ink-3'} ${className}`}
      variant={verified ? 'success' : 'secondary'}
    >
      {LABELS[status]}
    </Badge>
  )
}

/** 卡片底部的内联认证文案（蓝色小字），用于瀑布流卡片这类紧凑场景。 */
export function VerifiedText({ className = '' }: { className?: string }) {
  return <span className={`shrink-0 text-brand text-xs ${className}`}>学生认证</span>
}
