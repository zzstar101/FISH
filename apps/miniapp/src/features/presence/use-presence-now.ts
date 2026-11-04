import { useDidHide, useDidShow } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { acquirePresenceClock, presenceNow, subscribePresenceNow } from './tick'

/**
 * 在线态的「现在」（#376 审查回合，P2；性能改造后拆成两个钩子）。
 *
 * ## 为什么需要它
 *
 * `presenceView` 的本地过期判据要求调用方给一个**会前进**的 `nowMs`（见 `./view`）。
 * 他人主页与商品详情都是「进页拉一次资料」：资料到位之后页面不再有请求、也没有别的
 * 状态变化，于是 `Date.now()` 只在资料到位那一帧被求值一次 —— 对方断线后绿点会一直
 * 挂着「在线」，端上那段按同一 TTL 的过期形同虚设。这个时钟就是这两页唯一的时间源。
 *
 * ## 为什么不是轮询
 *
 * 它**不发任何请求**，只让渲染重新算一次「现在」：服务端的那次判定不可能比 TTL 活得
 * 更久，陈旧结论由 `presenceView` 在本地推翻就够了。会话页另有 20s 的**网络**轮询
 * （`pages/conversation`），它自己会重渲染，不进这里。
 *
 * ## 为什么拆成「页面报前台」+「徽标订阅」两个人
 *
 * 改动前这个钩子自己 `useState`，挂在页面上：每跳都重渲染**整个页面**（商品详情上千节点）。
 * 而这一跳只为了让一个绿点和它旁边的文案重算一次「现在」。现在时钟放在 `./tick` 的
 * 模块单例里：
 *
 * - 页面调 `usePresenceClock()` —— 只按 `didShow` / `didHide` 把表起停（计数持有），
 *   **不持有 state**，所以它自己不会跟着重渲染；
 * - 徽标组件（`./presence-badge`）调 `usePresenceNow()` —— 真正读「现在」的那一处，
 *   只有它跟着跳重渲染。
 *
 * ## 为什么隐藏时真的停表
 *
 * 页面被盖住（`useDidHide`）时那处在线态已经不显示了，定时广播只是白烧渲染；
 * 所以隐藏即释放、回到本页（`useDidShow`）再占上，而不是让定时器空转着每跳判一次可见性。
 * 重新占上时时钟先把「现在」对到真实时间（见 `./tick` 的 `acquirePresenceClock`）。
 */
export function usePresenceClock(): void {
  /** 当前占着的持有权；`null` 表示没占（页面隐藏或已卸载） */
  const releaseRef = useRef<(() => void) | null>(null)

  const start = useCallback(() => {
    // 重复调用（挂载 effect 与首次 didShow 都可能在同一次进入里触发）不许叠出两份持有权
    if (releaseRef.current !== null) return
    releaseRef.current = acquirePresenceClock()
  }, [])

  const stop = useCallback(() => {
    if (releaseRef.current === null) return
    releaseRef.current()
    releaseRef.current = null
  }, [])

  /**
   * 挂载即占上：首次 `didShow` 可能早于本钩子注册（Taro 的 didShow 回调是
   * `useLayoutEffect` 里挂到页面实例上的），不能只靠它启动。
   */
  useEffect(() => {
    start()
    return stop
  }, [start, stop])

  useDidShow(start)
  useDidHide(stop)
}

/**
 * 订阅共享时钟的「现在」。**只有真正要显示在线态的组件才调它** —— 每 30s 一跳，
 * 调在页面级就等于把整页的重渲染买回来了（改这个钩子的位置前先看 `./tick` 的文件头）。
 *
 * 第三参数（`getServerSnapshot`）与客户端同源：小程序没有 SSR，
 * 但 `useSyncExternalStore` 的类型要求提供它，传同一个函数即可。
 */
export function usePresenceNow(): number {
  return useSyncExternalStore(subscribePresenceNow, presenceNow, presenceNow)
}
