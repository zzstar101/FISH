/**
 * 登录态：一个**模块级单例** + 一个 `useAuth()` 钩子。
 *
 * 为什么不引状态库：需要它的只有「当前用户」这一份数据，读的页面多、写的只有 3 处
 * （登录 / 注册 / 退出）。`useSyncExternalStore` 就能把「Taro 存储里的 cookie」
 * 与「React 渲染」接起来，引一个 store 库只会多一层概念。
 *
 * 三个状态的区别很关键，页面守卫依赖它：
 * - `unknown`：冷启动还没问过后端（本地有 cookie，正在打 `GET /me`）。
 * - `anonymous`：确定未登录。
 * - `authed`：确定已登录，`user` 非空。
 *
 * **守卫只在 `anonymous` 时跳登录页**：把 `unknown` 也当成未登录会让已登录用户
 * 冷启动时先闪一下登录页（`GET /me` 还没回来）。
 */
import type { LoginRequest, RegisterRequest } from '@fish/contracts/auth/session'
import type { Me } from '@fish/contracts/auth/user'
import { useSyncExternalStore } from 'react'
import { ApiError, isUnauthenticatedError } from '@/lib/request'
import { clearSession, onSessionCleared, readSession } from '@/lib/session'
import { fetchMe, login, logout, register, wechatSignIn } from './api'
import { DEMO_AUTH_ENABLED, DEMO_USER } from './demo'

export type AuthStatus = 'unknown' | 'anonymous' | 'authed'

export type AuthSnapshot = {
  status: AuthStatus
  /** 仅 `authed` 时非空 */
  user: Me | null
}

/**
 * 演示模式（`TARO_APP_MOCK=1` 的构建）下**初值就是已登录**，不走 `unknown`：
 * 演示账号没有真会话，先给 `unknown` 会让每个受限页先闪一帧恢复占位。
 */
let snapshot: AuthSnapshot = DEMO_AUTH_ENABLED
  ? { status: 'authed', user: DEMO_USER }
  : { status: 'unknown', user: null }

const listeners = new Set<() => void>()

