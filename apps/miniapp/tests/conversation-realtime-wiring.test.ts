/**
 * 会话页实时通道接线层的回归（#89）。
 *
 * 本仓 `apps/miniapp/tests/` **没有 Taro 组件渲染基建**（页面用真 `@tarojs/taro` 加载会抛
 * `ENABLE_INNER_HTML is not defined`，见 `tests/conversation-unread-wiring.test.ts` 文件头），
 * 页面接线只能读源码文本钉住 —— 手法同 `tests/following-wiring.test.ts`、
 * `tests/conversation-unread-wiring.test.ts`。
 *
 * 判据层（合并 / 撤回 / 读位 / 在线态）已由 `tests/conversation-view.test.ts` 与
 * `tests/chat-realtime.test.ts` 覆盖；本文件钉的是**页面有没有把判据接对**：
 * 五类事件各自落到哪条流、哪几道闸、撤回要不要同时落媒体流、对方消息要不要补已读。
 */
import { describe, expect, test } from 'bun:test'

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

/** 实时分发器（`realtimeEventRef.current = ...` 到 `message.recalled` 那一支之前） */
function dispatchBlock(code: string): string {
  return sliceFrom(code, 'realtimeEventRef.current = (event) => {', "case 'message.recalled'")
}

/** 分发器里 `message.recalled` 那一段 */
function recallCase(code: string): string {
  return sliceFrom(code, "case 'message.recalled':", 'setReplyTarget(')
}

describe('#89 会话页实时通道 · 接线', () => {
  test('五类事件都接了，且只消费当前会话（presence 按用户命中）', async () => {
    const code = await source()
    const dispatch = dispatchBlock(code)

    expect(dispatch).toContain("case 'message.new':")
    expect(dispatch).toContain("case 'media.new':")
    expect(dispatch).toContain("case 'conversation.read':")
    expect(recallCase(code)).toContain("case 'message.recalled':")
    // presence 没有 conversationId：必须在会话 id 闸**之前**按 userId 命中
    const presenceIndex = code.indexOf("if (event.type === 'presence.changed')")
    const gateIndex = code.indexOf('if (event.conversationId !== conversationId) return')
    expect(presenceIndex).toBeGreaterThanOrEqual(0)
    expect(gateIndex).toBeGreaterThanOrEqual(0)
    expect(presenceIndex).toBeLessThan(gateIndex)
    expect(code).toContain('applyPresenceEvent(prev, event.userId, event.presence)')
  })

  test('消息与媒体分别落到 messages / media 两条流', async () => {
    const code = await source()
    const dispatch = dispatchBlock(code)

    expect(dispatch).toContain('setMessages((prev) => mergePushedMessage(prev, event.message))')
    expect(dispatch).toContain('setMedia((prev) => mergePushedMedia(prev, event.media))')
  })

  test('conversation.read：自己的回声要挡掉（readerId === 我 不翻本页已读标签）', async () => {
    const code = await source()

    expect(dispatchBlock(code)).toContain('if (event.readerId === userIdRef.current) break')
    expect(code).toContain('applyReadEvent(prev, event.readAt)')
  })

  test('message.recalled 同时落到消息流与媒体流（撤回端点对 TEXT / MEDIA 无类型过滤）', async () => {
    const code = await source()
    const recall = recallCase(code)

    expect(recall).toContain('applyRecalled(prev, event.messageId, event.recalledAt)')
    expect(recall).toContain('applyMediaRecalled(prev, event.messageId, event.recalledAt)')
  })

  test('媒体气泡自己会渲染撤回碑（服务端撤回后 url 为空，不能画成空图）', async () => {
    const code = await source()
    const mediaBranch = code.indexOf("if (entry.kind === 'media')")
    expect(mediaBranch).toBeGreaterThanOrEqual(0)
    // `recalledAt` 判断必须早于取本地路径（下载路径）—— 否则撤回碑还会去读/下图
    const tombstone = code.indexOf('item.recalledAt !== null', mediaBranch)
    const downloadHint = code.indexOf('localPaths.get(item.mediaId)', mediaBranch)
    expect(tombstone).toBeGreaterThanOrEqual(0)
    expect(downloadHint).toBeGreaterThanOrEqual(0)
    expect(tombstone).toBeLessThan(downloadHint)
  })

  test('撤回碑不参与自动下载（没有字节可下）', async () => {
    const code = await source()
    const downloadEffect = sliceFrom(
      code,
      'for (const item of media) {',
      'const plan = planMediaLoad(',
    )

    expect(downloadEffect).toContain('if (item.recalledAt !== null) continue')
  })

  test('对方消息到达时补一次已读上报，但页面不可见 / 自己发的 / 详情未就绪时不报', async () => {
    const code = await source()
    const body = sliceFrom(code, 'const markIncomingRead = (senderId', '  const realtimeEventRef')

    // 三条闸：自己发的、页面被盖住 / 已卸载、详情未就绪
    expect(body).toContain('senderId === userIdRef.current')
    expect(body).toContain('!visibleRef.current || !aliveRef.current')
    expect(body).toContain("convStateRef.current !== 'ok'")
    expect(body).toContain('markConversationRead(conversationId)')
    // 两个入口都要调它（文本 + 媒体）
    const dispatch = dispatchBlock(code)
    expect(dispatch).toContain('markIncomingRead(event.message.senderId)')
    expect(dispatch).toContain('markIncomingRead(event.media.senderId)')
  })

  test('load() 的已读上报在页面不可见时不发（隐藏期重连补刷不得清未读）', async () => {
    const code = await source()
    const readReport = sliceFrom(
      code,
      'if (\n            current === epoch.current &&',
      'markConversationRead(conversationId)',
    )

    expect(readReport).toContain('visibleRef.current')
  })

  test('刷新落地一律走合并（推送可能在非 silent 重拉的在途期到达）', async () => {
    const code = await source()

    // 消息半边：不再有 `baseIds === null ? page.items :` 的整份替换分支
    expect(code).not.toContain('baseIds === null ? page.items')
    expect(code).toContain(
      'keepRecalledTombstones(prev, mergeRefreshedMessages(prev, page.items, baseIds))',
    )
    // 媒体半边同理，且要过撤回碑守卫
    expect(code).not.toContain('mediaBaseIds === null ? mediaPage.items')
    expect(code).toContain(
      'keepRecalledMediaTombstones(\n                prev,\n                mergeRefreshedMedia(prev, mediaPage.items, mediaBaseIds),\n              )',
    )
    // 基准集不再与 silent 绑定
    expect(code).not.toContain('silent ? new Set(messagesRef.current')
  })

  test('连接生命周期带身份闸：换账号后旧连接的推送与补刷都不许落地', async () => {
    const code = await source()
    const lifecycle = sliceFrom(
      code,
      'const client = new ChatRealtime({',
      'return () => client.stop()',
    )

    expect(lifecycle).toContain('if (userIdRef.current !== owner) return')
    // 事件与补刷两条路径都要过闸
    expect(lifecycle.match(/if \(userIdRef\.current !== owner\) return/g)?.length).toBe(2)
    // 依赖里含 conversationId：换会话重建（服务端推的是「全部会话」，本页只消费当前这条）
    expect(code).toContain('}, [authStatus, userId, conversationId])')
  })
})
