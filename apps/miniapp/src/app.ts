// 必须是第一条：在任何契约（zod schema）模块被求值之前关掉 zod 的 JIT，见该模块的说明
import '@/lib/zod-jitless'
import { useLaunch } from '@tarojs/taro'
import type { PropsWithChildren } from 'react'
import { bootstrapAuth, useAuth } from '@/features/auth/store'
import { useRealtimeSession } from '@/features/chat/realtime'
import './app.scss'

export default function App({ children }: PropsWithChildren) {
  const { status, user } = useAuth()

  /**
   * 冷启动恢复登录态：本地有会话 cookie 就打一次 `GET /me`，
   * 结果写进 `features/auth/store`，页面守卫与「我的」页据此渲染。
   * 没有会话时这一步不发网络请求（见 `bootstrapAuth`）。
   */
  useLaunch(() => {
    void bootstrapAuth()
  })

  /**
   * 实时通道跟着**登录身份**走（#67 第三步）：登录后建连；退出 / 换号时
   * `useRealtimeSession` 先关掉旧连接、作废它的重连任务，再按新身份连 ——
   * 否则旧账号的连接会继续把它的消息推给新账号的界面。
   *
   * 未登录传 `null`：服务端本来就会在 upgrade 前 401 拒绝，本地连都不必连。
   */
  useRealtimeSession(status === 'authed' ? (user?.id ?? null) : null)

  return children
}