function emit(next: AuthSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 会话被**代码之外**的原因清掉时（会话过期 / 被后端撤销 → `request.ts` 对 401
 * `UNAUTHENTICATED` 就地 `clearSession()`），把自己同步拉回 `anonymous`。
 *
 * 不接这条线的话：store 会一直停在 `authed`，守卫认为「已登录」不再跳登录页，
 * 页面继续用 `authUser` 渲染身份 —— 用户看到的是一个永远登不出去也退不掉的假登录态。
 */
onSessionCleared(() => {
  // 演示账号没有真会话：真接口 401 不能把它踢回未登录，否则受限页立刻被守卫挡回登录页
  if (DEMO_AUTH_ENABLED) return
  if (snapshot.status !== 'anonymous') emit({ status: 'anonymous', user: null })
})

/** 当前快照。给非 React 调用方（守卫、调试）用 */
export function authSnapshot(): AuthSnapshot {
  return snapshot
}

/**
 * 订阅登录态。
 *
 * 第三参数（`getServerSnapshot`）与客户端同源：小程序没有 SSR，
 * 但 `useSyncExternalStore` 的类型要求提供它，传同一个函数即可。
 */
export function useAuth(): AuthSnapshot {
  return useSyncExternalStore(subscribe, authSnapshot, authSnapshot)
}

/** 冷启动只验一次：app 启动与页面守卫可能同时触发 */
let booting: Promise<void> | null = null

/**
 * 冷启动恢复登录态。
 *
 * 没有本地会话就直接判 `anonymous`，**不打网络** —— 首次进入的用户不该被一个
 * 必然 401 的请求拖慢。
 */
export function bootstrapAuth(): Promise<void> {
  if (booting) return booting
  // 演示账号：不读本地会话、也不打 `GET /me`（本地没有后端，这一问必然失败）
  if (DEMO_AUTH_ENABLED) return Promise.resolve()
  if (!readSession()) {
    emit({ status: 'anonymous', user: null })
    return Promise.resolve()
  }
  booting = fetchMe()
    .then((user) => {
      emit({ status: 'authed', user })
    })
    .catch((error) => {
      // 只有「后端明确说这个会话无效」才销毁本地凭据。
      // 网络不可达 / 后端没起时**保留** cookie：那只是这次问不到，不代表会话失效，
      // 删掉会逼用户重新输一次密码（而 401 UNAUTHENTICATED 时 `apiRequest`
      // 已就地清过存储，这里不必重复）。
      if (isUnauthenticatedError(error)) clearSession()
      // 两种情况在 UI 上都按未登录处理：我们无法证明当前会话还有效
      emit({ status: 'anonymous', user: null })
    })
    .finally(() => {
      booting = null
    })
  return booting
}

/**
 * 用一次**已经拿到权威结果**的认证响应就地更新 store，不额外打网络。
 *
 * 场景：校园认证页校验成功后拿到 `VerificationStatus`，其 `authStatus` / `verifiedAt`
 * 与 `Me` 同名同型，直接合并即可。这样做的两个理由：
 * 1. 「我的」页的取数 effect 依赖 `[authStatus, authUser]`（见 `pages/profile`）——
 *    合并会换出新的 `user` 对象，页面立刻重拉；不更新的话认证成功回去仍是未认证徽章；
 * 2. 若改成再打一次 `GET /me`，那次请求失败（15s 超时 / 断网）就会把刚认证成功的用户
 *    继续显示成未认证，而 verify 的 200 本身已经是权威结果，不该被一次多余往返否决。
 *
 * `ownerId` 是**发起那次请求的账号**，调用方必须传：认证请求可以飞行十几秒，期间用户
 * 完全可能退出、换号登录。只判断「当前已登录」会把 A 的认证结果合并进 B 的 `user`
 * —— 而 store 是全局单例，B 会长期显示一个假 VERIFIED（`GET /profile` 只写页面局部
 * state，不回写 store，所以不会自我纠正）。账号不是同一个就整个丢弃。
 */
export function applyVerification(
  ownerId: string,
  next: Pick<Me, 'authStatus' | 'verifiedAt'>,
): void {
  if (snapshot.status !== 'authed' || snapshot.user?.id !== ownerId) return
  emit({ status: 'authed', user: { ...snapshot.user, ...next } })
}

/**
 * 确认会话真的落到本地了再宣告登录。
 *
 * `apiRequest` 里 `saveSession` 是静默吞异常的（存储写失败不该让请求失败），
 * 于是存在一种坏结局：store 广播了 `authed`、磁盘上却没有会话 —— 之后每个请求
 * 都按匿名发、被 401 打回登录页，用户看到的是「登录成功又立刻掉线」。
 * 这里把它变成一个明确的失败，由登录 / 注册页如实报错。
 */
function assertSessionStored(): void {
  if (!readSession()) {
    throw new ApiError('SESSION_NOT_STORED', 0, '登录会话没能保存，请重试')
  }
}

/** 登录：成功后会话 cookie 由 `apiRequest` 落盘，确认落盘后再广播状态 */
export async function signIn(input: LoginRequest): Promise<Me> {
  const user = await login(input)
  assertSessionStored()
  emit({ status: 'authed', user })
  return user
}

/** 注册即登录：契约里注册响应与 `/me` 同构 */
export async function signUp(input: RegisterRequest): Promise<Me> {
  const user = await register(input)
  assertSessionStored()
  emit({ status: 'authed', user })
  return user
}

/**
 * 微信一键登录（#86 A 节）：`code` 由调用方用 `Taro.login()` 取（页面持有平台 API，
 * store 不碰 Taro，保持可在 bun 测试里直接 import）。
 *
 * 只有一次性 code 过界：openid / session_key 既不上报也不接收，服务端是唯一与微信
 * 换凭证的一方（契约见 `packages/contracts/src/auth/wechat.ts`）。
 * 与 `signIn()` 同样先确认会话落盘再广播，避免「登录成功又立刻掉线」。
 */
export async function signInWithWechat(code: string): Promise<Me> {
  const user = await wechatSignIn(code)
  assertSessionStored()
  emit({ status: 'authed', user })
  return user
}

/**
 * 退出登录的结果。
 *
 * `serverRevoked = false` 表示**本机已登出、但服务端会话没被注销**（后端不可达 / 超时）。
 * 这是必须如实回传的信息：服务端会话有 30 天 TTL，把「本地清 cookie」当成完整登出
 * 会让用户以为自己退出了，而那个会话在服务端仍然有效。
 */
export type SignOutResult = { serverRevoked: boolean }

/**
 * 只注销**服务端**会话，不动本地登录态。
 *
 * 拆出这一步是为了「先告知、再登出」：本地登出会广播 `anonymous`，
 * 受限页的守卫随即把页面跳去登录页 —— 如果登出和提示写在同一段里，
 * 提示（弹窗）就落在正在卸载的页面上，弱网下用户根本看不到。
 * 调用方可以先用这个函数拿到结果、把提示走完，再调 `clearLocalSession()`。
 */
export async function revokeServerSession(): Promise<boolean> {
  try {
    await logout()
    return true
  } catch {
    return false
  }
}

/**
 * 本地登出：清凭据 + 广播 `anonymous`（受限页守卫据此跳登录页）。
 *
 * 与 `revokeServerSession()` 配合使用见上；只想一步登出就用 `signOut()`。
 */
export function clearLocalSession(): void {
  clearSession()
  emit({ status: 'anonymous', user: null })
}

/**
 * 一步退出：先让后端清会话，再清本地。
 *
 * 后端不可达时仍然让本地登出 —— 否则用户会卡在「点退出没反应」，
 * 而带着一个已废弃的 cookie 继续发请求只会得到一串 401。但这种情况会通过返回值
 * 告诉调用方，由页面如实提示，不假装完整登出。
 */
export async function signOut(): Promise<SignOutResult> {
  const serverRevoked = await revokeServerSession()
  clearLocalSession()
  return { serverRevoked }
}
