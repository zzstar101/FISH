import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import type { NumberLookupPhase } from './number-lookup'

/**
 * 编号查询结果面板（#382）：props 驱动、不 import router 也不发请求，
 * 可用 `renderToStaticMarkup` 直接测。由搜索页在「输入是合法编号」时渲染，
 * 取代关键词搜索结果区（验收：未命中是明确空态，不把编号当关键词模糊搜）。
 */
export type NumberLookupPanelProps = {
  phase: NumberLookupPhase
  onRetry: () => void
}

export function NumberLookupPanel({ phase, onRetry }: NumberLookupPanelProps) {
  if (phase.kind === 'idle' || phase.kind === 'hit') return null

  if (phase.kind === 'loading') {
    return <LoadingState label={`正在查询编号 ${phase.listingNo}…`} />
  }

  if (phase.kind === 'miss') {
    return (
      <EmptyState
        // 404 的语义是「不存在 / 已下架 / 对你不可见」三合一（服务端不做存在性 oracle），
        // 文案把三种可能都摆出来，不让用户误以为一定是编号敲错。
        description="编号不存在、商品已下架或当前不可见；可向卖家核对后再试。"
        emoji="🔢"
        title={`编号 ${phase.listingNo} 没有对应的商品`}
      />
    )
  }

  return <ErrorState message={phase.message} onRetry={onRetry} />
}

/** 「像编号但不合法」的行内提示（合法编号走查询面板；普通关键词没有这段）。 */
export function NumberQueryHint({ hint }: { hint: string | null }) {
  if (hint === null) return null
  return (
    <p className="rounded-xl bg-warn-soft px-4 py-3 text-sm text-warn" role="status">
      {hint}
    </p>
  )
}
