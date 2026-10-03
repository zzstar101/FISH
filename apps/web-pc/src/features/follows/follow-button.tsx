import { Button } from '@fish/ui/button'
import { UserRoundCheck, UserRoundPlus } from 'lucide-react'

/** 关注态读取的几种结果（来自 `useFollowState` 的 outcome）。 */
export type FollowReadState = 'loading' | 'following' | 'notFollowing' | 'notFound' | 'unknown'

export type FollowButtonState = {
  label: string
  /** 已关注时按钮换成次要样式，视觉上与未关注区分。 */
  followed: boolean
  enabled: boolean
  hint: string | null
}

/**
 * 关注按钮的状态推导（纯函数）：
 *
 * - 写接口回状态且幂等，所以「已关注」永远可点（再点即取关）；
 * - 状态读到之前不渲染成可点的未关注（避免假翻转），404 降级「无法关注」，
 *   读取失败禁用保重试。
 */
export function followButtonState(input: {
  read: FollowReadState
  pending: boolean
  errorMessage: string | null
}): FollowButtonState {
  if (input.pending) {
    return {
      label: input.read === 'following' ? '取消中…' : '关注中…',
      followed: input.read === 'following',
      enabled: false,
      hint: null,
    }
  }
  if (input.read === 'loading') {
    return { label: '关注', followed: false, enabled: false, hint: null }
  }
  if (input.read === 'notFound') {
    return { label: '无法关注', followed: false, enabled: false, hint: '用户不存在或不可见' }
  }
  if (input.read === 'unknown') {
    return {
      label: '关注',
      followed: false,
      enabled: false,
      hint: input.errorMessage ?? '关注状态读取失败，请刷新重试',
    }
  }
  if (input.read === 'following') {
    return { label: '已关注', followed: true, enabled: true, hint: null }
  }
  return { label: '关注', followed: false, enabled: true, hint: null }
}

/** 他人主页关注钮（props 驱动，供静态渲染测试）；容器接线在 user-profile-page.tsx。 */
export function FollowButtonView({
  state,
  mutual,
  onToggle,
}: {
  state: FollowButtonState
  mutual: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <Button
        disabled={!state.enabled}
        onClick={onToggle}
        type="button"
        variant={state.followed ? 'secondary' : 'default'}
      >
        {state.followed ? (
          <UserRoundCheck className="size-4" />
        ) : (
          <UserRoundPlus className="size-4" />
        )}
        {state.label}
      </Button>
      {mutual ? (
        <p className="mt-2 text-ink-3 text-xs" data-testid="mutual-hint">
          你们互相关注
        </p>
      ) : null}
      {state.hint !== null ? <p className="mt-2 text-ink-3 text-xs">{state.hint}</p> : null}
    </div>
  )
}
