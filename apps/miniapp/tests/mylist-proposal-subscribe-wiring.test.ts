import { describe, expect, test } from 'bun:test'

/**
 * 「我卖出的」里提案的两个动作与 TX 订阅授权（#511 审查 high）。
 *
 * 修复前 `requestSubscribe(['TX'])` 写在 `declineProposal()` 里：拒绝提案的人被弹了「订单状态
 * 更新提醒」的授权框，而他随后**没有任何交易**（拒绝只写一条 SYSTEM 消息、商品留在在售），
 * 那次「允许」永远不会兑现；真正该问的同意的那个动作反而没问。
 *
 * 仓库没有 Taro 组件渲染基建，页面级行为只能读源码文本钉住（先例 `comments-wiring.test.ts`）。
 * 这是弱验证：真正的时序靠端上演示，这里只钉住"哪个动作调、在同步阶段调、不 await"。
 */

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pkg-browse/pages/mylist/index.tsx', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end` 之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to)
}

describe('我卖出的：提案动作与订阅授权', () => {
  test('拒绝提案不请求 TX 授权', async () => {
    const decline = sliceFrom(
      await source(),
      'const declineProposal = (row: Row) =>',
      'const acceptProposal',
    )

    expect(decline).not.toContain('requestSubscribe')
  })

  test('同意提案在用户手势的同步阶段请求 TX 授权，且不 await', async () => {
    const accept = sliceFrom(
      await source(),
      'const acceptProposal = (row: Row) =>',
      'const goPublish',
    )

    const requested = accept.indexOf("void requestSubscribe(['TX'])")
    const asyncFlow = accept.indexOf('void (async () => {')
    expect(requested).toBeGreaterThanOrEqual(0)
    expect(asyncFlow).toBeGreaterThanOrEqual(0)
    // 必须在进入异步流程之前：授权调用一旦落到 await 之后就不再属于用户手势
    expect(requested).toBeLessThan(asyncFlow)
    // 且是 `void` 掉的：await 会阻塞主流程，被拒时还会挡下这次同意
    expect(accept).not.toContain('await requestSubscribe')
  })
})
