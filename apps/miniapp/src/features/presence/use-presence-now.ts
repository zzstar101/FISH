import { useDidHide, useDidShow } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { PRESENCE_TICK_MS } from './view'

/**
 * 在线态的「现在」（#376 审查回合，P2）。
 *
 * ## 为什么需要它
 *
 * `presenceView` 的本地过期判据要求调用方给一个**会前进**的 `nowMs`（见 `./view`）。
 * 他人主页与商品详情都是「进页拉一次资料」：资料到位之后页面不再有请求、也没有别的
 * 状态变化，于是 `Date.now()` 只在资料到位那一帧被求值一次 —— 对方断线后绿点会一直
 * 挂着「在线」，端上那段按同一 TTL 的过期形同虚设。这个 hook 就是这两页唯一的时钟。
 *
 * ## 为什么不是轮询
 *
 * 它**不发任何请求**，只让渲染重新算一次「现在」：服务端的那次判定不可能比 TTL 活得
 * 更久，陈旧结论由 `presenceView` 在本地推翻就够了。会话页另有 20s 的**网络**轮询
 * （`pages/conversation`），它自己会重渲染，不进这里。
 *
 * ## 为什么隐藏时真的停表
 *
 * 页面被盖住（`useDidHide`）时那处在线态已经不显示了，定时 `setState` 只是白烧渲染；
 * 所以隐藏即 `clearInterval`、回到本页（`useDidShow`）再续上，而不是让定时器空转着
 * 每跳判一次可见性。续表时先对一次表：停表期间「现在」不前进，不对表会让结论多陈旧
 * 一个节拍。卸载同样停表（`useEffect` 的清理函数覆盖了 didHide 到不了的那条路径）。
 */
export function usePresenceNow(): number {
  const [nowMs, setNowMs] = useState(() => Date.now())
  /** 当前挂着的定时器；`null` 表示表停着（页面隐藏或已卸载） */
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = useCallback(() => {
    if (timerRef.current === null) return
    clearInterval(timerRef.current)
    timerRef.current = null
  }, [])

  const start = useCallback(() => {
    // 重复调用（挂载 effect 与首次 didShow 都可能在同一次进入里触发）不许叠出两只表
    if (timerRef.current !== null) return
    setNowMs(Date.now())
    timerRef.current = setInterval(() => setNowMs(Date.now()), PRESENCE_TICK_MS)
  }, [])

  /**
   * 挂载即走表：首次 `didShow` 可能早于本 hook 注册（Taro 的 didShow 回调是
   * `useLayoutEffect` 里挂到页面实例上的），不能只靠它启动。
   */
  useEffect(() => {
    start()
    return stop
  }, [start, stop])

  useDidShow(start)
  useDidHide(stop)

  return nowMs
}
