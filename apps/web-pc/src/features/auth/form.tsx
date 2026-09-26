import { Alert, AlertDescription } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { Spinner } from '@fish/ui/spinner'
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from 'react'

/** PC Web 登录 / 注册双栏外壳。 */
export function AuthPageShell({
  title,
  description,
  children,
  footer,
}: {
  title: ReactNode
  description: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="grid min-h-dvh grid-cols-[minmax(0,1fr)_520px] bg-bg">
      <section className="relative flex flex-col justify-between overflow-hidden bg-brand-soft p-16">
        <img alt="鱼小应" className="h-12 w-auto" src="/pc/brand-wordmark.png" />
        <div className="max-w-[560px]">
          <h1 className="font-bold text-[44px] leading-[1.15] tracking-[-0.035em]">
            让闲置
            <br />
            在校园里流动
          </h1>
          <p className="mt-6 max-w-[460px] text-ink-2 text-base leading-7">
            FISH 是广应科校内二手交易平台。发布闲置、许下愿望，交易全程校内面交。
          </p>
        </div>
        <p className="text-ink-3 text-xs">PC Web 骨架 · 同源 API · 浏览器直接访问</p>
      </section>

      <section className="flex items-center justify-center border-line border-l bg-surface px-16">
        <div className="w-full max-w-[380px]">
          <h2 className="font-semibold text-2xl tracking-[-0.02em]">{title}</h2>
          <p className="mt-2 text-ink-3 text-sm">{description}</p>
          <div className="mt-8">{children}</div>
          {footer}
        </div>
      </section>
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
        className="h-11 rounded-lg"
        id={id}
      />
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
      className={`h-11 w-full ${className}`}
      disabled={pending || props.disabled}
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
