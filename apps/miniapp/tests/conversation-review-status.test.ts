import { describe, expect, test } from 'bun:test'
import {
  canRetry,
  canRetryMedia,
  type PendingMedia,
  type PendingMediaDraft,
  type PendingMessage,
  reviewStatusLabel,
  sendCooldownSeconds,
  sendFailureText,
  startMediaRetry,
} from '../src/pkg-social/pages/conversation/view'

/**
 * 私聊审核的端上三态（#694 M4）。
 *
 * 页面本身没有 Taro 渲染基建（见 `tests/conversation-unread-wiring.test.ts` 文件头），
 * 所以文案与门禁的判据抽在 `view.ts` 里单测，页面只钉接线（见文件末尾）。
 */

function pendingMessage(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return { id: 'local-1', content: '要不要一起吃个饭', status: 'sending', ...overrides }
}

function pendingMedia(overrides: Partial<PendingMedia> = {}): PendingMedia {
  const draft: PendingMediaDraft = {
    kind: 'IMAGE',
    path: '/tmp/a.png',
    clientRequestId: '0192f0a0-0000-7000-8000-000000000001',
    image: { mime: 'image/png', width: 800, height: 600, sizeBytes: 1_024 },
  }
  return { ...draft, id: 'local-2', uploaded: null, status: 'uploading', ...overrides }
}

describe('reviewStatusLabel —— 待审 / 被拒只对发送者可见', () => {
  test('我发出的待审与被拒各有稳定文案', () => {
    expect(reviewStatusLabel('PENDING_REVIEW', true)).toBe('审核中')
    expect(reviewStatusLabel('REJECTED', true)).toBe('未通过审核')
    expect(reviewStatusLabel('DELIVERED', true)).toBeNull()
  })

  test('接收者视角不给标签（这些行本来就不该下发）', () => {
    expect(reviewStatusLabel('PENDING_REVIEW', false)).toBeNull()
    expect(reviewStatusLabel('REJECTED', false)).toBeNull()
    expect(reviewStatusLabel('DELIVERED', false)).toBeNull()
  })

  test('撤回碑压过审核标签（撤回后正文已清空，不再挂待审 / 被拒）', () => {
    expect(reviewStatusLabel('PENDING_REVIEW', true, true)).toBeNull()
    expect(reviewStatusLabel('REJECTED', true, true)).toBeNull()
  })
})

describe('canRetry —— BLOCK 这类失败不给重试', () => {
  test('审核拦截：同一段内容重发必然再被拦，只能改了再发', () => {
    const blocked = pendingMessage({ status: 'failed', errorCode: 'MESSAGE_CONTENT_BLOCKED' })
    expect(canRetry(blocked)).toBe(false)
  })

  test('503 审核不可用 / 429 限流仍可重试', () => {
    expect(
      canRetry(pendingMessage({ status: 'failed', errorCode: 'CONTENT_MODERATION_UNAVAILABLE' })),
    ).toBe(true)
    expect(canRetry(pendingMessage({ status: 'failed', errorCode: 'MESSAGE_RATE_LIMITED' }))).toBe(
      true,
    )
    expect(canRetry(pendingMessage({ status: 'failed' }))).toBe(true)
  })

  test('还在发送中不算失败，不能重试', () => {
    expect(canRetry(pendingMessage({ status: 'sending' }))).toBe(false)
  })

  test('媒体同一个判据；重试时清掉上一轮的失败信息', () => {
    const blocked = pendingMedia({ status: 'failed', errorCode: 'MESSAGE_CONTENT_BLOCKED' })
    expect(canRetryMedia(blocked)).toBe(false)
    const retrying = startMediaRetry(
      pendingMedia({ status: 'failed', error: '内容被拦下了，请修改后重新发送' }),
    )
    expect(retrying.status).toBe('uploading')
    expect(retrying.error).toBeNull()
    expect(retrying.errorCode).toBeNull()
    expect(retrying.retryAfterAt).toBeNull()
  })
})

