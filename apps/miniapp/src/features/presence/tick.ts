/**
 * 在线态的「现在」——一个**模块级时钟**，只有订阅它的组件会跟着跳（性能，本文件的原因见下）。
 *
 * ## 为什么从每个页面一份 state 改成一份共享时钟
 *
 * 改动前 `usePresenceNow()` 自己在**调用它的那个页面组件**里 `useState`，每 30s
 * `setState(Date.now())` 一次：页面组件重渲染 → 整棵子树跟着重算（商品详情页有上千个
 * 节点，他人主页也有整屏列表）。而这一跳的目的只有一个 —— 让那个绿点和它旁边的文案
 * 重新算一遍「现在」（见 `./view` 的本地过期判据）。
 *
 * 现在「现在」放在模块里，只有真正读取它的组件（`./presence-badge`）订阅：
 * 每跳只重渲染那一个绿点，页面主体一次都不重算。判定口径、跳的间隔、隐藏时停表
 * 全部保持不变 —— 视觉与时序零变化，变的只是「谁跟着重渲染」。
 *
 * ## 起停由页面驱动，不由订阅者驱动
 *
 * 谁在屏幕上、什么时候被盖住，只有页面自己知道（Taro 的 `useDidShow` / `useDidHide`
 * 挂在页面实例上，子组件里不可靠）。所以：**页面报「我在前台」（`acquirePresenceClock`）
 * 与「我走了」（release），时钟按持有者计数起停**；子组件只订阅、不管生命周期。
 *
 * 计数而不是布尔：上一个页面被下一个盖住时，先 `didHide` 后 `didShow`（返回时顺序反过来），
 * 用布尔会在这两个回调之间把表停掉又起来，制造一次多余的对表与广播；计数让「还有人在前台」
 * 这件事不会短暂地变成假。
 */
import { PRESENCE_TICK_MS } from './view'

type Listener = () => void

/** 当前共享的「现在」。停表期间冻结，续表时先对一次真实时间 */
let nowMs = Date.now()

/** 前台持有者个数（`acquirePresenceClock` 与 release 成对改写） */
let holders = 0

/** 正在走的表；`null` = 没人在前台，表停着 */
let timer: ReturnType<typeof setInterval> | null = null

const listeners = new Set<Listener>()

function emit(): void {
  // 复制一份再遍历：回调里退订（组件卸载）不该影响本轮广播
  for (const listener of [...listeners]) listener()
}

/**
 * 当前「现在」。订阅者的 `getSnapshot`，也是非 React 调用方的读口。
 *
 * 必须是**稳定快照**（同一次 store 状态下多次调用返回同一个值），否则
 * `useSyncExternalStore` 会认为状态一直在变而反复重渲染 —— 所以这里回模块变量，
 * 不在读的时候顺手求 `Date.now()`。
 */
export function presenceNow(): number {
  return nowMs
}

/** 订阅「现在」的每一跳。取消订阅后不再收到广播 */
export function subscribePresenceNow(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 宣告「本页在前台」，返回释放函数（成对调用，重复调用 release 无副作用）。
 *
 * 第一个持有者进表时先把「现在」推进到真实时间再广播：停表期间时间照样在走，
 * 直接沿用旧的 `nowMs` 会让回到本页的那一帧沿用陈旧结论（比如对方早就断线、
 * 绿点却还亮着），对表之后下一次判定立刻正确。
 */
export function acquirePresenceClock(): () => void {
  holders += 1
  if (timer === null) {
    nowMs = Date.now()
    emit()
    timer = setInterval(() => {
      nowMs = Date.now()
      emit()
    }, PRESENCE_TICK_MS)
  }

  let released = false
  return () => {
    if (released) return
    released = true
    holders -= 1
    if (holders > 0) return
    holders = 0
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }
}
