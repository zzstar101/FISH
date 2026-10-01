import { Alert, AlertDescription } from '@fish/ui/alert'
import { BookOpen, Check, Headphones, ShieldCheck, Sparkles, Waves } from 'lucide-react'
import type { ReactNode } from 'react'

/** PC Web 登录页外壳：左侧品牌区 + 右侧玻璃卡表单。不依赖外部图片素材。 */
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

export function FormAlert({ message }: { message: string }) {
  return (
    <Alert
      className="rounded-lg border-0 bg-danger-soft px-3 py-2"
      role="alert"
      variant="destructive"
    >
      <AlertDescription className="text-danger">{message}</AlertDescription>
    </Alert>
  )
}
