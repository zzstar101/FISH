import { describe, expect, test } from 'bun:test'
import { PHONE_BIND_CLIENT_TIMEOUT_MS } from '@fish/contracts/auth/phone'
import { WECHAT_PLATFORM_TIMEOUT_MS } from '../wechat/access-token'
import {
  API_HTTP_IDLE_TIMEOUT_SECONDS,
  PHONE_BIND_LOCAL_ALLOWANCE_MS,
  PHONE_BIND_SERVER_BUDGET_MS,
  PHONE_BIND_STEPS_PER_ATTEMPT,
  PHONE_BIND_UPSTREAM_ATTEMPTS,
  PHONE_BIND_UPSTREAM_BUDGET_MS,
} from './phone-bind-budget'

/**
 * 手机号绑定的三层超时必须对齐（#204 审查第一轮 P1）。
 *
 * 事故形状：`Bun.serve` 默认 `idleTimeout` = 10s，而这条链路最坏 ≈20s。于是连接在 10s 被掐断、
 * 客户端收到 `ECONNRESET`，处理器 18.8s 后照样完成并写库 —— 用户看到「网络异常」，号码却已经
 * 绑上了，还会诱发重复授权。
 *
 * 这里钉住的是**不变的预算关系**（不是某个具体实现细节）：上游总预算 ≤ 服务端预算 ≤
 * 服务端连接超时 < 客户端超时。任何一端被改动而没同步，这里会红。
 */
describe('手机号绑定：上游预算 / 服务端连接超时 / 客户端超时', () => {
  test('上游总预算 = 趟数 × 每趟步骤 × 单步超时 = 20s', () => {
    expect(PHONE_BIND_UPSTREAM_BUDGET_MS).toBe(
      PHONE_BIND_UPSTREAM_ATTEMPTS * PHONE_BIND_STEPS_PER_ATTEMPT * WECHAT_PLATFORM_TIMEOUT_MS,
    )
    // 与 `wechat-phone.ts` 的 `resolve()` 形状一致：初次 + 凭证失效重试一次，每趟「取 token + 换号」
    expect(PHONE_BIND_UPSTREAM_ATTEMPTS).toBe(2)
    expect(PHONE_BIND_STEPS_PER_ATTEMPT).toBe(2)
    expect(PHONE_BIND_UPSTREAM_BUDGET_MS).toBe(20_000)
  })

  test('服务端预算 = 上游预算 + 本地写库留量', () => {
    expect(PHONE_BIND_SERVER_BUDGET_MS).toBe(
      PHONE_BIND_UPSTREAM_BUDGET_MS + PHONE_BIND_LOCAL_ALLOWANCE_MS,
    )
  })

  test('Bun.serve 的 idleTimeout 覆盖服务端最坏耗时（否则连接先被掐断）', () => {
    expect(API_HTTP_IDLE_TIMEOUT_SECONDS * 1000).toBeGreaterThanOrEqual(PHONE_BIND_SERVER_BUDGET_MS)
    // 若没覆盖到默认值，这条链路等于又退回 10s 的老问题
    expect(API_HTTP_IDLE_TIMEOUT_SECONDS).toBeGreaterThan(10)
  })

  test('客户端超时严格长于服务端连接超时（客户端不能先放弃，否则「网络异常」而号码已落库）', () => {
    expect(PHONE_BIND_CLIENT_TIMEOUT_MS).toBeGreaterThan(API_HTTP_IDLE_TIMEOUT_SECONDS * 1000)
  })

  test('idleTimeout 只接受整数秒，且不超过 Bun 的上限 255 秒', () => {
    expect(Number.isInteger(API_HTTP_IDLE_TIMEOUT_SECONDS)).toBe(true)
    expect(API_HTTP_IDLE_TIMEOUT_SECONDS).toBeLessThanOrEqual(255)
  })
})

/**
 * 关系式之外还要证明**机制**成立：真实 `Bun.serve` 在显式 `idleTimeout` 下不会掐断长处理器。
 *
 * 处理器故意跑「第一次尝试的两段上游」（取 token 5s + 换号 5s）再 +0.3s：刚好越过 Bun 的默认
 * 10s（不设 `idleTimeout` 时这里会像审查复现那样收到 ECONNRESET），又远在新超时 22s 之内。
 * 完整跑满 20s 太慢，这段足够证明「预算是按显式 idleTimeout 兑现的」。
 */
describe('真实 Bun.serve：长于默认 10s 的绑定请求不会被掐断', () => {
  test('处理器耗时 10.3s 仍能拿到 200（客户端用契约里的 25s 超时）', async () => {
    const handlerDurationMs = PHONE_BIND_STEPS_PER_ATTEMPT * WECHAT_PLATFORM_TIMEOUT_MS + 300
    const server = Bun.serve({
      port: 0,
      idleTimeout: API_HTTP_IDLE_TIMEOUT_SECONDS,
      fetch: async () => {
        await Bun.sleep(handlerDurationMs)
        return new Response('bound')
      },
    })
    try {
      const response = await fetch(`http://localhost:${server.port}/auth/phone/bind`, {
        method: 'POST',
        signal: AbortSignal.timeout(PHONE_BIND_CLIENT_TIMEOUT_MS),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('bound')
    } finally {
      server.stop(true)
    }
  }, 30_000)
})
