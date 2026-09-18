/**
 * 演示登录态（**只在 `TARO_APP_MOCK=1` 的构建里生效**）。
 *
 * 为什么需要它：出物 / 消息等受限页要登录才渲染，而登录走真接口
 * （`features/auth/api.ts` 没有 mock 回退、`mock/api.ts` 里也没有登录函数），
 * 本机没有后端时这些页只能看到登录引导卡 —— 页面本身没法看。
 * 这里在**同一个构建期开关**下（`__ALLOW_MOCK_FALLBACK__`，注入点见 `config/index.ts`）
 * 直接给一个已登录的演示账号，让所有页面可达。
 *
 * 生产不受影响：`taro build` 走 production，不显式给 `TARO_APP_MOCK=1` 就注入 false。
 *
 * 已知边界：设置页的「退出登录」仍会走真接口并清本地会话 —— 演示模式下点了会回到
 * 登录页且登不回来（需要重启开发者工具）。要长期演示的话得单独处理。
 */
import type { Me } from '@fish/contracts/auth/user'

declare const __ALLOW_MOCK_FALLBACK__: boolean | undefined

/** 与 `features/fetchers.ts` 的 mock 回退同一个开关，不另立构建变量 */
export const DEMO_AUTH_ENABLED = __ALLOW_MOCK_FALLBACK__ === true

/**
 * 形状照 `MeSchema`（`packages/contracts/src/auth/user.ts`）：
 * `id` 是合法 uuid v4（页面可能拿它当 key 或做契约解析），
 * `campus` / `authStatus` 取真实值域里的值，`avatarUrl` 给 null 让页面走首字母兜底。
 */
export const DEMO_USER: Me = {
  id: '9f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
  nickname: '演示同学',
  avatarUrl: null,
  campus: '肇庆',
  authStatus: 'VERIFIED',
  verifiedAt: '2026-01-01T00:00:00.000Z',
}
