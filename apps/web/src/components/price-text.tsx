import { formatPrice } from '../lib/format'

/**
 * 卡片里的价格：付费商品红色（`danger`），免费送保留品牌色。
 * `¥` 符号单独渲染并缩小，做出「小币种符号 + 大数字」的价格层级。
 */
export function PriceText({
  className = '',
  cents,
  symbolClassName = '',
}: {
  className?: string
  cents: number
  symbolClassName?: string
}) {
  if (cents === 0) {
    return <span className={className}>免费送</span>
  }

  return (
    <span className={`text-danger ${className}`}>
      <span className={symbolClassName}>¥</span>
      {formatPrice(cents).slice(1)}
    </span>
  )
}
