import { Check, Copy } from 'lucide-react'
import { useRef, useState } from 'react'
import { copyText } from '../../lib/copy-text'

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * 详情页的公开编号行（#382）：`编号 348572910466 [复制]`。
 *
 * 组件**只收 `listingNo` 字符串**——内部 UUID 根本传不进来，想显示也没材料
 * （验收：不显示内部 UUID；编号是给人看的公开引用）。
 * 复制成功给 2 秒「已复制」反馈；失败（非安全上下文 / 权限被拒）显示「复制失败」，
 * 用户仍可手动选中复制。
 */
export function ListingNoLine({ listingNo }: { listingNo: string }) {
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function handleCopy() {
    const ok = await copyText(listingNo)
    setCopyState(ok ? 'copied' : 'failed')
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopyState('idle'), 2_000)
  }

  return (
    <p className="mt-2 flex items-center gap-1.5 text-ink-3 text-xs">
      <span>编号</span>
      <span className="font-mono tracking-[0.08em]">{listingNo}</span>
      <button
        aria-label={`复制商品编号 ${listingNo}`}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
        onClick={() => void handleCopy()}
        type="button"
      >
        {copyState === 'copied' ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制'}
      </button>
    </p>
  )
}
