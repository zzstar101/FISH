import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { Thumb } from '@fish/ui/thumb'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import { Clock } from 'lucide-react'
import { MotionConfig, motion, useAnimate } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PriceText } from '../../components/price-text'
import { formatRelativeTime } from '../../lib/format'
import type { ListingView } from '../../lib/mock/store'
import { VerifiedText } from '../auth/auth-badge'

/**
 * 瀑布流里同一个卡片的三种图高（px），按索引轮流取。
 * 差异只放在图片上：矮→高→最高相差 70px，两列的错落感由此而来。
 */
const THUMB_HEIGHTS = [150, 185, 220]

/** 纵向卡片（首页瀑布流）：图上、信息下。高度由瀑布流算好后传进来。 */
export function ListingCard({
  item,
  index = 0,
  height,
}: {
  item: ListingView
  index?: number
  height?: number
}) {
  const thumbHeight = THUMB_HEIGHTS[index % THUMB_HEIGHTS.length] as number

  return (
    <Link
      className="block h-full"
      params={{ listingId: item.id }}
      style={height === undefined ? undefined : { height }}
      to="/detail/$listingId"
    >
      <Card className="gap-0 p-0">
        <div className="relative shrink-0">
          <Thumb className="w-full" style={{ height: thumbHeight }} tone={item.tone} />
          {item.tags.includes('急出') ? (
            <Badge
              className="absolute top-2 left-2 h-auto px-1.5 py-0.5 text-[10px]"
              variant="destructive"
            >
              急出
            </Badge>
          ) : null}
        </div>
        <div className="flex min-h-[148px] flex-1 flex-col p-2.5">
          <p className="line-clamp-2 min-h-9 text-[13px] text-ink leading-snug">{item.title}</p>
          <p className="mt-1.5 flex items-center gap-1 text-[11px] text-ink-3">
            <Clock className="size-3" />
            {formatRelativeTime(item.publishedMinutesAgo)}发布
          </p>
          <p className="mt-1.5 flex items-baseline gap-1.5">
            <PriceText
              cents={item.priceCents}
              className="font-bold text-[17px]"
              symbolClassName="text-[12px]"
            />
            {item.free ? null : (
              <span className="text-[11px] text-ink-3">{item.wantCount}人想要</span>
            )}
          </p>
          <p className="mt-auto flex items-center gap-1.5 pt-1.5">
            <UserAvatar
              className="size-4"
              emoji={item.seller.emoji}
              fallbackClassName="text-[10px]"
              size="sm"
              tone={item.seller.tone}
            />
            <span className="truncate text-[11px] text-ink-2">{item.seller.nickname}</span>
            {item.seller.verified ? (
              <VerifiedText />
            ) : (
              <span className="shrink-0 text-[11px] text-warn">信用 {item.seller.credit}</span>
            )}
          </p>
        </div>
      </Card>
    </Link>
  )
}

/** 入场起点：屏幕下缘再往外一点，React Bits Masonry 的 `animateFrom="bottom"` 同款。 */
const SLIDE_FROM = 40

/** 两列间距。 */
const GUTTER = 10

/** 信息区固定高度（实测 148px）：卡片总高 = 图高 + 它。 */
const INFO_HEIGHT = 148

/** 卡片总高：只由图高决定，所以布局可以在渲染前算准。 */
function cardHeight(index: number): number {
  return (THUMB_HEIGHTS[index % THUMB_HEIGHTS.length] as number) + INFO_HEIGHT
}

type Placement = {
  id: string
  index: number
  item: ListingView
  w: number
  h: number
  left: number
  top: number
}

/**
 * 瀑布流摆放：每张卡片都 `absolute`，逐张放进「当前最矮的那一列」，
 * 并拿到自己的最终 x/y —— 这就是 React Bits Masonry 的算法，
 * 和「按奇偶分列」的区别是它按真实高度平衡两列。
 */
function buildGrid(items: ListingView[], containerWidth: number, columns: number): Placement[] {
  if (containerWidth <= 0) return []

  const columnWidth = (containerWidth - GUTTER * (columns - 1)) / columns
  const columnHeights = new Array<number>(columns).fill(0)

  return items.map((item, index) => {
    let column = 0
    for (let i = 1; i < columns; i++) {
      if ((columnHeights[i] ?? 0) < (columnHeights[column] ?? 0)) column = i
    }

    const height = cardHeight(index)
    const top = columnHeights[column] ?? 0
    const placement: Placement = {
      h: height,
      id: item.id,
      index,
      item,
      left: column * (columnWidth + GUTTER),
      top,
      w: columnWidth,
    }
    columnHeights[column] = top + height + GUTTER

    return placement
  })
}

/** 两列瀑布流：按高度平衡摆放，卡片从屏幕下方滑入 + 从模糊到清晰。 */
export function ListingList({ items }: { items: ListingView[] }) {
  const columns = 2
  const [scope, animate] = useAnimate<HTMLDivElement>()
  const [width, setWidth] = useState(0)

  // 容器只做尺寸观察：卡片全部 absolute，量自己不会形成「量了→变了→再量」的循环。
  useLayoutEffect(() => {
    const node = scope.current
    if (!node) return
    setWidth(node.clientWidth)
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [scope])

  const grid = useMemo(() => buildGrid(items, width, columns), [items, width])
  const containerHeight = grid.reduce((tallest, cell) => Math.max(tallest, cell.top + cell.h), 0)
  const entered = useRef(false)

  /**
   * 只播一次入场：最终位置由 style 给出，动画负责「从屏幕下方滑到位 + 模糊转清晰」。
   * 位移用百分比：`-100%` 是自己的高度，`1044%` 才等于 GSAP 里的 `innerHeight + 200`。
   */
  useEffect(() => {
    if (entered.current || grid.length === 0) return
    entered.current = true

    const controls = grid.map((cell) =>
      animate(
        `[data-key="${cell.id}"] > *`,
        {
          filter: ['blur(8px)', 'blur(0px)'],
          opacity: [0, 1],
          y: [window.innerHeight + SLIDE_FROM, 0],
        },
        { delay: Math.min(cell.index, 12) * 0.02, duration: 0.34, ease: [0.22, 1, 0.36, 1] },
      ),
    )

    return () => {
      for (const control of controls) control.stop()
    }
  }, [animate, grid])

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative" ref={scope} style={{ height: containerHeight || '100dvh' }}>
        {grid.map((cell) => (
          <div
            className="absolute top-0 left-0 transition-transform duration-300 ease-out hover:scale-[0.96]"
            data-key={cell.id}
            key={cell.id}
            style={{ height: cell.h, left: cell.left, top: cell.top, width: cell.w }}
          >
            {/* 入场动画只碰 opacity / blur / y，缩放交给外层，两者不争同一个 transform */}
            <motion.div className="h-full">
              <ListingCard height={cell.h} index={cell.index} item={cell.item} />
            </motion.div>
          </div>
        ))}
      </div>
    </MotionConfig>
  )
}
