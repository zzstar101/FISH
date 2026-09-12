import type * as React from 'react'
import { cn } from './lib/utils'

/**
 * shadcn/ui Input（new-york-v4 官方源码）。
 *
 * 相对官方的适配：截图的输入框是 44px 高、浅灰底、无边框，聚焦时描边变蓝底变白，
 * 因此把官方 `h-9 rounded-md border-input bg-transparent` + 3px 光环，
 * 换成 `h-11 rounded-lg border-line bg-surface-2` + `focus-visible:border-brand`。
 * 字号保持 15px 以对齐截图密度（iOS 聚焦放大的取舍见 DESIGN-SPEC.md）。
 */
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-11 w-full min-w-0 rounded-lg border border-line bg-surface-2 px-3 py-1 text-[15px] text-ink transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-ink-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-brand focus-visible:bg-surface',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
