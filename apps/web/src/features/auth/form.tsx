import { Alert, AlertDescription } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fish/ui/select'
import { Spinner } from '@fish/ui/spinner'
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from 'react'

/** 认证页外壳（截图 19-login）：波浪背景 + Logo + 标题 + 副标题 + 磨砂玻璃卡片。 */
export function AuthPageShell({
  title,
  description,
  iconSrc,
  children,
  footer,
}: {
  title: ReactNode
  description: string
  /** 传入时替换默认的 🔄 emoji 方块，直接展示品牌图标。 */
  iconSrc?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="relative isolate flex min-h-dvh flex-col items-center px-6 pt-14 pb-8">
      {/*
        这里刻意不做入场动画：登录 / 注册是两个路由，切换时整页重挂载，
        任何淡入或位移读起来都像「先闪一下再出现」。背景常驻在根布局，
        因此内容直接替换反而是最稳的。
      */}
      <div className="flex w-full flex-col items-center">
        {iconSrc ? (
          <img alt="" className="size-32" src={iconSrc} />
        ) : (
          <span className="flex size-16 items-center justify-center rounded-2xl bg-brand text-3xl shadow-[0_10px_24px_rgba(81,119,186,0.35)]">
            🔄
          </span>
        )}
        <h1 className="mt-4 font-bold text-2xl">{title}</h1>
        <p className="mt-1.5 text-ink-3 text-sm">{description}</p>
        <Card className="mt-6 w-full gap-0 rounded-2xl border border-white/50 bg-surface/55 p-4 shadow-sm backdrop-blur-xl">
          {children}
        </Card>
        {footer}
      </div>
    </main>
  )
}

/** 表单级失败（如「学号或密码错误」）。字段级问题走各字段自己的 error。 */
export function FormAlert({ message }: { message: string }) {
  return (
    <Alert className="rounded-lg border-0 bg-danger-soft px-3 py-2" variant="destructive">
      <AlertDescription className="text-danger">{message}</AlertDescription>
    </Alert>
  )
}

type FieldChrome = { label: string; error?: string; hint?: string }

export function TextField({
  label,
  error,
  hint,
  ...props
}: FieldChrome & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId()
  return (
    <Field className="gap-1.5" data-invalid={error !== undefined}>
      <FieldLabel className="text-ink-2 text-sm" htmlFor={id}>
        {label}
      </FieldLabel>
      <Input
        {...props}
        aria-invalid={error === undefined ? undefined : true}
        className="focus:rounded-full"
        id={id}
      />
      {error === undefined ? null : <FieldError>{error}</FieldError>}
      {error === undefined && hint !== undefined ? (
        <FieldDescription className="text-xs">{hint}</FieldDescription>
      ) : null}
    </Field>
  )
}

export function SelectField({
  label,
  error,
  hint,
  options,
  value,
  onValueChange,
}: FieldChrome & {
  options: readonly { value: string; label: string }[]
  value: string
  onValueChange: (value: string) => void
}) {
  const id = useId()
  return (
    <Field className="gap-1.5" data-invalid={error !== undefined}>
      <FieldLabel className="text-ink-2 text-sm" htmlFor={id}>
        {label}
      </FieldLabel>
      <Select onValueChange={onValueChange} value={value}>
        <SelectTrigger
          aria-invalid={error === undefined ? undefined : true}
          className="h-11 w-full rounded-lg border-line bg-surface-2 px-3 text-[15px]"
          id={id}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error === undefined ? null : <FieldError>{error}</FieldError>}
      {error === undefined && hint !== undefined ? (
        <FieldDescription className="text-xs">{hint}</FieldDescription>
      ) : null}
    </Field>
  )
}

export function SubmitButton({
  pending,
  children,
  className = '',
  ...props
}: { pending: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button
      {...props}
      className={`w-full ${className}`}
      disabled={pending || props.disabled}
      size="lg"
      type="submit"
    >
      {pending ? (
        <>
          <Spinner className="size-4" />
          提交中…
        </>
      ) : (
        children
      )}
    </Button>
  )
}
