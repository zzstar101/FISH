/**
 * 登录态存储。
 *
 * **为什么不用 cookie 自动携带**：后端会话是 httpOnly cookie（`apps/api/src/modules/auth/session.ts`），
 * 小程序没有浏览器那套 cookie jar 语义，`Taro.request` 不会自动带上、也不会自动种下。
 * 而 `apps/api` 与 `packages/contracts` 里**没有任何 Bearer / Authorization 支持**，
 * 微信登录换 access token 的 #86 仍是 OPEN。
 *
 * 所以当前实现是：登录响应里把 `fish_session` 取出来自己存（`Taro.setStorageSync`），
 * 之后每个请求手动放进 `Cookie` 头——后端 `requireAuth` 只读这个 cookie，因此能直接工作，
 * **不需要改后端**。等 #86 落地后，这里换成 access token + `Authorization: Bearer`，
 * 调用方（`request.ts` 的 `authHeader()`）不用动。
 */
import Taro from '@tarojs/taro'

const SESSION_KEY = 'fish:session'

/** 后端下发的会话 cookie 名（`session.ts` 的 `COOKIE_NAME`） */
const COOKIE_NAME = 'fish_session'

/**
 * 会话代次：每次 `clearSession()` 自增。
 *
 * `request.ts` 发请求前记下代次、回来时比对：代次变了说明「这次请求在飞行途中
 * 用户退出了登录」，那响应里带来的 cookie 就必须**丢弃** —— 否则退出后被清除的
 * 旧会话会被一个迟到的响应重新写回本地，出现「本地有会话、但登录态是未登录」的分裂状态。
 */
let epoch = 0

export function sessionEpoch(): number {
  return epoch
}

type SessionClearedListener = () => void

const clearedListeners = new Set<SessionClearedListener>()

/**
 * 订阅「本地会话被清掉」。
 *
 * 401 `UNAUTHENTICATED`（会话过期或被后端撤销）时 `request.ts` 会就地清会话；
 * 登录态 store 必须据此把自己从 `authed` 拉回 `anonymous`，否则页面守卫看不出未登录、
 * 会停在一个「看起来已登录」的假状态里。
 */
export function onSessionCleared(listener: SessionClearedListener): () => void {
  clearedListeners.add(listener)
  return () => {
    clearedListeners.delete(listener)
  }
}

/**
 * 从 `Set-Cookie` 数组里挑出会话 cookie。
 * `Taro.request` 的响应把 cookie 放在 `cookies: string[]`，每项形如 `name=value; Path=/; ...`。
 */
export function pickSessionCookie(cookies: string[] | undefined): string | null {
  if (!cookies?.length) return null
  const hit = cookies.find((item) => item.startsWith(`${COOKIE_NAME}=`))
  if (!hit) return null
  // 只取 `name=value` 那一段，丢掉 `Path` / `Expires` 等属性
  const [pair] = hit.split(';')
  if (!pair) return null
  // `fish_session=`（空值）是后端**清 cookie** 的下发形态（`POST /auth/logout`），不是有效会话。
  // 落盘它会让下次冷启动白发一次必然 401 的 `GET /me`，后续请求也会一直带着一个空 cookie。
  const value = pair.slice(pair.indexOf('=') + 1).trim()
  return value.length > 0 ? pair : null
}

export function readSession(): string | null {
  try {
    const value = Taro.getStorageSync(SESSION_KEY)
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

export function saveSession(cookie: string): void {
  try {
    Taro.setStorageSync(SESSION_KEY, cookie)
  } catch {
    /* 存储失败不致命：本次会话内仍可继续用返回值 */
  }
}

export function clearSession(): void {
  epoch += 1
  try {
    Taro.removeStorageSync(SESSION_KEY)
  } catch {
    /* 忽略 */
  }
  for (const listener of clearedListeners) listener()
}

/** 给请求头用的 Cookie 值；未登录返回 undefined（后端按匿名处理） */
export function sessionCookieHeader(): string | undefined {
  return readSession() ?? undefined
}
