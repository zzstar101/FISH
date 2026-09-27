import { Thumb, type Tone } from '@fish/ui/thumb'
import { type CSSProperties, useMemo } from 'react'

/**
 * 商品封面位：有 `coverUrl` 渲染真实图片（#6 读契约拼好的公开 URL），
 * 没有时回落到渐变占位。占位色按商品 id 稳定散列——同一张卡片每次渲染
 * 都是同一个颜色，但不同商品之间有变化，替代 Mock 时代的 `tone` 字段
 * （契约里没有它，不允许伪造数据字段，占位色属于纯展示层推导）。
 */
const TONES: Tone[] = ['violet', 'sky', 'mint', 'rose', 'sand', 'lilac', 'blue', 'warn']

function toneFor(id: string): Tone {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  return TONES[Math.abs(hash) % TONES.length] as Tone
}

export function ListingThumb({
  listingId,
  coverUrl,
  alt,
  className = 'size-24 rounded-2xl',
  emojiClassName,
  style,
}: {
  listingId: string
  coverUrl: string | null
  alt: string
  className?: string
  emojiClassName?: string
  style?: CSSProperties
}) {
  const tone = useMemo(() => toneFor(listingId), [listingId])

  if (coverUrl) {
    return (
      <img
        alt={alt}
        className={`shrink-0 object-cover ${className}`}
        loading="lazy"
        src={coverUrl}
        style={style}
      />
    )
  }
  return (
    <Thumb
      className={className}
      emoji="📦"
      emojiClassName={emojiClassName}
      style={style}
      tone={tone}
    >
      {/* 占位时把 alt 交给容器，保证可访问性与真实图片一致 */}
      <span className="sr-only">{alt}</span>
    </Thumb>
  )
}
