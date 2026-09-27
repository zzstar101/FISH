import { Alert, AlertDescription } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { Spinner } from '@fish/ui/spinner'
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Headphones,
  ShieldCheck,
  Sparkles,
  Waves,
} from 'lucide-react'
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from 'react'

/** PC Web 登录 / 注册双栏外壳。登录页强调轻盈、通透的校园生活方式；不依赖外部图片素材。 */
export function AuthPageShell({
  title,
  description,
  children,
  footer,
  variant = 'default',
}: {
  title: ReactNode
  description: string
  children: ReactNode
  footer?: ReactNode
  variant?: 'default' | 'login'
}) {
  if (variant === 'default') {
    return (
      <main className="auth-register-page min-h-dvh bg-[#edf5f8] text-[#163347]">
        <section className="register-visual relative flex min-h-dvh flex-col justify-between overflow-hidden px-14 py-11 xl:px-20">
          <div aria-hidden="true" className="register-ribbon register-ribbon-one" />
          <div aria-hidden="true" className="register-ribbon register-ribbon-two" />
          <div aria-hidden="true" className="register-scene">
            <div className="register-scene-bubble register-scene-bubble-one" />
            <div className="register-scene-bubble register-scene-bubble-two" />
            <div className="register-scene-card">
              <span>FISH</span>
              <strong>校园交换中</strong>
              <small>把好物交给下一位同学</small>
            </div>
          </div>
          <div className="relative z-10 flex items-center justify-between">
            <img
              alt="鱼小应"
              className="h-11 w-auto max-w-[220px] object-contain object-left"
              src="/pc/brand-wordmark.png"
            />
            <span className="glass-chip">
              <Sparkles className="size-3.5" /> 新同学，欢迎加入
            </span>
          </div>
          <div className="relative z-10 max-w-[650px] py-12">
            <div className="mb-6 flex items-center gap-2 text-[#1677a1] text-sm font-semibold tracking-[0.12em]">
              <Waves className="size-4" />
              <span>注册只需要一分钟</span>
            </div>
            <h1 className="max-w-[620px] text-balance font-semibold text-[clamp(42px,5vw,76px)] leading-[1.04] tracking-[-0.065em] text-[#123b55]">
              先认识校园，
              <br />
              再遇见好物。
            </h1>
            <p className="mt-7 max-w-[540px] text-[#4f7181] text-lg leading-8">
              用真实校园身份加入 FISH，发布闲置、寻找心愿，也把你的生活经验分享给下一位同学。
            </p>
            <div className="mt-10 grid max-w-[510px] grid-cols-3 gap-3">
              {[
                ['01', '创建账号', '学号验证身份'],
                ['02', '逛逛校园', '发现身边好物'],
                ['03', '轻松交换', '校内见面完成'],
              ].map(([number, label, detail]) => (
                <div className="register-step" key={number}>
                  <span>{number}</span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </div>
              ))}
            </div>
          </div>
          <p className="relative z-10 text-[#638695] text-xs">FISH · 广应科校园二手交易平台</p>
        </section>
        <section className="register-form-panel flex min-h-dvh items-center justify-center px-7 py-12 sm:px-12 xl:px-20">
          <div className="register-glass-card w-full max-w-[490px]">
            <div className="mb-8">
              <p className="mb-3 text-[#1677a1] text-xs font-semibold tracking-[0.16em]">
                JOIN THE CAMPUS
              </p>
              <h2 className="font-semibold text-3xl tracking-[-0.045em] text-[#15364a]">{title}</h2>
              <p className="mt-3 text-[#78909b] text-sm leading-6">{description}</p>
            </div>
            <div>{children}</div>
            {footer}
            <p className="mt-8 text-center text-[#9aadb4] text-xs">
              注册后即可开始浏览和发布校园闲置
            </p>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="auth-page min-h-dvh bg-[#edf5f8] text-[#163347]">
      <section className="auth-visual relative flex flex-col justify-between overflow-hidden px-14 py-11 xl:px-20">
        <div aria-hidden="true" className="auth-orbit auth-orbit-one" />
        <div aria-hidden="true" className="auth-orbit auth-orbit-two" />
        <div aria-hidden="true" className="auth-grain" />
        <div aria-hidden="true" className="auth-scene">
          <div className="auth-scene-orb">
            <img alt="" src="/pc/brand-fish.png" />
          </div>
          <div className="auth-scene-tag auth-scene-tag-one">
            <BookOpen className="size-4" />
            课本与笔记
          </div>
          <div className="auth-scene-tag auth-scene-tag-two">
            <Headphones className="size-4" />
            喜欢的数码
          </div>
        </div>
        <div className="relative z-10 flex items-center justify-between">
          <img
            alt="鱼小应"
            className="h-11 w-auto drop-shadow-[0_10px_20px_rgba(32,105,145,0.15)]"
            src="/pc/brand-wordmark.png"
          />
          <span className="glass-chip">
            <Waves className="size-3.5" /> 校园闲置交换站
          </span>
        </div>

        <div className="relative z-10 max-w-[650px] py-12">
          <div className="mb-6 flex items-center gap-2 text-[#1677a1] text-sm font-semibold tracking-[0.12em]">
            <Sparkles className="size-4" />
            <span>把喜欢的东西，传给下一位同学</span>
          </div>
          <h1 className="max-w-[620px] text-balance font-semibold text-[clamp(42px,5vw,76px)] leading-[1.04] tracking-[-0.065em] text-[#123b55]">
            让闲置发光，
            <br />
            让校园重新相遇。
          </h1>
          <p className="mt-7 max-w-[540px] text-[#4f7181] text-lg leading-8">
            从课本、数码到宿舍好物，找到真正适合你的下一件东西。校内见面，轻松交换。
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            {['校内面交', '真实学号', '放心交易'].map((item) => (
              <span className="feature-pill" key={item}>
                <Check className="size-4" />
                {item}
              </span>
            ))}
          </div>
        </div>

        <div className="relative z-10 flex items-end justify-between gap-8 text-[#638695] text-xs">
          <span>FISH · 广应科校园二手交易平台</span>
          <span className="hidden items-center gap-1.5 sm:flex">
            <ShieldCheck className="size-3.5" /> 只为校园里的真实连接
          </span>
        </div>
      </section>

      <section className="auth-form-panel flex items-center justify-center px-7 py-12 sm:px-12 xl:px-20">
        <div className="auth-glass-card w-full max-w-[490px]">
          <div className="mb-10">
            <p className="mb-3 text-[#1677a1] text-xs font-semibold tracking-[0.16em]">
              WELCOME BACK
            </p>
            <h2 className="font-semibold text-3xl tracking-[-0.045em] text-[#15364a]">{title}</h2>
            <p className="mt-3 text-[#78909b] text-sm leading-6">{description}</p>
          </div>
          <div>{children}</div>
          {footer}
        </div>
      </section>
    </main>
  )
}

export function FormAlert({
  message,
  variant = 'default',
}: {
  message: string
  variant?: 'default' | 'login'
}) {
  return (
    <Alert
      className={
        variant === 'login'
          ? 'rounded-2xl border-[#efb9b4] bg-[#fff4f2] px-4 py-3 shadow-none'
          : 'rounded-lg border-0 bg-danger-soft px-3 py-2'
      }
      role="alert"
      variant="destructive"
    >
      <AlertDescription className={variant === 'login' ? 'text-[#c6534c]' : 'text-danger'}>
        {message}
      </AlertDescription>
    </Alert>
  )
}

type FieldChrome = { label: string; error?: string; hint?: string }

export function TextField({
  label,
  error,
  hint,
  variant = 'default',
  ...props
}: FieldChrome & { variant?: 'default' | 'login' } & Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'variant'
  >) {
  const id = useId()
  const errorId = `${id}-error`
  return (
    <Field className={variant === 'login' ? 'gap-2' : 'gap-1.5'} data-invalid={error !== undefined}>
      <FieldLabel
        className={variant === 'login' ? 'ml-1 text-[#527281] text-sm' : 'text-ink-2 text-sm'}
        htmlFor={id}
      >
        {label}
      </FieldLabel>
      <Input
        {...props}
        aria-describedby={error === undefined ? undefined : errorId}
        aria-invalid={error === undefined ? undefined : true}
        className={
          variant === 'login'
            ? 'auth-input h-13 rounded-2xl border-0 bg-white/70 px-4 text-[#163347] shadow-[0_8px_24px_rgba(67,110,126,0.06)] ring-1 ring-[#d8e7eb] transition focus:bg-white focus:ring-2 focus:ring-[#57b9c1]'
            : 'h-11 rounded-lg'
        }
        id={id}
      />
      {error === undefined ? null : <FieldError id={errorId}>{error}</FieldError>}
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
  variant = 'default',
  ...props
}: { pending: boolean; children: ReactNode } & {
  variant?: 'default' | 'login'
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button
      {...props}
      className={
        variant === 'login'
          ? `auth-submit group h-13 w-full rounded-2xl border-0 bg-[#1677a1] text-white shadow-[0_14px_28px_rgba(22,119,161,0.22)] transition hover:-translate-y-0.5 hover:bg-[#0d658d] hover:shadow-[0_18px_32px_rgba(22,119,161,0.28)] ${className}`
          : `h-11 w-full ${className}`
      }
      disabled={pending || props.disabled}
      type="submit"
    >
      {pending ? (
        <>
          {variant === 'login' ? (
            <span aria-hidden="true" className="auth-loading-drop" />
          ) : (
            <Spinner className="size-4" />
          )}
          {variant === 'login' ? '正在连接校园…' : '提交中…'}
        </>
      ) : (
        <>
          {children}
          {variant === 'login' ? (
            <ArrowUpRight className="ml-1 size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          ) : null}
        </>
      )}
    </Button>
  )
}
