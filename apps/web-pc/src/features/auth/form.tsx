import { Alert, AlertDescription } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { Spinner } from '@fish/ui/spinner'
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from 'react'

/**
 * PC Web 登录 / 注册双栏外壳。
 *
 * 左侧是校园登记单式的品牌场，右侧只承担完成认证这一个任务。
 * 页面加载只编排一次标题揭幕和表单入场，不给每个控件叠加入场动画。
 */
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
    <main className="auth-shell min-h-dvh bg-paper">
      <div className="auth-frame mx-auto grid min-h-dvh max-w-[1600px] grid-cols-[minmax(0,1.08fr)_minmax(430px,0.92fr)]">
        <section className="auth-visual relative flex min-h-dvh flex-col justify-between overflow-hidden bg-night p-12 xl:p-16">
          <div aria-hidden className="auth-visual__watermark">
            鱼
          </div>

          <div className="relative z-10 flex items-center gap-3">
            <span className="grid size-10 place-items-center border border-white/20">
              <img alt="" className="size-6 object-contain" src="/pc/brand-fish.png" />
            </span>
            <span>
              <span className="block font-semibold text-[15px] text-white tracking-[0.18em]">
                FISH
              </span>
              <span className="mt-0.5 block text-[11px] text-ice/55">广应科校内二手</span>
            </span>
          </div>

          <div className="auth-visual__copy relative z-10 max-w-[620px]">
            <div className="flex items-center gap-3 text-[12px] text-ice/60">
              <span className="size-1.5 bg-brand" />
              校园里的下一次相遇
            </div>
            <h1 className="mt-6 font-semibold text-[52px] leading-[1.08] tracking-[-0.05em] text-white xl:text-[62px]">
              把闲置
              <br />
              交给下一位同学
            </h1>
            <p className="mt-6 max-w-[40ch] text-ice/65 text-sm leading-7">
              从一件旧物开始，找到下一位使用者。发布、许愿、面交，都发生在广应科校园里。
            </p>
          </div>

          <div className="relative z-10 flex items-end justify-between gap-8 border-white/15 border-t pt-5">
            <div className="flex gap-6 text-ice/55 text-xs">
              <span>发布</span>
              <span>许愿</span>
              <span>面交</span>
            </div>
            <p className="text-[10px] text-ice/40 tracking-[0.18em]">PC / FISH</p>
          </div>
        </section>

        <section className="auth-form relative flex min-h-dvh items-center justify-center border-night/10 border-l bg-surface px-10 xl:px-16">
          <div className="auth-form__panel relative w-full max-w-[390px]">
            <div className="flex items-center justify-between border-line border-b pb-4 text-[11px] text-ink-3 tracking-[0.12em]">
              <span>FISH 账号</span>
              <span>PC Web</span>
            </div>
            <h2 className="mt-8 font-semibold text-[34px] leading-[1.12] tracking-[-0.04em]">
              {title}
            </h2>
            <p className="mt-3 max-w-[32ch] text-ink-2 text-sm leading-7">{description}</p>
            <div className="mt-8">{children}</div>
            {footer}
          </div>
        </section>
      </div>
    </main>
  )
}

/** 表单级失败（如「学号或密码错误」）。字段级问题走各字段自己的 error。 */
export function FormAlert({ message }: { message: string }) {
  return (
    <Alert
      className="rounded-none border-0 border-danger border-l-2 bg-transparent px-3 py-1.5"
      variant="destructive"
    >
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
    <Field className="gap-2.5" data-invalid={error !== undefined}>
      <FieldLabel className="auth-field-label" htmlFor={id}>
        {label}
      </FieldLabel>
      <div className="group/auth-field relative">
        <Input
          {...props}
          aria-invalid={error === undefined ? undefined : true}
          className="auth-input w-full pr-2"
          id={id}
        />
        <span aria-hidden className="auth-field-line" />
      </div>
      {error === undefined ? null : <FieldError>{error}</FieldError>}
      {error === undefined && hint !== undefined ? (
        <FieldDescription className="text-xs">{hint}</FieldDescription>
      ) : null}
    </Field>
  )
}

export function SubmitButton({
  pending,
  pendingLabel = '提交中…',
  children,
  className = '',
  ...props
}: {
  pending: boolean
  pendingLabel?: string
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button
      {...props}
      className={`auth-submit h-12 w-full ${className}`}
      disabled={pending || props.disabled}
      type="submit"
    >
      {pending ? (
        <>
          <Spinner className="size-4" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  )
}
