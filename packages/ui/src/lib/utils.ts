import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * shadcn/ui 的类名合并工具：clsx 处理条件类名，tailwind-merge 消解同属性冲突
 * （后者生效），因此调用方传入的 className 总能覆盖组件默认样式。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
