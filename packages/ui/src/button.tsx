import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'
import { cn } from './lib/utils'

/**
 * shadcn/ui Button（new-york-v4 官方源码）。
 *
 * 相对官方的适配（只动视觉，不动结构与 API）：
 * - 基础圆角 `rounded-md` → `rounded-full`：DESIGN-SPEC.md 规定按钮一律胶囊形。
 * - 字号从 base 下沉到 size：官方的 `text-sm` 写在基础类里，会与 size 的 `text-xs`
 *   同时命中，最终由生成顺序决定谁生效；下沉后一个按钮只有一个字号来源。
 * - `size` 的 sm / lg 缩放对齐截图实测（sm 28px、lg 48px），default 沿用官方 36px。
 * - `destructive` 用 FISH 的描边红（`danger` 令牌），不是官方的实心红。
 * - 新增 `onBrand`：蓝色渐变 Banner 上的白底按钮（许愿页），官方没有对应变体。
 */
const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition-all outline-none active:scale-[0.98] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'border border-destructive/40 bg-background text-destructive hover:bg-danger-soft',
        outline: 'border border-ink/12 bg-background text-foreground hover:bg-accent',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/70',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        onBrand: 'bg-background text-primary hover:bg-background/90',
      },
      size: {
        default: 'h-9 px-4 text-sm has-[>svg]:px-3',
        xs: "h-6 gap-1 px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-7 gap-1.5 px-3 text-xs has-[>svg]:px-2.5',
        lg: 'h-12 px-5 text-base font-semibold has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
