import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { EmptyState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'

/**
 * Admin 列表的共享筛选控件（#467）。三个控件都遵循同一条 URL 契约：
 * **变化即 navigate（条件进 URL），由调用方负责剥 cursor**——这里只发回调，不碰路由。
 */

const ALL = '__all__'

/** 枚举筛选：圆角胶囊一排；第一项恒为「全部」（URL 上省略该参数）。 */
export function FilterChips({
  ariaLabel,
  onChange,
  options,
  value,
}: {
  ariaLabel: string
  onChange: (value: string | undefined) => void
  options: ReadonlyArray<{ value: string; label: string }>
  value: string | undefined
}) {
  return (
    <fieldset className="flex flex-wrap gap-2 border-0 p-0 m-0">
      <legend className="sr-only">{ariaLabel}</legend>
      {[{ value: ALL, label: '全部' }, ...options].map((option) => {
        const active = option.value === ALL ? value === undefined : option.value === value
        return (
          <button
            aria-pressed={active}
            className={`h-8 rounded-full px-3.5 text-sm transition-colors ${
              active
                ? 'bg-brand font-semibold text-white'
                : 'bg-surface text-ink-2 hover:bg-brand-soft hover:text-brand'
            }`}
            key={option.value}
            onClick={() => onChange(option.value === ALL ? undefined : option.value)}
            type="button"
          >
            {option.label}
          </button>
        )
      })}
    </fieldset>
  )
}

/**
 * 关键词筛选：Enter / 失焦 / 点按钮三种方式提交同一份草稿值；清空输入提交 = 清条件。
 * 草稿与 URL 分离：外部 search 变化（后退/刷新）时同步回草稿。
 */
export function KeywordFilter({
  onCommit,
  placeholder,
  value,
}: {
  onCommit: (value: string | undefined) => void
  placeholder: string
  value: string | undefined
}) {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => {
    setDraft(value ?? '')
  }, [value])

  function commit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const trimmed = draft.trim()
    onCommit(trimmed.length > 0 ? trimmed : undefined)
  }

  return (
    <form className="flex items-center gap-2" onSubmit={commit}>
      <Input
        aria-label={placeholder}
        className="h-9 w-64 bg-white/70"
        maxLength={50}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        value={draft}
      />
      <Button size="sm" type="submit" variant="outline">
        筛选
      </Button>
    </form>
  )
}

/** 时间段筛选（左闭右开由 `dayRangeSearch` 换算）：两个 date input，变更即提交。 */
export function DateRangeFilter({
  onCommit,
  fromValue,
  toValue,
}: {
  fromValue: string | undefined
  onCommit: (range: { from: string | undefined; to: string | undefined }) => void
  toValue: string | undefined
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="创建时间起"
        className="h-9 w-40 bg-white/70"
        onChange={(event) => onCommit({ from: event.target.value || undefined, to: toValue })}
        type="date"
        value={fromValue ?? ''}
      />
      <span className="text-ink-3 text-sm">至</span>
      <Input
        aria-label="创建时间止"
        className="h-9 w-40 bg-white/70"
        onChange={(event) => onCommit({ from: fromValue, to: event.target.value || undefined })}
        type="date"
        value={toValue ?? ''}
      />
    </div>
  )
}

/** 翻页底部的「加载更多」+ 翻页失败重试，列表页共用。 */
export function LoadMore({
  error,
  hasNextPage,
  isFetchingNextPage,
  onNext,
  onRetry,
}: {
  error: unknown
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onNext: () => void
  onRetry: () => void
}) {
  if (error) {
    return (
      <div className="flex justify-center">
        <Button onClick={onRetry} variant="outline">
          下一页加载失败，点击重试
        </Button>
      </div>
    )
  }
  if (!hasNextPage) return null
  return (
    <div className="flex justify-center">
      <Button disabled={isFetchingNextPage} onClick={onNext} variant="outline">
        {isFetchingNextPage ? '正在加载…' : '加载更多'}
      </Button>
    </div>
  )
}

/** 子页落到 403 时的内联权限态（整页 403 由 AdminShell 兜住，这里只兜极端路径）。 */
export function ForbiddenInline() {
  return (
    <EmptyState
      action={
        <Link className="font-medium text-brand text-sm" to="/admin">
          返回概览
        </Link>
      }
      description="当前账号不是管理员。"
      emoji="🚫"
      title="无管理权限"
    />
  )
}
