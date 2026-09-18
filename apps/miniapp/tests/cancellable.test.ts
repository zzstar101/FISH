import { describe, expect, test } from 'bun:test'
import { cancellable } from '../src/lib/cancellable'

/**
 * `cancellable` 的回归测试 —— 锁住 #105 那个 P1 的行为：
 * **effect 重跑（换账号 / 退出）之后，上一轮请求迟到的响应不得再写状态。**
 *
 * 说明：修复前的实现里根本没有取消机制（只在响应侧比对 user.id），所以这三条用例
 * 无法在旧代码上运行；它们锁的是修复后的行为，也是这段逻辑唯一的自动化防线。
 * 运行时证据见 PR 里的复现说明与截图（迟到的 `/profile` 响应确实会写进页面状态）。
 */
describe('cancellable', () => {
  test('取消之后，迟到的结果被丢弃', async () => {
    let resolveLate: (value: string) => void = () => {}
    const load = cancellable(
      () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve
        }),
      () => true,
    )

    load.cancel()
    resolveLate('上一轮的响应')

    expect(await load.promise).toBeNull()
    expect(load.isCancelled()).toBe(true)
  })

  test('未取消且 accept 通过时收下结果', async () => {
    const load = cancellable(
      async () => 'B 的资料',
      (value) => value.includes('B'),
    )

    expect(await load.promise).toBe('B 的资料')
    expect(load.isCancelled()).toBe(false)
  })

  test('accept 不通过时（例如响应属于上一个账号）按 null 丢弃', async () => {
    const load = cancellable(
      async () => 'A 的资料',
      (value) => value.includes('B'),
    )

    expect(await load.promise).toBeNull()
  })

  test('cancel 可直接作为 effect cleanup 使用（幂等）', async () => {
    const load = cancellable(
      async () => 'ok',
      () => true,
    )

    load.cancel()
    load.cancel()

    expect(await load.promise).toBeNull()
  })
})
