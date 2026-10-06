import type { ReactNode } from 'react'

/**
 * 三个高风险写操作弹窗（治理 / 人工审核决定 / 举报处理）共用的内胆（#467 审查发现 Duplicated Code 轴）：
 * 原因输入（textarea + 字数计数）与「本地校验 warn / 服务端 danger」两色告警条，三处原本逐字重复。
 * 只抽 DOM 与文案完全一致的部分——页脚按钮、标题、选项语义各弹窗不同，仍留在各自文件里。
 */

/** 原因上限：与 `validateReason`（admin-view.ts）的 500 同口径。 */
const REASON_MAX_LENGTH = 500

/** 原因输入：`ariaLabel` 由调用方给（治理原因 / 决定原因 / 处理原因），计数按 trim 后计。 */
export function ReasonField({
  ariaLabel,
  label,
  onChange,
  value,
}: {
  ariaLabel: string
  label: string
  onChange: (value: string) => void
  value: string
}) {
  return (
    <div className="space-y-1.5">
      <span className="font-medium text-sm">
        {label} <span className="text-coral">*</span>
      </span>
      <textarea
        aria-label={ariaLabel}
        className="min-h-20 w-full rounded-xl border border-line bg-white/80 px-3 py-2 text-sm focus-visible:ring-3 focus-visible:ring-brand/15 focus:outline-none"
        maxLength={REASON_MAX_LENGTH}
        onChange={(event) => onChange(event.target.value)}
        placeholder="写进审计、不可抵赖；1–500 字"
        value={value}
      />
      <span className="block text-right text-ink-3 text-xs">
        {value.trim().length}/{REASON_MAX_LENGTH}
      </span>
    </div>
  )
}

/**
 * 弹窗内告警条（#448 教训：radix 遮罩会盖住页面级通知，失败必须渲染在弹窗内部）。
 * `tone` 由调用方按错误来源给：本地校验 = warn，服务端失败 = danger。
 */
export function DialogAlert({ message, tone }: { message: string; tone: 'warn' | 'danger' }) {
  return (
    <p
      className={`rounded-xl px-3.5 py-2.5 text-sm ${
        tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-danger-soft text-danger'
      }`}
      role="alert"
    >
      {message}
    </p>
  )
}

/**
 * 二选一卡片组（sr-only radio + label 卡片）：`activeClassName` 由调用方给，因为
 * 「选中色」本身是语义（审核 ALLOW 用品牌色 / BLOCK 用危险色；举报受理 vs 驳回同理）。
 */
export function OptionCards<V extends string>({
  activeClassName,
  legend,
  name,
  onChange,
  options,
  value,
}: {
  activeClassName: (value: V) => string
  legend: string
  name: string
  onChange: (value: V) => void
  options: ReadonlyArray<{ value: V; label: string; hint: ReactNode }>
  value: V | null
}) {
  return (
    <fieldset className="grid grid-cols-2 gap-2 border-0 p-0 m-0">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const active = value === option.value
        return (
          <label
            className={`block cursor-pointer rounded-xl border p-3 text-left transition-colors ${
              active
                ? activeClassName(option.value)
                : 'border-line bg-white/70 hover:border-brand/40'
            }`}
            key={option.value}
          >
            <input
              checked={active}
              className="sr-only"
              name={name}
              onChange={() => onChange(option.value)}
              type="radio"
              value={option.value}
            />
            <span className="block font-semibold text-sm">{option.label}</span>
            <span className="mt-1 block text-ink-3 text-xs">{option.hint}</span>
          </label>
        )
      })}
    </fieldset>
  )
}
