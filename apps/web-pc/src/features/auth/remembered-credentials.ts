import { LoginRequestSchema } from '@fish/contracts/auth/session'

/**
 * 记住账号密码 / 自动登录（#329）的本机存储。
 *
 * 明文密码存 localStorage 是产品明确接受的取舍：校内平台、后端没有刷新令牌机制。
 * 读取一律过契约校验，存储损坏、不合法或**整体不可访问**（浏览器禁用存储时抛
 * SecurityError）一律按「无存储」降级，绝不阻塞手动登录。
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

type StorageKind = 'local' | 'session'

function defaultStorage(kind: StorageKind): Storage | undefined {
  try {
    const storage = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage
    return storage ?? undefined
  } catch {
    return undefined
  }
}

export function loadRememberedCredentials(storage?: Storage): RememberedCredentials | null {
  const store = storage ?? defaultStorage('local')
  if (store === undefined) return null
  try {
    const raw = store.getItem(STORAGE_KEY)
    if (raw === null) return null
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
  storage?: Storage,
): void {
  const store = storage ?? defaultStorage('local')
  try {
    store?.setItem(STORAGE_KEY, JSON.stringify(credentials))
  } catch {
    // 存储不可写（隐私模式 / 配额）时放弃记住，登录流程本身不受影响。
  }
}

export function clearRememberedCredentials(storage?: Storage): void {
  const store = storage ?? defaultStorage('local')
  try {
    store?.removeItem(STORAGE_KEY)
  } catch {
    // 同上：清不掉也只是多留一份本机数据。
  }
}

export function markExplicitLogout(storage?: Storage): void {
  const store = storage ?? defaultStorage('session')
  try {
    store?.setItem(LOGOUT_FLAG_KEY, '1')
  } catch {
    // 标志写不进去的后果只是登出后多一次自动登录尝试，不值得让登出报错。
  }
}

/** 读到显式登出标志就消费掉：只抑制紧随登出的那一次登录页落地。 */
export function consumeExplicitLogout(storage?: Storage): boolean {
  const store = storage ?? defaultStorage('session')
  if (store === undefined) return false
  try {
    if (store.getItem(LOGOUT_FLAG_KEY) === null) return false
    store.removeItem(LOGOUT_FLAG_KEY)
    return true
  } catch {
    return false
  }
}

/** 挂载时的自动登录决策：回填归组件 state，这里只决定「要不要代用户提交一次」。 */
export type AutoLoginDecision =
  | { action: 'none' }
  | { action: 'submit'; password: string; studentNo: string }

export function decideAutoLogin(
  stored: RememberedCredentials | null,
  logoutMarked: boolean,
): AutoLoginDecision {
  if (stored === null || logoutMarked || !stored.autoLogin) return { action: 'none' }
  return { action: 'submit', password: stored.password, studentNo: stored.studentNo }
}

/** 凭据被 401 拒绝后的新存储：关掉自动登录，账号密码保留。 */
export function disableAutoLogin(stored: RememberedCredentials): RememberedCredentials {
  return { ...stored, autoLogin: false }
}
