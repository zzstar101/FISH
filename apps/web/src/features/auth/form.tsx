import { Alert, AlertDescription } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fish/ui/select'
import { Spinner } from '@fish/ui/spinner'
import { Tabs, TabsList, TabsTrigger } from '@fish/ui/tabs'
import { useNavigate } from '@tanstack/react-router'
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from 'react'

/** 认证页外壳（截图 19-login）：波浪背景 + Logo + 标题 + 副标题 + 磨砂玻璃卡片。 */
export function AuthPageShell({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description: string
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
        <span className="flex size-16 items-center justify-center rounded-2xl bg-brand text-3xl shadow-[0_10px_24px_rgba(0,5,255,0.35)]">
          🔄
        </span>
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

/**
 * 登录 / 注册切换（截图里是「验证码登录 / 密码登录」，这里对应契约的两条流程）。
 *
 * 用 shadcn Tabs 承载：登录与注册是两个独立路由，因此 `value` 由当前路由给出，
 * `onValueChange` 只负责跳转——Tabs 不维护自己的一份选中态，避免两个来源打架。
 * 替换前的自研版本靠 motion 做白色胶囊的位移，换成 Tabs 后选中态由组件自身的
 * `data-[state=active]` 样式给出，少了一层手写的位移动画。
 */
export function AuthTabs({ active }: { active: 'login' | 'register' }) {
  const navigate = useNavigate()

  return (
    <Tabs
      className="mb-4"
      onValueChange={(value) => {
        void navigate({ to: value === 'login' ? '/login' : '/register' })
      }}
      value={active}
    >
      <TabsList className="h-10 rounded-full">
        <TabsTrigger className="rounded-full" value="login">
          登录
        </TabsTrigger>
        <TabsTrigger className="rounded-full" value="register">
          注册
        </TabsTrigger>
      </TabsList>
    </Tabs>
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
