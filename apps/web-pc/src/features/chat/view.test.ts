import { describe, expect, test } from 'bun:test'
import type { MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import {
  buildTimeline,
  excludeCachedMedia,
  excludeCachedMessages,
  formatMessageTime,
  systemMessageText,
} from './view'

function message(id: MessageDto['id']): MessageDto {
  return {
    id,
    conversationId: 'cnv_01jc000000e00800000000001a',
    senderId: 'usr_01jc000000e00800000000000a',
    sender: { id: 'usr_01jc000000e00800000000000a', nickname: '阿岚', avatarUrl: null },
    type: 'TEXT',
    content: id,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('chat view helpers', () => {
  test('maps transaction system events without leaking raw JSON', () => {
    expect(systemMessageText('{"type":"tx.proposal","amountCents":16000}')).toBe('交易确认待处理')
    expect(
      systemMessageText(
        '{"type":"tx.accepted","transactionId":"txn_01jc000000e00800000000004t","amountCents":2800}',
      ),
    ).toBe('交易已接受，待面交')
    expect(systemMessageText('{"type":"tx.rejected"}')).toBe('卖家已拒绝这次交易')
    expect(systemMessageText('{"type":"tx.proposal"}')).toBe('{"type":"tx.proposal"}')
    expect(systemMessageText('普通系统文本')).toBe('普通系统文本')
  })

  test('formats valid times and falls back for invalid input', () => {
    expect(formatMessageTime('2026-01-01T00:00:00.000Z')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatMessageTime('not-a-date')).toBe('')
  })

  test('drops local messages already present in history so ids render once', () => {
    const local = [
      message('msg_01jc000000e00800000000001v'),
      message('msg_01jc000000e00800000000001w'),
    ]
    const history = [
      message('msg_01jc000000e00800000000001w'),
      message('msg_01jc000000e00800000000001x'),
    ]

    expect(excludeCachedMessages(local, history).map((item) => item.id)).toEqual([
      'msg_01jc000000e00800000000001v',
    ])
    expect(excludeCachedMessages([], history)).toEqual([])
  })
})

function mediaMessage(
  id: MediaMessageDto['id'],
  createdAt: string,
  kind: MediaMessageDto['kind'] = 'IMAGE',
): MediaMessageDto {
  return {
    id,
    conversationId: 'cnv_01jc000000e00800000000001a',
    senderId: 'usr_01jc000000e00800000000000a',
    kind,
    mediaId: 'med_01jc000000e00800000000002a',
    url: `/api/conversations/cnv_01jc000000e00800000000001a/media/med_01jc000000e00800000000002a`,
    mimeType: kind === 'IMAGE' ? 'image/png' : 'audio/webm',
    sizeBytes: 1_024,
    width: kind === 'IMAGE' ? 800 : null,
    height: kind === 'IMAGE' ? 600 : null,
    durationMs: kind === 'VOICE' ? 1_500 : null,
    createdAt,
  }
}

function textMessage(id: MessageDto['id'], createdAt: string): MessageDto {
  return { ...message(id), createdAt }
}

describe('chat timeline merge', () => {
  test('归并文本与媒体为一条 (createdAt, id) 升序时间线', () => {
    const timeline = buildTimeline(
      [
        textMessage('msg_01jc000000e00800000000001v', '2026-01-01T00:00:02.000Z'),
        textMessage('msg_01jc000000e00800000000001y', '2026-01-01T00:00:04.000Z'),
      ],
      [
        mediaMessage('msg_01jc000000e00800000000001w', '2026-01-01T00:00:01.000Z'),
        mediaMessage('msg_01jc000000e00800000000001x', '2026-01-01T00:00:03.000Z', 'VOICE'),
      ],
    )

    expect(timeline.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'media:msg_01jc000000e00800000000001w',
      'message:msg_01jc000000e00800000000001v',
      'media:msg_01jc000000e00800000000001x',
      'message:msg_01jc000000e00800000000001y',
    ])
  })

  test('同一时刻按 id 定序，两类消息共用同一 id 空间', () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    // 文本拿较大的 id、媒体拿较小的 id：结果必须是 id 升序，而不是「文本先」。
    const text = textMessage('msg_01jc000000e00800000000001w', createdAt)
    const media = mediaMessage('msg_01jc000000e00800000000001v', createdAt)

    expect(buildTimeline([text], [media]).map((entry) => entry.id)).toEqual([
      'msg_01jc000000e00800000000001v',
      'msg_01jc000000e00800000000001w',
    ])
  })

  test('一侧为空时仍返回另一侧的升序结果', () => {
    const text = textMessage('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z')
    expect(buildTimeline([], [])).toEqual([])
    expect(buildTimeline([text], []).map((entry) => entry.kind)).toEqual(['message'])
    expect(buildTimeline([], [mediaMessage(text.id, text.createdAt)]).map((e) => e.kind)).toEqual([
      'media',
    ])
  })
})

describe('media history dedupe', () => {
  test('drops local media already present in history so ids render once', () => {
    const local = [
      mediaMessage('msg_01jc000000e00800000000001v', '2026-01-01T00:00:00.000Z'),
      mediaMessage('msg_01jc000000e00800000000001w', '2026-01-01T00:00:01.000Z'),
    ]
    const history = [mediaMessage('msg_01jc000000e00800000000001w', '2026-01-01T00:00:01.000Z')]

    expect(excludeCachedMedia(local, history).map((item) => item.id)).toEqual([
      'msg_01jc000000e00800000000001v',
    ])
    expect(excludeCachedMedia([], history)).toEqual([])
  })
})
