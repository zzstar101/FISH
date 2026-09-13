import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from './button'

/**
 * 顶部导航条：56px 高，标题绝对居中，左右各留一个 44px 操作位。
 *
 * shadcn/ui 里没有导航条组件，这里是 FISH 自己的组合：返回键用 shadcn `Button`
 * （ghost + icon 尺寸），箭头统一用 shadcn 指定的图标库 `lucide-react`。
 */
export type NavBarProps = {
  title?: ReactNode
  /** 传了才渲染左侧返回按钮。 */
  onBack?: () => void
  right?: ReactNode
  /** 悬浮在内容之上（详情页这类有头图的页面用）。 */
  floating?: boolean
  className?: string
}

export function NavBar({ title, onBack, right, floating = false, className = '' }: NavBarProps) {
  return (
    <header
      className={`relative z-20 flex h-14 items-center ${
        floating ? '' : 'border-line border-b bg-surface'
      } ${className}`}
    >
      <div className="flex w-11 items-center justify-start pl-2">
        {onBack ? (
          <Button
            aria-label="返回"
            className="text-ink"
            onClick={onBack}
            size="icon"
            type="button"
            variant="ghost"
          >
            <ChevronLeft className="size-6" />
          </Button>
        ) : null}
      </div>
      <h1 className="min-w-0 flex-1 truncate text-center font-semibold text-[17px]">{title}</h1>
      <div className="flex w-11 items-center justify-end pr-2">{right}</div>
    </header>
  )
}

export type FormRowProps = {
  label: ReactNode
  value?: ReactNode
  placeholder?: string
  onClick?: () => void
  className?: string
}

/** 表单式列表行：左标签 + 右值 + 箭头（发布页 / 设置页）。同样是 Button 的组合。 */
export function FormRow({ label, value, placeholder, onClick, className = '' }: FormRowProps) {
  const filled = value !== undefined && value !== null && value !== ''
  return (
    <Button
      className={`h-13 w-full justify-start gap-3 rounded-none bg-surface px-4 text-left font-normal hover:bg-surface active:scale-100 ${className}`}
      onClick={onClick}
      type="button"
      variant="ghost"
    >
      <span className="shrink-0 text-[15px] text-ink">{label}</span>
      <span
        className={`min-w-0 flex-1 truncate text-right text-[15px] ${
          filled ? 'text-ink' : 'text-ink-3'
        }`}
      >
        {filled ? value : placeholder}
      </span>
      <ChevronRight className="size-5 shrink-0 text-ink-3" />
    </Button>
  )
}
