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
 * 计数而不是布尔：页面切换时 `didHide` / `didShow` 的先后**两种都可能**（新页盖住旧页时
 * 先 hide 后 show，返回时反过来，Taro 也没有规定死），用布尔会在这两个回调之间把表停掉
 * 又起来，制造一次多余的对表与广播；计数让「还有人在前台」这件事不会短暂地变成假。
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
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      // 一个订阅者自己炸了不能连累其他人，更不能把这一跳的循环打断（`setInterval`
      // 的回调抛出去只会变成一条没人管的未捕获错误）。记下来，继续广播。
      console.error('[presence] 订阅者抛错', error)
    }
  }
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
    // 先立表、再广播：广播会同步调用订阅者，里面若抛错，`holders` 已经 +1，
    // 若此刻 `timer` 还是 null，下一个持有者会走进「表已存在」这条路，表永远起不来。
    // 反过来先立表就没有这个坏状态：最差只是一次广播被打断，表照样在走。
    timer = setInterval(() => {
      nowMs = Date.now()
      emit()
    }, PRESENCE_TICK_MS)
    emit()
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

/** 一份持有权的形状（页面只经 `usePresenceClock` 用它，见 `./use-presence-now`） */
export type PresenceClockHolder = {
  /** 占上（幂等：重复调用不会叠出第二份持有权） */
  start: () => void
  /** 放掉（幂等：没占着时调用无副作用） */
  stop: () => void
  /** 当前是否占着 */
  held: () => boolean
}

/**
 * 一个「占着 / 放掉」的持有权，带幂等守卫。
 *
 * 为什么要单独有这个东西：页面里 `didShow` 与挂载 effect 都可能触发 `start`，
 * `didHide` 与卸载都可能触发 `stop`，两边重叠是常态。守卫写错的两个后果都不报错 ——
 * 要么持有权泄漏（表永远不停，回到后台还在每 30s 广播一次），要么多扣一次账
 * （另一个页面的持有权被顶掉，绿点冻结）。所以把它从 React 里摘出来单独可测。
 */
export function createPresenceClockHolder(): PresenceClockHolder {
  let release: (() => void) | null = null

  return {
    start() {
      if (release !== null) return
      release = acquirePresenceClock()
    },
    stop() {
      if (release === null) return
      release()
      release = null
    },
    held() {
      return release !== null
    },
  }
}