describe('sendFailureText —— 422 / 429 / 503 各给可操作说法', () => {
  test('拦下来说「修改后重新发送」，不劝用户原地重试', () => {
    expect(sendFailureText('MESSAGE_CONTENT_BLOCKED')).toBe('内容被拦下了，请修改后重新发送')
  })

  test('审核上游不可用说「稍后重试」', () => {
    expect(sendFailureText('CONTENT_MODERATION_UNAVAILABLE')).toBe('内容审核暂时不可用，请稍后重试')
  })

  test('三条路由的 429 码同一句「稍后重试」，秒数交给倒计时', () => {
    for (const code of [
      'MESSAGE_RATE_LIMITED',
      'MEDIA_RATE_LIMITED',
      'CONVERSATION_RATE_LIMITED',
    ]) {
      expect(sendFailureText(code)).toBe('发送太频繁，请稍后重试')
    }
  })

  test('没有专属文案的码返回 null，由调用方退回服务端说法', () => {
    expect(sendFailureText('SOMETHING_ELSE')).toBeNull()
    expect(sendFailureText(undefined)).toBeNull()
  })
})

describe('sendCooldownSeconds —— 429 倒计时', () => {
  test('按截止时间算出剩余秒数，向上取整', () => {
    expect(sendCooldownSeconds(30_000, 0)).toBe(30)
    expect(sendCooldownSeconds(30_000, 29_001)).toBe(1)
    expect(sendCooldownSeconds(30_000, 30_000)).toBe(0)
    expect(sendCooldownSeconds(30_000, 31_000)).toBe(0)
  })

  test('没有冷却（非 429）恒为 0', () => {
    expect(sendCooldownSeconds(null, 1_000)).toBe(0)
    expect(sendCooldownSeconds(undefined, 1_000)).toBe(0)
  })
})

/** 页面接线：文案与门禁必须来自 `view.ts`，不能在页面里另写一套。 */
async function pageSource(): Promise<string> {
  const code = await Bun.file(
    new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url),
  ).text()
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('会话页 · 审核态接线', () => {
  test('发送失败分支记下错误码与文案（不按出现次数断言，新增分支不该弄红）', async () => {
    const code = await pageSource()
    expect(code).toContain('error: sendFailureText(code),')
    expect(code).toContain('errorCode: code ?? null,')
  })

  test('接收者不渲染待审 / 被拒：文本与媒体两条分支都有兜底守卫', async () => {
    const code = await pageSource()
    expect(code).toContain("if (!mine && item.visibility !== 'DELIVERED') return null")
    expect(code).toContain("if (!mine && message.visibility !== 'DELIVERED') return null")
  })

  test('文本与媒体气泡都用同一套审核态判据，撤回碑传 recalled 置空', async () => {
    const code = await pageSource()
    expect(code).toContain('reviewStatusLabel(message.visibility, mine, recalled)')
    expect(code).toContain('reviewStatusLabel(item.visibility, mine)')
  })

  test('失败气泡都接「移除」出口（BLOCK 终态没有重试，文本不能只进不出）', async () => {
    const code = await pageSource()
    expect(code).toContain('onRemove={() => removePending(entry.pending.id)}')
    expect(code).toContain('onRemove={() => removePendingMedia(item.id)}')
    expect(code).toContain('<Text>移除</Text>')
  })

  test('失败气泡由 PendingFailFooter 统一渲染，重试入口过 canRetry 门禁', async () => {
    const code = await pageSource()
    expect(code).toContain('canRetry(entry.pending) ? () => retry(entry.pending) : undefined')
    expect(code).toContain('canRetryMedia(item) ? () => retryMedia(item) : undefined')
    // 冷却中的文案只来自同一个换算函数，页面不得自己算剩余秒数
    expect(code).toContain('sendCooldownSeconds(entry.pending.retryAfterAt, cooldownNow)')
    expect(code).toContain('sendCooldownSeconds(item.retryAfterAt, cooldownNow)')
  })
})
