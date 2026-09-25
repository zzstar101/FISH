import { describe, expect, test } from 'bun:test'
import { resolveClientIp } from './client-ip'

/**
 * 客户端 IP 解析（#197 限流的分桶依据）。
 *
 * 这里钉的是**反代下的信任边界**：回环 peer 才允许读 XFF（且只认最右侧那一项，因为
 * Caddy 会追加真实客户端地址）；非回环 peer 一律忽略 XFF，否则伪造一行 header 就能绕过限流。
 */
describe('resolveClientIp', () => {
  test('非回环 peer：直接用 peer，忽略 XFF（防伪造）', () => {
    expect(resolveClientIp({ peerAddress: '203.0.113.9', forwardedFor: '1.2.3.4, 5.6.7.8' })).toBe(
      '203.0.113.9',
    )
  })

  test('回环 peer：取 XFF 最右侧的合法 IP（Caddy 追加的那个）', () => {
    expect(resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: '203.0.113.9' })).toBe(
      '203.0.113.9',
    )
    // 客户端自己伪造的前缀要落在左侧，右侧仍是反代看到的真实地址。
    expect(
      resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: '1.2.3.4, 203.0.113.9' }),
    ).toBe('203.0.113.9')
    expect(resolveClientIp({ peerAddress: '::1', forwardedFor: '2001:db8::1' })).toBe('2001:db8::1')
  })

  test('回环 peer 但没有可信 XFF：退回 peer，不把任意文本当来源', () => {
    expect(resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: null })).toBe('127.0.0.1')
    expect(resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: 'not-an-ip' })).toBe(
      '127.0.0.1',
    )
    expect(resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: '   ' })).toBe('127.0.0.1')
  })

  test('最右侧不合法时绝不往左取：更左侧是客户端可伪造的值', () => {
    // Caddy 会把真实客户端追加在末尾；末尾不是合法 IP 时，左边那些只能来自客户端。
    expect(
      resolveClientIp({ peerAddress: '127.0.0.1', forwardedFor: '203.0.113.9, garbage' }),
    ).toBe('127.0.0.1')
  })

  test('全字母的合法 IPv6 也要认（粗糙的「必须含数字」形状判断会漏）', () => {
    expect(
      resolveClientIp({
        peerAddress: '127.0.0.1',
        forwardedFor: '1.2.3.4, dead:beef:cafe:babe:face:feed:deaf:fade',
      }),
    ).toBe('dead:beef:cafe:babe:face:feed:deaf:fade')
  })

  test('拿不到 peer：归入同一个 unknown 桶', () => {
    expect(resolveClientIp({ peerAddress: null, forwardedFor: '203.0.113.9' })).toBe('unknown')
  })

  test('127.0.0.0/8 整段都算本机反代', () => {
    expect(resolveClientIp({ peerAddress: '127.0.0.5', forwardedFor: '203.0.113.9' })).toBe(
      '203.0.113.9',
    )
  })
})
