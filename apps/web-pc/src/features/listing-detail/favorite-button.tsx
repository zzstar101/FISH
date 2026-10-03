import { Button } from '@fish/ui/button'
import { Heart } from 'lucide-react'

/** 收藏态读取的四种结果（来自 `useFavoriteState` 的 outcome）。 */
export type FavoriteReadState = 'loading' | 'favorited' | 'notFavorited' | 'notFound' | 'unknown'

export type FavoriteButtonState = {
  label: string
  /** 已收藏时心形实心，视觉上与未收藏区分。 */
  filled: boolean
  enabled: boolean
  hint: string | null
}

/**
 * 收藏心按钮的状态推导（纯函数）：
 *
 * - 判据不对称来自服务端（`apps/api/src/modules/favorites/service.ts`）：POST 只对在售商品可用，
 *   GET 镜像详情可见性（已售/已预定读得到），DELETE 无条件幂等——所以「已收藏」永远可点（取消），
 *   「未收藏」只在 ACTIVE 可点；
 * - 状态读到之前不渲染成可点的未收藏（避免假翻转），404 降级「不可收藏」，读取失败禁用保重试。
 */
export function favoriteButtonState(input: {
  read: FavoriteReadState
  status: 'ACTIVE' | 'RESERVED' | 'SOLD' | 'OFFLINE'
  pending: boolean
  errorMessage: string | null
}): FavoriteButtonState {
  if (input.pending) {
    return {
      label: input.read === 'favorited' ? '取消中…' : '收藏中…',
      filled: input.read === 'favorited',
      enabled: false,
      hint: null,
    }
  }
  if (input.read === 'loading') {
    return { label: '收藏', filled: false, enabled: false, hint: null }
  }
  if (input.read === 'notFound') {
    return { label: '不可收藏', filled: false, enabled: false, hint: '商品当前不可收藏' }
  }
  if (input.read === 'unknown') {
    return {
      label: '收藏',
      filled: false,
      enabled: false,
      hint: input.errorMessage ?? '收藏状态读取失败，请刷新重试',
    }
  }
  if (input.read === 'favorited') {
    // 已收藏：即使商品已售出/下架也可取消（DELETE 无条件幂等）。
    return { label: '已收藏', filled: true, enabled: true, hint: null }
  }
  if (input.status === 'ACTIVE') {
    return { label: '收藏', filled: false, enabled: true, hint: null }
  }
  return { label: '收藏', filled: false, enabled: false, hint: '商品当前不可收藏' }
}

/** 详情页收藏心（props 驱动，供静态渲染测试）；容器接线在 detail-page.tsx。 */
export function FavoriteButtonView({
  state,
  onToggle,
}: {
  state: FavoriteButtonState
  onToggle: () => void
}) {
  return (
    <div>
      <Button
        className="w-full"
        disabled={!state.enabled}
        onClick={onToggle}
        type="button"
        variant={state.filled ? 'secondary' : 'outline'}
      >
        <Heart className={`size-4 ${state.filled ? 'fill-current' : ''}`} />
        {state.label}
      </Button>
      {state.hint !== null ? <p className="mt-2 text-ink-3 text-xs">{state.hint}</p> : null}
    </div>
  )
}
