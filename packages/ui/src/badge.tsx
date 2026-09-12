import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'
import { cn } from './lib/utils'

/**
 * shadcn/ui Badge（new-york-v4 官方源码）。本组件替代原自研 `Chip`。
 *
 * 相对官方的适配：
 * - 保留官方 6 个 variant，另加 FISH 柔和色变体 `brand | success | lavender | warn`，
 *   直接取 `*-soft` / 主色令牌，对应截图里的「求购」「在售」「待面交」等标签；
 *   `danger` 是柔和红，与官方的实心红 `destructive` 区分开。
 * - `shape` 轴是 FISH 扩展：`square` 用于成色/分类/校区这类属性标签（6px 圆角），
 *   `pill` 用于历史搜索、快捷短语、状态标签（胶囊）。官方只有胶囊一种形态。
 */
const badgeVariants = cva(
  'inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap border border-transparent text-xs font-medium transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/70',
        destructive: 'bg-destructive text-destructive-foreground [a&]:hover:bg-destructive/90',
        outline:
          'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 [a&]:hover:underline',
        brand: 'bg-brand-soft text-brand',
        success: 'bg-success-soft text-success',
        lavender: 'bg-lavender-soft text-lavender',
        warn: 'bg-warn-soft text-warn',
        danger: 'bg-danger-soft text-danger',
      },
      shape: {
        square: 'rounded-md px-2',
        pill: 'rounded-full px-3',
      },
    },
    defaultVariants: {
      variant: 'default',
      shape: 'square',
    },
  },
)

function Badge({
  className,
  variant = 'default',
  shape = 'square',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span'

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      data-shape={shape}
      className={cn(badgeVariants({ variant, shape }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
