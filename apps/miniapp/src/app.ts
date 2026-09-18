// 必须是第一条：在任何契约（zod schema）模块被求值之前关掉 zod 的 JIT，见该模块的说明
import '@/lib/zod-jitless'
import type { PropsWithChildren } from 'react'
import './app.scss'

export default function App({ children }: PropsWithChildren) {
  return children
}
