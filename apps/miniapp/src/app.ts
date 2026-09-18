// 必须是第一条：在任何契约（zod schema）模块被求值之前关掉 zod 的 JIT，见该模块的说明
import '@/lib/zod-jitless'
import { useLaunch } from '@tarojs/taro'
import type { PropsWithChildren } from 'react'
import { bootstrapAuth } from '@/features/auth/store'
import './app.scss'

export default function App({ children }: PropsWithChildren) {
  /**
   * 冷启动恢复登录态：本地有会话 cookie 就打一次 `GET /me`，
   * 结果写进 `features/auth/store`，页面守卫与「我的」页据此渲染。
   * 没有会话时这一步不发网络请求（见 `bootstrapAuth`）。
   */
  useLaunch(() => {
    void bootstrapAuth()
  })

  return children
}
