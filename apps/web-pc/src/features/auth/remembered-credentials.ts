import { LoginRequestSchema } from '@fish/contracts/auth/session'

/**
 * 记住账号密码 / 自动登录（#329）的本机存储。
 *
 * 明文密码存 localStorage 是产品明确接受的取舍：校内平台、后端没有刷新令牌机制。
 * 读取一律过契约校验，损坏或不合法的存储按「无存储」处理，绝不阻塞手动登录。
 * 登出抑制放 sessionStorage —— 退出登录经 `window.location.assign('/pc/login')`
 * 整页刷新，内存标志活不过那次跳转。
 */
export type RememberedCredentials = {
  studentNo: string
  password: string
  autoLogin: boolean
}

const STORAGE_KEY = 'fish.pc.login.remember'
const LOGOUT_FLAG_KEY = 'fish.pc.login.logout'

export function loadRememberedCredentials(
  storage: Storage | undefined = globalThis.localStorage,
): RememberedCredentials | null {
  const raw = storage?.getItem(STORAGE_KEY)
  if (raw === undefined || raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const credentials = LoginRequestSchema.safeParse({
      studentNo: record.studentNo,
      password: record.password,
    })
    if (!credentials.success || typeof record.autoLogin !== 'boolean') return null
    return {
      autoLogin: record.autoLogin,
      password: credentials.data.password,
      studentNo: credentials.data.studentNo,
    }
  } catch {
    return null
  }
}

export function saveRememberedCredentials(
  credentials: RememberedCredentials,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  storage?.setItem(STORAGE_KEY, JSON.stringify(credentials))
}

export function clearRememberedCredentials(
  storage: Storage | undefined = globalThis.localStorage,
): void {
  storage?.removeItem(STORAGE_KEY)
}

export function markExplicitLogout(
  storage: Storage | undefined = globalThis.sessionStorage,
): void {
  storage?.setItem(LOGOUT_FLAG_KEY, '1')
}

/** 读到显式登出标志就消费掉：只抑制紧随登出的那一次登录页落地。 */
export function consumeExplicitLogout(
  storage: Storage | undefined = globalThis.sessionStorage,
): boolean {
  if (storage === undefined || storage.getItem(LOGOUT_FLAG_KEY) === null) return false
  storage.removeItem(LOGOUT_FLAG_KEY)
  return true
}
