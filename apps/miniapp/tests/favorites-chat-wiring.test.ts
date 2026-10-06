import { describe, expect, test } from 'bun:test'

/**
 * 收藏页「聊一聊」接线层的回归（仓库没有 Taro 组件渲染基建，页面级行为读源码
 * 钉桩，先例 `tests/history-wiring.test.ts`）。这里钉三条最容易回退的接线：
 * 1. 走真写 `createConversation`（不许退回「聊天待接入」的 toast）；
 * 2. 演示行在入口就拦下 —— 不发请求、不假装成功（id 不在库里，写了必然 404）；
 * 3. 成功必须拿**服务端**的 `conversation.id` 跳会话页，且迟到回调按账号丢弃。
 */

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pkg-browse/pages/favorites/index.tsx', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

/** 断言 `first` 出现在 `second` 之前（两者都必须存在） */
function expectBefore(block: string, first: string, second: string): void {
  const i = block.indexOf(first)
  const j = block.indexOf(second)
  expect(i, `块里应出现 ${first}`).toBeGreaterThanOrEqual(0)
  expect(j, `块里应出现 ${second}`).toBeGreaterThanOrEqual(0)
  expect(i).toBeLessThan(j)
}

describe('收藏页「聊一聊」：接线', () => {
  test('走真写 POST /conversations，死按钮 toast 不许回来', async () => {
    const code = await source()
    expect(code).toContain('createConversation(item.id)')
    expect(code).not.toContain('聊天待接入')
  })

  test('演示行在入口拦下：不发请求、不假装成功', async () => {
    const code = await source()
    const chatWith = sliceFrom(
      code,
      'const chatWith = (item: FavoriteItem) => {',
      'if (chatEpochRef.current === epoch) setChattingId(null)',
    )
    const demo = sliceFrom(chatWith, 'if (item.demo) {', 'return\n    }')
    expect(demo).toContain('toast(')
    // 拦下必须在发起请求**之前**：先请求后拦就等于真写了 404
    expectBefore(chatWith, 'if (item.demo) {', 'createConversation(item.id)')
  })

  test('成功拿服务端 conversation.id 跳会话页，迟到回调按世代丢弃', async () => {
    const code = await source()
    const chatWith = sliceFrom(
      code,
      'const chatWith = (item: FavoriteItem) => {',
      'if (chatEpochRef.current === epoch) setChattingId(null)',
    )
    expect(chatWith).toContain('url: `/pkg-social/pages/conversation/index?id=')
    expect(chatWith).toContain('{conversation.id}`')
    // 迟到的成功响应不许导航：世代对不上（换号 / 离页）必须先 return
    expectBefore(chatWith, 'if (chatEpochRef.current !== epoch) return', 'conversation.id')
  })

  test('失败文案走 createConversation 专用映射器（商品不存在时不说成普通失败）', async () => {
    const code = await source()
    expect(code).toContain('describeCreateConversationFailure(error)')
  })

  test('不做上架状态预检：下架 / 已售仍能建会话（服务端只要求商品存在）', async () => {
    const code = await source()
    const chatWith = sliceFrom(
      code,
      'const chatWith = (item: FavoriteItem) => {',
      'if (chatEpochRef.current === epoch) setChattingId(null)',
    )
    // 契约不限制 ACTIVE（`packages/contracts/src/chat/routes.ts`）：按上下架状态预检
    // 会拦掉服务端明确允许的会话，唯一允许的入口拦截是**演示行 id**（上一用例）。
    const upToRequest = chatWith.slice(0, chatWith.indexOf('createConversation(item.id)'))
    expect(upToRequest).not.toContain('OFFLINE')
    expect(upToRequest).not.toContain('SOLD')
    expect(upToRequest).not.toContain('.status')
  })

  test('世代在换账号渲染期重置与卸载清理两处都前进', async () => {
    const code = await source()
    const bumps = code.match(/chatEpochRef\.current \+= 1/g) ?? []
    expect(bumps.length, '换账号与卸载两条路径都要 bump 世代').toBeGreaterThanOrEqual(2)
  })

  test('换账号渲染期重置清掉在飞的聊一聊锁', async () => {
    const code = await source()
    const reset = sliceFrom(code, 'if (prevUserId !== userId) {', 'chatEpochRef.current += 1')
    expect(reset).toContain('setRemoving(false)')
    expect(reset).toContain('setChattingId(null)')
    expect(reset).toContain('chatEpochRef.current += 1')
  })
})
