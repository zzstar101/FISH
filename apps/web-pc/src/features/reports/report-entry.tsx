import { Button } from '@fish/ui/button'
import { useNavigate } from '@tanstack/react-router'
import { type ComponentProps, type ReactNode, useState } from 'react'
import { currentHref } from '../../lib/redirect'
import { useAuth } from '../auth/auth-provider'
import { ReportDialog, type ReportTarget } from './report-dialog'

/**
 * 举报入口按钮：未登录先跳登录（带当前页回跳），登录后打开举报弹窗。
 *
 * 匿名时**不直接发** `POST /reports`：那会吃一个 401，再被 `query-client.ts` 的全局
 * 401 收口弹去登录 —— 用户看到的是「点了没反应、页面突然跳走」。把跳转做在点击当下，
 * 路径才明确（这也是 Issue 验收里「未登录时入口表现明确」那一条）。
 */
export function ReportEntry({
  target,
  children,
  className,
  size,
  variant = 'outline',
}: {
  target: ReportTarget
  children: ReactNode
  className?: string
  size?: ComponentProps<typeof Button>['size']
  variant?: ComponentProps<typeof Button>['variant']
}) {
  const { me, isInitializing } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  function handleClick() {
    // 登录态还没恢复完就跳登录，会把已登录用户也踢出去，先禁用。
    if (isInitializing) return
    if (me === null) {
      void navigate({ to: '/login', search: { redirect: currentHref() } })
      return
    }
    setOpen(true)
  }

  return (
    <>
      <Button
        className={className}
        disabled={isInitializing}
        onClick={handleClick}
        size={size}
        type="button"
        variant={variant}
      >
        {children}
      </Button>
      {/* 按目标 key 重挂载：换举报对象时弹窗内部的原因/说明不会残留。 */}
      <ReportDialog
        key={`${target.type}:${target.id}`}
        onOpenChange={setOpen}
        open={open}
        target={target}
      />
    </>
  )
}
