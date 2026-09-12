import type { ButtonHTMLAttributes } from 'react'

/**
 * 样例组件：只用于证明 `@fish/ui` 可被 `apps/web` import。
 * 真实组件库、design tokens、shadcn/ui 接入由 ouu2006 在 #4 建立。
 */
export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center rounded-md bg-slate-900 px-4 py-2 font-medium text-sm text-white disabled:opacity-50 ${className}`}
      {...props}
    />
  )
}
