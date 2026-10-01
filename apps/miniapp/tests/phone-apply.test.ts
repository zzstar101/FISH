import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'

/**
 * `applyPhone` 的**运行期**行为（#204）。
 *
 * 为什么不靠源码字符串断言：Issue 的验收项「切号/退出/卸载后旧任务不以新会话写入，
 * 不更新新账号掩码」是**行为**要求，而 `toContain('snapshot.user?.id !== ownerId')`
 * 挡不住守卫被挪到赋值之后、`!==` 被写成 `===`、或 `emit` 根本不再被调用。
 * 这里按 `recommendation-viewer-integration.test.ts` 的同一套 mock 手法把 store
 * 真拉起来跑（真 Taro 在 Bun 下会抛 `ENABLE_INNER_HTML is not defined`）。
 */
const SESSION_KEY = 'fish:session'
const store = new Map<string, unknown>()

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => store.get(key) ?? '',
    setStorageSync: (key: string, data: unknown) => {
      store.set(key, data)
    },
    removeStorageSync: (key: string) => {
      store.delete(key)
    },
    onAppShow: () => undefined,
    onNetworkStatusChange: () => undefined,
  },
}))

/** `__DEMO_AUTH__` 是构建期注入的全局，测试运行时不存在，import 期会 ReferenceError。 */
const demoModule = () => ({
  DEMO_AUTH_ENABLED: false,
  DEMO_USER: {
    id: 'usr_demo',
    nickname: '演示同学',
    avatarUrl: null,
    authStatus: 'VERIFIED' as const,
    verifiedAt: null,
    phoneBound: false,
    maskedPhone: null,
  },
})
mock.module('@/features/auth/demo', demoModule)
mock.module('../src/features/auth/demo', demoModule)

let nextMe: Me = { id: 'usr_unset' } as Me
const authApiModule = () => ({
  fetchMe: async () => nextMe,
  logout: async () => undefined,
  wechatSignIn: async () => {
    throw new Error('本用例不该调用 wechatSignIn')
  },
})
mock.module('@/features/auth/api', authApiModule)
mock.module('../src/features/auth/api', authApiModule)

const { applyPhone, authSnapshot, bootstrapAuth, clearLocalSession } = await import(
  '@/features/auth/store'
)

const userA: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: 'A',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
}
const userB: Me = { ...userA, id: 'usr_01jc000000e00800000000000b', nickname: 'B' }

const BOUND_A = { phoneBound: true as const, maskedPhone: '138****8000' }

beforeEach(() => {
  store.clear()
  // 有本地会话才会真的打 `fetchMe`；冷启动无会话时 bootstrapAuth 直接判匿名。
  store.set(SESSION_KEY, 'fish_session=abc')
  nextMe = userA
})

describe('applyPhone：换号 / 登出后不得把掩码写进新账号', () => {
  test('同一账号：掩码与 phoneBound 就地写回 store', async () => {
    await bootstrapAuth()
    expect(authSnapshot().user?.id).toBe(userA.id)

    applyPhone(userA.id, BOUND_A)

    expect(authSnapshot()).toEqual({
      status: 'authed',
      user: { ...userA, ...BOUND_A },
    })
  })

  test('发起后换了账号：A 的绑定结果整个丢弃，B 的掩码不被污染', async () => {
    await bootstrapAuth()
    expect(authSnapshot().user?.id).toBe(userA.id)

    // 绑定请求飞行途中用户换号登录成 B
    nextMe = userB
    await bootstrapAuth()
    expect(authSnapshot().user?.id).toBe(userB.id)

    applyPhone(userA.id, BOUND_A)

    const snapshot = authSnapshot()
    expect(snapshot.user?.id).toBe(userB.id)
    expect(snapshot.user?.phoneBound).toBe(false)
    expect(snapshot.user?.maskedPhone).toBeNull()
  })

  test('发起后已登出：不把 store 拉回 authed，也不落掩码', async () => {
    await bootstrapAuth()

    clearLocalSession()
    expect(authSnapshot()).toEqual({ status: 'anonymous', user: null })

    applyPhone(userA.id, BOUND_A)

    expect(authSnapshot()).toEqual({ status: 'anonymous', user: null })
  })
})
